'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'galilea.db'));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS reservations (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    phone       TEXT NOT NULL,
    email       TEXT,
    date        TEXT NOT NULL,
    time        TEXT NOT NULL,
    people      INTEGER NOT NULL,
    notes       TEXT,
    status      TEXT NOT NULL DEFAULT 'pendiente',
    payment_ref TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_reservations_date ON reservations (date, time);
  CREATE INDEX IF NOT EXISTS idx_reservations_status ON reservations (status);

  -- Franjas que el administrador marcó como llenas. time = '*' bloquea el día completo.
  CREATE TABLE IF NOT EXISTS blocked_slots (
    date       TEXT NOT NULL,
    time       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (date, time)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const STATUSES = ['pendiente', 'confirmada', 'cancelada'];
// Estados que ocupan cupo en una franja.
const ACTIVE = "('pendiente', 'confirmada')";

// Horario por defecto: el administrador lo ajusta en Configuración.
// from = primera hora en que se puede reservar, to = última.
const DEFAULT_SETTINGS = {
  // WhatsApp de Plaza Galilea (315 233 7931), con indicativo 57.
  whatsapp: (process.env.WHATSAPP || '573152337931').replace(/\D/g, ''),
  publicUrl: '',
  slotMinutes: 30,
  minAdvanceMinutes: 60,
  maxDaysAhead: 30,
  maxPeople: 12,
  maxReservationsPerSlot: 0,
  hours: {
    0: { open: true, from: '12:00', to: '20:00' },
    1: { open: true, from: '12:00', to: '21:00' },
    2: { open: true, from: '12:00', to: '21:00' },
    3: { open: true, from: '12:00', to: '21:00' },
    4: { open: true, from: '12:00', to: '21:00' },
    5: { open: true, from: '12:00', to: '22:00' },
    6: { open: true, from: '12:00', to: '22:00' },
  },
};

const isoNow = () => new Date().toISOString();

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

function getSettings() {
  const saved = JSON.parse(getSetting('config') || '{}');
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    hours: { ...DEFAULT_SETTINGS.hours, ...(saved.hours || {}) },
  };
}

function saveSettings(cfg) {
  setSetting('config', JSON.stringify(cfg));
}

// Secreto para firmar sesiones del panel; se genera una vez y queda guardado.
function sessionSecret() {
  let secret = getSetting('session_secret');
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    setSetting('session_secret', secret);
  }
  return secret;
}

// --- Reservas -------------------------------------------------------------

// Sin 0/O ni 1/I para que el código se pueda dictar y escribir sin confusiones.
// 32 caracteres: 256 % 32 = 0, así que cada byte aleatorio cae parejo.
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;

function newCode() {
  for (;;) {
    let code = '';
    for (const b of crypto.randomBytes(CODE_LENGTH)) code += CODE_CHARS[b % CODE_CHARS.length];
    const id = 'GAL-' + code;
    if (!getReservation(id)) return id;
  }
}

function getReservation(id) {
  return db.prepare('SELECT * FROM reservations WHERE id = ?').get(id);
}

function createReservation({ name, phone, email, date, time, people, notes }) {
  const id = newCode();
  const ts = isoNow();
  db.prepare(`
    INSERT INTO reservations (id, name, phone, email, date, time, people, notes, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pendiente', ?, ?)
  `).run(id, name, phone, email || null, date, time, people, notes || null, ts, ts);
  return getReservation(id);
}

function findActiveByPhone(phone, date) {
  return db
    .prepare(`SELECT * FROM reservations WHERE phone = ? AND date = ? AND status IN ${ACTIVE} LIMIT 1`)
    .get(phone, date);
}

function updateReservation(id, { status, paymentRef }) {
  const current = getReservation(id);
  if (!current) return null;
  db.prepare('UPDATE reservations SET status = ?, payment_ref = ?, updated_at = ? WHERE id = ?').run(
    status ?? current.status,
    paymentRef !== undefined ? paymentRef || null : current.payment_ref,
    isoNow(),
    id
  );
  return getReservation(id);
}

function listReservations({ date, scope, status, q, today }) {
  const where = [];
  const params = [];
  let order = 'date ASC, time ASC, created_at ASC';

  if (q) {
    const like = `%${q}%`;
    const conds = ['id LIKE ?', 'name LIKE ?', 'email LIKE ?'];
    params.push(like, like, like);
    const digits = q.replace(/\D/g, '');
    if (digits.length >= 3) {
      conds.push('phone LIKE ?');
      params.push(`%${digits}%`);
    }
    where.push(`(${conds.join(' OR ')})`);
  }

  if (date) {
    where.push('date = ?');
    params.push(date);
  } else if (!q && scope === 'upcoming') {
    where.push('date >= ?');
    params.push(today);
  } else if (!q && scope === 'past') {
    where.push('date < ?');
    params.push(today);
    order = 'date DESC, time DESC';
  }

  if (status) {
    where.push('status = ?');
    params.push(status);
  }

  const sql = `SELECT * FROM reservations ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT 500`;
  return db.prepare(sql).all(...params);
}

function summary(today, weekEnd) {
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const pending = one(`SELECT COUNT(*) AS n FROM reservations WHERE status = 'pendiente' AND date >= ?`, today);
  const todayActive = one(
    `SELECT COUNT(*) AS n, COALESCE(SUM(people), 0) AS p FROM reservations WHERE date = ? AND status IN ${ACTIVE}`,
    today
  );
  const todayConfirmed = one(
    `SELECT COUNT(*) AS n, COALESCE(SUM(people), 0) AS p FROM reservations WHERE date = ? AND status = 'confirmada'`,
    today
  );
  const week = one(
    `SELECT COUNT(*) AS n, COALESCE(SUM(people), 0) AS p FROM reservations WHERE status = 'confirmada' AND date BETWEEN ? AND ?`,
    today,
    weekEnd
  );
  return {
    pendingUpcoming: pending.n,
    todayReservations: todayActive.n,
    todayPeople: todayActive.p,
    todayConfirmed: todayConfirmed.n,
    weekConfirmed: week.n,
    weekPeople: week.p,
  };
}

// --- Disponibilidad -------------------------------------------------------

function blockedTimes(date) {
  return new Set(db.prepare('SELECT time FROM blocked_slots WHERE date = ?').all(date).map((r) => r.time));
}

function setBlocked(date, time, blocked) {
  if (blocked) {
    db.prepare('INSERT OR IGNORE INTO blocked_slots (date, time, created_at) VALUES (?, ?, ?)').run(date, time, isoNow());
  } else {
    db.prepare('DELETE FROM blocked_slots WHERE date = ? AND time = ?').run(date, time);
  }
}

// Reservas activas y personas por franja en un día.
function slotLoad(date) {
  const rows = db
    .prepare(
      `SELECT time, COUNT(*) AS reservations, SUM(people) AS people
       FROM reservations WHERE date = ? AND status IN ${ACTIVE} GROUP BY time`
    )
    .all(date);
  return new Map(rows.map((r) => [r.time, { reservations: r.reservations, people: r.people }]));
}

module.exports = {
  STATUSES,
  DEFAULT_SETTINGS,
  getSettings,
  saveSettings,
  sessionSecret,
  getReservation,
  createReservation,
  findActiveByPhone,
  updateReservation,
  listReservations,
  summary,
  blockedTimes,
  setBlocked,
  slotLoad,
};

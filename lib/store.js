'use strict';

const crypto = require('node:crypto');
const { Pool } = require('pg');

const CONNECTION_STRING = process.env.DATABASE_URL;

// Si falta la variable, el fallo se lanza al atender la petición y NO al cargar
// el módulo. En serverless un error al cargar sale como un crash opaco
// ("FUNCTION_INVOCATION_FAILED") que no dice nada; así en cambio llega al
// manejador de errores y el navegador muestra qué falta.
function missingUrlError() {
  const err = new Error(
    'Falta la variable DATABASE_URL. Defínela en el panel del hosting ' +
      '(en Vercel: Settings → Environment Variables) y vuelve a desplegar, ' +
      'porque las variables nuevas no se aplican al despliegue que ya existe.'
  );
  err.code = 'CONFIG';
  return err;
}

// Una sola pool por instancia del proceso. En serverless cada instancia la
// reutiliza entre invocaciones, por eso vive en el módulo y no por petición.
// Una sola conexión por defecto: es lo que recomienda Supabase para serverless,
// porque muchas instancias comparten el cupo del pooler. En un servidor
// permanente y único se puede subir con PG_POOL_MAX.
const pool = CONNECTION_STRING
  ? new Pool({
      connectionString: CONNECTION_STRING,
      // Supabase exige TLS. No verificamos la cadena del certificado porque su
      // CA no viene en el almacén de Node; el tráfico va cifrado igual.
      ssl: { rejectUnauthorized: false },
      max: Number(process.env.PG_POOL_MAX) || 1,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 15_000,
    })
  : null;

if (pool) pool.on('error', (err) => console.error('Error en la pool de Postgres:', err));

// Las fechas y horas se guardan como TEXT ('2026-10-31', '20:00') igual que en
// la versión con SQLite: en formato ISO el orden alfabético es el cronológico,
// así que todas las comparaciones del código siguen funcionando igual.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS reservations (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    phone       TEXT NOT NULL,
    email       TEXT,
    "date"      TEXT NOT NULL,
    "time"      TEXT NOT NULL,
    people      INTEGER NOT NULL,
    notes       TEXT,
    status      TEXT NOT NULL DEFAULT 'pendiente',
    payment_ref TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_reservations_date ON reservations ("date", "time");
  CREATE INDEX IF NOT EXISTS idx_reservations_status ON reservations (status);

  -- Franjas que el administrador marcó como llenas. time = '*' bloquea el día completo.
  CREATE TABLE IF NOT EXISTS blocked_slots (
    "date"     TEXT NOT NULL,
    "time"     TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY ("date", "time")
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

// Un mismo celular no puede tener dos reservas activas el mismo día. La regla
// también se comprueba en la aplicación, pero aquí queda garantizada aunque
// dos peticiones entren a la vez.
const UNIQUE_ACTIVE_PHONE = `
  CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_phone_date
    ON reservations (phone, "date")
    WHERE status IN ('pendiente', 'confirmada');
`;

let ready = null;

async function init() {
  if (!pool) throw missingUrlError();
  if (!ready) {
    ready = (async () => {
      await pool.query(SCHEMA);
      try {
        await pool.query(UNIQUE_ACTIVE_PHONE);
      } catch (err) {
        // Si la base ya trae duplicados, el índice no se puede crear. No es
        // motivo para tumbar la app: la comprobación en código sigue activa.
        console.warn('No se pudo crear uniq_active_phone_date:', err.message);
      }
    })().catch((err) => {
      ready = null; // Que el próximo intento lo vuelva a probar.
      throw err;
    });
  }
  return ready;
}

// Todas las consultas pasan por aquí. `client` solo se pasa desde dentro de una
// transacción; el resto usa la pool.
async function q(text, params, client) {
  if (client) return client.query(text, params);
  await init();
  return pool.query(text, params);
}

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
const int = (v) => Number(v) || 0;

async function getSetting(key, client) {
  const { rows } = await q('SELECT value FROM settings WHERE key = $1', [key], client);
  return rows.length ? rows[0].value : null;
}

async function setSetting(key, value, client) {
  await q(
    'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, value],
    client
  );
}

async function getSettings(client) {
  const saved = JSON.parse((await getSetting('config', client)) || '{}');
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    hours: { ...DEFAULT_SETTINGS.hours, ...(saved.hours || {}) },
  };
}

async function saveSettings(cfg) {
  await setSetting('config', JSON.stringify(cfg));
}

// Secreto para firmar sesiones del panel. Vive en la base, no en memoria, para
// que todas las instancias serverless firmen igual y los tokens emitidos por
// una valgan en las demás.
async function sessionSecret() {
  const existing = await getSetting('session_secret');
  if (existing) return existing;

  const secret = crypto.randomBytes(32).toString('hex');
  // Si dos instancias arrancan a la vez, gana la primera y la otra lee el suyo.
  const { rows } = await q(
    `INSERT INTO settings (key, value) VALUES ('session_secret', $1)
     ON CONFLICT (key) DO UPDATE SET value = settings.value
     RETURNING value`,
    [secret]
  );
  return rows[0].value;
}

// --- Reservas -------------------------------------------------------------

// Sin 0/O ni 1/I para que el código se pueda dictar y escribir sin confusiones.
// 32 caracteres: 256 % 32 = 0, así que cada byte aleatorio cae parejo.
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;

async function newCode(client) {
  for (;;) {
    let code = '';
    for (const b of crypto.randomBytes(CODE_LENGTH)) code += CODE_CHARS[b % CODE_CHARS.length];
    const id = 'GAL-' + code;
    if (!(await getReservation(id, client))) return id;
  }
}

async function getReservation(id, client) {
  const { rows } = await q('SELECT * FROM reservations WHERE id = $1', [id], client);
  return rows[0] || null;
}

async function createReservation({ name, phone, email, date, time, people, notes }, client) {
  const id = await newCode(client);
  const ts = isoNow();
  await q(
    `INSERT INTO reservations (id, name, phone, email, "date", "time", people, notes, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pendiente', $9, $10)`,
    [id, name, phone, email || null, date, time, people, notes || null, ts, ts],
    client
  );
  return getReservation(id, client);
}

async function findActiveByPhone(phone, date, client) {
  const { rows } = await q(
    `SELECT * FROM reservations WHERE phone = $1 AND "date" = $2 AND status IN ${ACTIVE} LIMIT 1`,
    [phone, date],
    client
  );
  return rows[0] || null;
}

async function updateReservation(id, { status, paymentRef }) {
  const current = await getReservation(id);
  if (!current) return null;
  await q(
    'UPDATE reservations SET status = $1, payment_ref = $2, updated_at = $3 WHERE id = $4',
    [
      status ?? current.status,
      paymentRef !== undefined ? paymentRef || null : current.payment_ref,
      isoNow(),
      id,
    ]
  );
  return getReservation(id);
}

async function listReservations({ date, scope, status, q: search, today }) {
  const where = [];
  const params = [];
  let order = '"date" ASC, "time" ASC, created_at ASC';
  const p = (value) => {
    params.push(value);
    return '$' + params.length;
  };

  if (search) {
    const like = `%${search}%`;
    // ILIKE para que la búsqueda no distinga mayúsculas, como hacía SQLite.
    const conds = [`id ILIKE ${p(like)}`, `name ILIKE ${p(like)}`, `email ILIKE ${p(like)}`];
    const digits = search.replace(/\D/g, '');
    if (digits.length >= 3) conds.push(`phone LIKE ${p(`%${digits}%`)}`);
    where.push(`(${conds.join(' OR ')})`);
  }

  if (date) {
    where.push(`"date" = ${p(date)}`);
  } else if (!search && scope === 'upcoming') {
    where.push(`"date" >= ${p(today)}`);
  } else if (!search && scope === 'past') {
    where.push(`"date" < ${p(today)}`);
    order = '"date" DESC, "time" DESC';
  }

  if (status) where.push(`status = ${p(status)}`);

  const sql = `SELECT * FROM reservations ${
    where.length ? 'WHERE ' + where.join(' AND ') : ''
  } ORDER BY ${order} LIMIT 500`;
  const { rows } = await q(sql, params);
  return rows;
}

async function summary(today, weekEnd) {
  // COUNT y SUM vuelven como texto en Postgres (son bigint/numeric): int() los
  // pasa a número para que el panel no muestre "12" concatenado.
  const one = async (sql, params) => (await q(sql, params)).rows[0];

  const [pending, todayActive, todayConfirmed, week] = await Promise.all([
    one(`SELECT COUNT(*) AS n FROM reservations WHERE status = 'pendiente' AND "date" >= $1`, [today]),
    one(
      `SELECT COUNT(*) AS n, COALESCE(SUM(people), 0) AS p
       FROM reservations WHERE "date" = $1 AND status IN ${ACTIVE}`,
      [today]
    ),
    one(
      `SELECT COUNT(*) AS n, COALESCE(SUM(people), 0) AS p
       FROM reservations WHERE "date" = $1 AND status = 'confirmada'`,
      [today]
    ),
    one(
      `SELECT COUNT(*) AS n, COALESCE(SUM(people), 0) AS p
       FROM reservations WHERE status = 'confirmada' AND "date" BETWEEN $1 AND $2`,
      [today, weekEnd]
    ),
  ]);

  return {
    pendingUpcoming: int(pending.n),
    todayReservations: int(todayActive.n),
    todayPeople: int(todayActive.p),
    todayConfirmed: int(todayConfirmed.n),
    weekConfirmed: int(week.n),
    weekPeople: int(week.p),
  };
}

// --- Disponibilidad -------------------------------------------------------

async function blockedTimes(date, client) {
  const { rows } = await q('SELECT "time" FROM blocked_slots WHERE "date" = $1', [date], client);
  return new Set(rows.map((r) => r.time));
}

async function setBlocked(date, time, blocked) {
  if (blocked) {
    await q(
      'INSERT INTO blocked_slots ("date", "time", created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [date, time, isoNow()]
    );
  } else {
    await q('DELETE FROM blocked_slots WHERE "date" = $1 AND "time" = $2', [date, time]);
  }
}

// Reservas activas y personas por franja en un día.
async function slotLoad(date, client) {
  const { rows } = await q(
    `SELECT "time", COUNT(*) AS reservations, COALESCE(SUM(people), 0) AS people
     FROM reservations WHERE "date" = $1 AND status IN ${ACTIVE} GROUP BY "time"`,
    [date],
    client
  );
  return new Map(rows.map((r) => [r.time, { reservations: int(r.reservations), people: int(r.people) }]));
}

/**
 * Ejecuta fn dentro de una transacción que tiene tomado el cerrojo de ese día.
 * Con SQLite el proceso era síncrono y entre comprobar el cupo e insertar no se
 * colaba nadie; con Postgres sí podría, así que las reservas de un mismo día se
 * serializan aquí. Es por día, de modo que dos días distintos no se estorban.
 */
async function withDayLock(date, fn) {
  await init();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [date]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Código del error de unicidad en Postgres: lo lanza uniq_active_phone_date
// cuando dos peticiones del mismo celular entran a la vez.
const UNIQUE_VIOLATION = '23505';

module.exports = {
  STATUSES,
  DEFAULT_SETTINGS,
  UNIQUE_VIOLATION,
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
  withDayLock,
  pool,
};

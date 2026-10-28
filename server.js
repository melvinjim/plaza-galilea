'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const QRCode = require('qrcode');

const store = require('./lib/store');
const { dayAvailability } = require('./lib/availability');
const { now, isDate, isTime, addDays } = require('./lib/time');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'galilea2026';
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const INSTAGRAM = 'galilea.plaza_';

if (!process.env.ADMIN_PASSWORD) {
  console.warn('⚠  ADMIN_PASSWORD no está definida: usando la contraseña por defecto "galilea2026".');
}

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// --- Utilidades -----------------------------------------------------------

const clean = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);

// Acepta "gal-7k3qh", "GAL 7K3QH" o solo "7K3QH".
function normalizeCode(input) {
  let c = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (c.length === 8 && c.startsWith('GAL')) c = c.slice(3);
  return 'GAL-' + c;
}

// Lo que ve el cliente: sin teléfono, correo ni notas.
function publicView(r) {
  return {
    id: r.id,
    status: r.status,
    date: r.date,
    time: r.time,
    people: r.people,
    name: r.name.split(' ')[0],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function adminView(r) {
  return {
    id: r.id,
    status: r.status,
    date: r.date,
    time: r.time,
    people: r.people,
    name: r.name,
    phone: r.phone,
    email: r.email,
    notes: r.notes,
    paymentRef: r.payment_ref,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function baseUrl(req) {
  return store.getSettings().publicUrl || `${req.protocol}://${req.get('host')}`;
}

// --- API pública ----------------------------------------------------------

app.get('/api/config', (req, res) => {
  const cfg = store.getSettings();
  res.json({
    today: now().date,
    whatsapp: cfg.whatsapp,
    instagram: INSTAGRAM,
    maxPeople: cfg.maxPeople,
    maxDaysAhead: cfg.maxDaysAhead,
  });
});

app.get('/api/availability', (req, res) => {
  const { date } = req.query;
  if (!isDate(date)) return res.status(400).json({ error: 'Fecha no válida.' });
  const day = dayAvailability(date);
  res.json({
    date,
    inRange: day.inRange,
    openDay: day.openDay,
    dayBlocked: day.dayBlocked,
    slots: day.slots
      .filter((s) => s.reason !== 'pasado')
      .map((s) => ({ time: s.time, available: s.available })),
  });
});

app.post('/api/reservations', (req, res) => {
  const b = req.body || {};
  const bad = (error) => res.status(400).json({ error });

  // Campo trampa: los humanos no lo ven, los bots lo llenan.
  if (b.website) return bad('Solicitud no válida.');

  const cfg = store.getSettings();
  const name = clean(b.name, 80);
  const phone = String(b.phone ?? '').replace(/\D/g, '');
  const email = clean(b.email, 120);
  const notes = clean(b.notes, 300);
  const people = Number.parseInt(b.people, 10);
  const { date, time } = b;

  if (name.length < 2) return bad('Escribe tu nombre.');
  if (phone.length < 7 || phone.length > 15) return bad('Escribe un número de celular válido.');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad('El correo no es válido.');
  if (!Number.isInteger(people) || people < 1) return bad('Indica cuántas personas vienen.');
  if (people > cfg.maxPeople) {
    return bad(`Para grupos de más de ${cfg.maxPeople} personas escríbenos directamente por WhatsApp.`);
  }
  if (!isDate(date) || !isTime(time)) return bad('Elige una fecha y una hora.');

  // node:sqlite es síncrono: entre esta verificación y el INSERT no se cuela otra petición.
  const slot = dayAvailability(date).slots.find((s) => s.time === time);
  if (!slot || !slot.available) {
    return res.status(409).json({ error: 'Ese horario ya no está disponible. Elige otro, por favor.', code: 'slot' });
  }
  const dup = store.findActiveByPhone(phone, date);
  if (dup) {
    return res.status(409).json({
      error: `Ya tienes una reserva para ese día con el código ${dup.id}.`,
      code: 'duplicate',
      id: dup.id,
    });
  }

  const r = store.createReservation({ name, phone, email, date, time, people, notes });
  console.log(`Nueva reserva ${r.id}: ${r.date} ${r.time}, ${r.people} pers.`);
  res.status(201).json(publicView(r));
});

app.get('/api/reservations/:id', (req, res) => {
  const r = store.getReservation(normalizeCode(req.params.id));
  if (!r) return res.status(404).json({ error: 'No encontramos una reserva con ese código.' });
  res.json(publicView(r));
});

// QR del menú. Con ?mesa=N el menú muestra el número de mesa.
app.get('/qr/menu.:ext', async (req, res) => {
  const mesa = Number.parseInt(req.query.mesa, 10);
  const url = baseUrl(req) + '/menu' + (mesa > 0 && mesa < 1000 ? `?mesa=${mesa}` : '');
  const opts = { margin: 1, errorCorrectionLevel: 'M', color: { dark: '#2A1E18', light: '#FFFFFF' } };

  if (req.params.ext === 'svg') {
    return res.type('image/svg+xml').send(await QRCode.toString(url, { ...opts, type: 'svg' }));
  }
  if (req.params.ext === 'png') {
    if (req.query.download) res.attachment(mesa > 0 ? `menu-galilea-mesa-${mesa}.png` : 'menu-galilea-qr.png');
    return res.type('png').send(await QRCode.toBuffer(url, { ...opts, width: 1024 }));
  }
  res.sendStatus(404);
});

// --- Autenticación del panel ----------------------------------------------

const SECRET = store.sessionSecret();
// La contraseña entra en la firma: si se cambia ADMIN_PASSWORD, las sesiones abiertas caducan.
const sign = (payload) => crypto.createHmac('sha256', SECRET + ADMIN_PASSWORD).update(payload).digest('base64url');

function issueToken() {
  const exp = String(Date.now() + TOKEN_TTL_MS);
  return `${exp}.${sign(exp)}`;
}

function validToken(token) {
  const [exp, sig] = String(token || '').split('.');
  if (!exp || !sig) return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b) && Number(exp) > Date.now();
}

function sameSecret(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Máximo 10 intentos fallidos por IP cada 15 minutos.
const loginFailures = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

app.post('/api/admin/login', (req, res) => {
  const ip = req.ip;
  const entry = loginFailures.get(ip);
  if (entry && entry.count >= 10 && Date.now() - entry.first < LOGIN_WINDOW_MS) {
    return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });
  }
  if (!sameSecret(req.body?.password ?? '', ADMIN_PASSWORD)) {
    const fresh = !entry || Date.now() - entry.first >= LOGIN_WINDOW_MS;
    loginFailures.set(ip, fresh ? { count: 1, first: Date.now() } : { ...entry, count: entry.count + 1 });
    return res.status(401).json({ error: 'Contraseña incorrecta.' });
  }
  loginFailures.delete(ip);
  res.json({ token: issueToken() });
});

// --- API del panel --------------------------------------------------------

const admin = express.Router();

admin.use((req, res, next) => {
  const header = req.get('authorization') || '';
  if (!validToken(header.startsWith('Bearer ') ? header.slice(7) : '')) {
    return res.status(401).json({ error: 'Tu sesión expiró. Ingresa de nuevo.' });
  }
  next();
});

admin.get('/summary', (req, res) => {
  const today = now().date;
  res.json({ today, ...store.summary(today, addDays(today, 6)) });
});

admin.get('/reservations', (req, res) => {
  const { date, scope = 'upcoming', status, q } = req.query;
  if (date && !isDate(date)) return res.status(400).json({ error: 'Fecha no válida.' });
  if (status && !store.STATUSES.includes(status)) return res.status(400).json({ error: 'Estado no válido.' });
  const list = store.listReservations({
    date: date || null,
    scope,
    status: status || null,
    q: clean(q, 60),
    today: now().date,
  });
  res.json(list.map(adminView));
});

admin.patch('/reservations/:id', (req, res) => {
  const { status, paymentRef } = req.body || {};
  if (status !== undefined && !store.STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Estado no válido.' });
  }
  const r = store.updateReservation(normalizeCode(req.params.id), {
    status,
    paymentRef: paymentRef === undefined ? undefined : clean(paymentRef, 120),
  });
  if (!r) return res.status(404).json({ error: 'Reserva no encontrada.' });
  res.json(adminView(r));
});

admin.get('/availability', (req, res) => {
  const { date } = req.query;
  if (!isDate(date)) return res.status(400).json({ error: 'Fecha no válida.' });
  res.json(dayAvailability(date, { includeExtra: true }));
});

// { date, time: 'HH:MM' | '*', blocked: boolean }
admin.put('/blocks', (req, res) => {
  const { date, time, blocked } = req.body || {};
  if (!isDate(date) || !(time === '*' || isTime(time))) {
    return res.status(400).json({ error: 'Fecha u hora no válida.' });
  }
  store.setBlocked(date, time, Boolean(blocked));
  res.json(dayAvailability(date, { includeExtra: true }));
});

admin.get('/settings', (req, res) => {
  res.json({ settings: store.getSettings(), menuUrl: baseUrl(req) + '/menu' });
});

admin.put('/settings', (req, res) => {
  const b = req.body || {};
  const cfg = store.getSettings();
  const int = (v, min, max, label) => {
    const n = Number.parseInt(v, 10);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label}: debe estar entre ${min} y ${max}.`);
    return n;
  };

  try {
    if ('whatsapp' in b) cfg.whatsapp = String(b.whatsapp || '').replace(/\D/g, '').slice(0, 15);
    if ('publicUrl' in b) {
      const url = String(b.publicUrl || '').trim().replace(/\/+$/, '');
      if (url && !/^https?:\/\/[^\s/]+(\/\S*)?$/i.test(url)) throw new Error('La URL pública no es válida.');
      cfg.publicUrl = url;
    }
    if ('slotMinutes' in b) cfg.slotMinutes = int(b.slotMinutes, 10, 240, 'Intervalo entre horas');
    if ('minAdvanceMinutes' in b) cfg.minAdvanceMinutes = int(b.minAdvanceMinutes, 0, 2880, 'Anticipación mínima');
    if ('maxDaysAhead' in b) cfg.maxDaysAhead = int(b.maxDaysAhead, 1, 365, 'Días a futuro');
    if ('maxPeople' in b) cfg.maxPeople = int(b.maxPeople, 1, 200, 'Máximo de personas');
    if ('maxReservationsPerSlot' in b) {
      cfg.maxReservationsPerSlot = int(b.maxReservationsPerSlot, 0, 500, 'Reservas por franja');
    }
    if (b.hours && typeof b.hours === 'object') {
      const hours = {};
      for (let d = 0; d <= 6; d++) {
        const h = b.hours[d] || b.hours[String(d)] || {};
        const open = Boolean(h.open);
        if (open && (!isTime(h.from) || !isTime(h.to) || h.from > h.to)) {
          throw new Error('Revisa el horario: la primera hora debe ser anterior a la última.');
        }
        hours[d] = { open, from: isTime(h.from) ? h.from : '12:00', to: isTime(h.to) ? h.to : '21:00' };
      }
      cfg.hours = hours;
    }
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  store.saveSettings(cfg);
  res.json({ settings: cfg, menuUrl: baseUrl(req) + '/menu' });
});

app.use('/api/admin', admin);

// --- Errores --------------------------------------------------------------

app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Solicitud no válida.' });
  console.error(err);
  res.status(500).json({ error: 'Ocurrió un error en el servidor.' });
});

app.listen(PORT, () => {
  console.log(`Plaza Galilea lista en http://localhost:${PORT}`);
  console.log(`Panel administrativo: http://localhost:${PORT}/admin`);
});

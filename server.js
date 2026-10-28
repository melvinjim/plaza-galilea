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

async function baseUrl(req, cfg) {
  const settings = cfg || (await store.getSettings());
  return settings.publicUrl || `${req.protocol}://${req.get('host')}`;
}

// --- API pública ----------------------------------------------------------

app.get('/api/config', async (req, res) => {
  const cfg = await store.getSettings();
  res.json({
    today: now().date,
    whatsapp: cfg.whatsapp,
    instagram: INSTAGRAM,
    maxPeople: cfg.maxPeople,
    maxDaysAhead: cfg.maxDaysAhead,
  });
});

app.get('/api/availability', async (req, res) => {
  const { date } = req.query;
  if (!isDate(date)) return res.status(400).json({ error: 'Fecha no válida.' });
  const day = await dayAvailability(date);
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

app.post('/api/reservations', async (req, res) => {
  const b = req.body || {};
  const bad = (error) => res.status(400).json({ error });

  // Campo trampa: los humanos no lo ven, los bots lo llenan.
  if (b.website) return bad('Solicitud no válida.');

  const cfg = await store.getSettings();
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

  const duplicate = (id) => ({
    error: `Ya tienes una reserva para ese día con el código ${id}.`,
    code: 'duplicate',
    id,
  });

  // Comprobar el cupo, comprobar el duplicado e insertar tienen que ser una
  // sola operación: con la base remota, entre un paso y otro sí puede colarse
  // otra petición. El cerrojo del día las pone en fila.
  let outcome;
  try {
    outcome = await store.withDayLock(date, async (client) => {
      const day = await dayAvailability(date, { client });
      const slot = day.slots.find((s) => s.time === time);
      if (!slot || !slot.available) {
        return { conflict: { error: 'Ese horario ya no está disponible. Elige otro, por favor.', code: 'slot' } };
      }
      const dup = await store.findActiveByPhone(phone, date, client);
      if (dup) return { conflict: duplicate(dup.id) };
      return { reservation: await store.createReservation({ name, phone, email, date, time, people, notes }, client) };
    });
  } catch (err) {
    // Red de seguridad por si el índice único salta antes que la comprobación.
    if (err.code === store.UNIQUE_VIOLATION) {
      const dup = await store.findActiveByPhone(phone, date);
      return res.status(409).json(duplicate(dup ? dup.id : ''));
    }
    throw err;
  }

  if (outcome.conflict) return res.status(409).json(outcome.conflict);

  const r = outcome.reservation;
  console.log(`Nueva reserva ${r.id}: ${r.date} ${r.time}, ${r.people} pers.`);
  res.status(201).json(publicView(r));
});

app.get('/api/reservations/:id', async (req, res) => {
  const r = await store.getReservation(normalizeCode(req.params.id));
  if (!r) return res.status(404).json({ error: 'No encontramos una reserva con ese código.' });
  res.json(publicView(r));
});

// QR del menú. Con ?mesa=N el menú muestra el número de mesa.
app.get('/qr/menu.:ext', async (req, res) => {
  const mesa = Number.parseInt(req.query.mesa, 10);
  const url = (await baseUrl(req)) + '/menu' + (mesa > 0 && mesa < 1000 ? `?mesa=${mesa}` : '');
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

// El secreto vive en la base y se cachea por instancia: así no se consulta en
// cada petición, pero todas las instancias firman igual y un token emitido por
// una vale en las demás. Se guarda la promesa para que dos peticiones a la vez
// no disparen dos lecturas.
let secretPromise = null;
function sessionSecret() {
  if (!secretPromise) {
    secretPromise = store.sessionSecret().catch((err) => {
      secretPromise = null;
      throw err;
    });
  }
  return secretPromise;
}

// La contraseña entra en la firma: si se cambia ADMIN_PASSWORD, las sesiones abiertas caducan.
const sign = async (payload) =>
  crypto.createHmac('sha256', (await sessionSecret()) + ADMIN_PASSWORD).update(payload).digest('base64url');

async function issueToken() {
  const exp = String(Date.now() + TOKEN_TTL_MS);
  return `${exp}.${await sign(exp)}`;
}

async function validToken(token) {
  const [exp, sig] = String(token || '').split('.');
  if (!exp || !sig) return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(await sign(exp));
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

app.post('/api/admin/login', async (req, res) => {
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
  res.json({ token: await issueToken() });
});

// --- API del panel --------------------------------------------------------

const admin = express.Router();

admin.use(async (req, res, next) => {
  const header = req.get('authorization') || '';
  if (!(await validToken(header.startsWith('Bearer ') ? header.slice(7) : ''))) {
    return res.status(401).json({ error: 'Tu sesión expiró. Ingresa de nuevo.' });
  }
  next();
});

admin.get('/summary', async (req, res) => {
  const today = now().date;
  res.json({ today, ...(await store.summary(today, addDays(today, 6))) });
});

admin.get('/reservations', async (req, res) => {
  const { date, scope = 'upcoming', status, q } = req.query;
  if (date && !isDate(date)) return res.status(400).json({ error: 'Fecha no válida.' });
  if (status && !store.STATUSES.includes(status)) return res.status(400).json({ error: 'Estado no válido.' });
  const list = await store.listReservations({
    date: date || null,
    scope,
    status: status || null,
    q: clean(q, 60),
    today: now().date,
  });
  res.json(list.map(adminView));
});

admin.patch('/reservations/:id', async (req, res) => {
  const { status, paymentRef } = req.body || {};
  if (status !== undefined && !store.STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Estado no válido.' });
  }
  const r = await store.updateReservation(normalizeCode(req.params.id), {
    status,
    paymentRef: paymentRef === undefined ? undefined : clean(paymentRef, 120),
  });
  if (!r) return res.status(404).json({ error: 'Reserva no encontrada.' });
  res.json(adminView(r));
});

admin.get('/availability', async (req, res) => {
  const { date } = req.query;
  if (!isDate(date)) return res.status(400).json({ error: 'Fecha no válida.' });
  res.json(await dayAvailability(date, { includeExtra: true }));
});

// { date, time: 'HH:MM' | '*', blocked: boolean }
admin.put('/blocks', async (req, res) => {
  const { date, time, blocked } = req.body || {};
  if (!isDate(date) || !(time === '*' || isTime(time))) {
    return res.status(400).json({ error: 'Fecha u hora no válida.' });
  }
  await store.setBlocked(date, time, Boolean(blocked));
  res.json(await dayAvailability(date, { includeExtra: true }));
});

admin.get('/settings', async (req, res) => {
  const settings = await store.getSettings();
  res.json({ settings, menuUrl: (await baseUrl(req, settings)) + '/menu' });
});

admin.put('/settings', async (req, res) => {
  const b = req.body || {};
  const cfg = await store.getSettings();
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

  await store.saveSettings(cfg);
  res.json({ settings: cfg, menuUrl: (await baseUrl(req, cfg)) + '/menu' });
});

app.use('/api/admin', admin);

// --- Errores --------------------------------------------------------------

app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Solicitud no válida.' });
  console.error(err);
  res.status(500).json({ error: 'Ocurrió un error en el servidor.' });
});

// En local (`npm start`) levanta el servidor. En Vercel no: allí el módulo se
// importa desde api/index.js y es la plataforma quien atiende las peticiones.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Plaza Galilea lista en http://localhost:${PORT}`);
    console.log(`Panel administrativo: http://localhost:${PORT}/admin`);
  });
}

module.exports = app;

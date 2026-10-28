'use strict';

// Colombia (America/Bogota) es UTC-5 todo el año, sin horario de verano.
const OFFSET_MS = -5 * 60 * 60 * 1000;

function now() {
  const d = new Date(Date.now() + OFFSET_MS);
  return {
    date: d.toISOString().slice(0, 10),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}

function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function isTime(s) {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

function toMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function fromMinutes(n) {
  return String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');
}

function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// 0 = domingo … 6 = sábado
function weekday(date) {
  return new Date(date + 'T00:00:00Z').getUTCDay();
}

module.exports = { now, isDate, isTime, toMinutes, fromMinutes, addDays, weekday };

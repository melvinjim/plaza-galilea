'use strict';

const store = require('./store');
const { now, isTime, toMinutes, fromMinutes, addDays, weekday } = require('./time');

// Horas en las que se puede reservar ese día según el horario semanal.
function scheduleTimes(date, cfg) {
  const day = cfg.hours[weekday(date)];
  if (!day || !day.open || !isTime(day.from) || !isTime(day.to)) return [];
  const step = Math.max(10, Number(cfg.slotMinutes) || 30);
  const times = [];
  for (let m = toMinutes(day.from); m <= toMinutes(day.to); m += step) times.push(fromMinutes(m));
  return times;
}

/**
 * Estado de cada franja de un día.
 * reason = null si se puede reservar; si no:
 *   'fuera_horario' | 'fuera_rango' | 'pasado' | 'bloqueado' | 'cupo_completo'
 * Con includeExtra también aparecen horas fuera del horario que tengan reservas
 * o bloqueos (útil en el panel si se cambió el horario después).
 * `client` solo llega desde dentro de la transacción que crea una reserva, para
 * que el cupo se lea con el cerrojo del día ya tomado.
 */
async function dayAvailability(date, { includeExtra = false, client } = {}) {
  const [cfg, blocked, load] = await Promise.all([
    store.getSettings(client),
    store.blockedTimes(date, client),
    store.slotLoad(date, client),
  ]);
  const today = now();
  const inRange = date >= today.date && date <= addDays(today.date, cfg.maxDaysAhead);
  const dayBlocked = blocked.has('*');

  const scheduled = scheduleTimes(date, cfg);
  const scheduledSet = new Set(scheduled);
  let times = scheduled;
  if (includeExtra) {
    const extra = [...load.keys(), ...blocked].filter((t) => t !== '*');
    times = [...new Set([...scheduled, ...extra])].sort();
  }

  const slots = times.map((time) => {
    const l = load.get(time) || { reservations: 0, people: 0 };
    let reason = null;
    if (!scheduledSet.has(time)) reason = 'fuera_horario';
    else if (!inRange) reason = 'fuera_rango';
    else if (date === today.date && toMinutes(time) < today.minutes + cfg.minAdvanceMinutes) reason = 'pasado';
    else if (dayBlocked || blocked.has(time)) reason = 'bloqueado';
    else if (cfg.maxReservationsPerSlot > 0 && l.reservations >= cfg.maxReservationsPerSlot) reason = 'cupo_completo';
    return { time, available: reason === null, reason, blocked: blocked.has(time), ...l };
  });

  return { date, inRange, dayBlocked, openDay: scheduled.length > 0, slots };
}

module.exports = { dayAvailability };

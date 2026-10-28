(() => {
  const G = Galilea;
  const $ = (id) => document.getElementById(id);
  const CHIP_DAYS = 14;

  const state = { config: null, date: null, time: null, people: 2, loadSeq: 0 };

  async function init() {
    try {
      state.config = await G.api('/api/config');
    } catch {
      $('slots').innerHTML = '<div class="slots-empty">No pudimos cargar la disponibilidad. Recarga la página.</div>';
      return;
    }
    const { today, maxDaysAhead } = state.config;
    $('other-date').min = today;
    $('other-date').max = G.addDays(today, maxDaysAhead);
    renderDateChips();
    updatePeople();
    selectDate(today);
  }

  // --- Fecha ---------------------------------------------------------------

  function renderDateChips() {
    const { today, maxDaysAhead } = state.config;
    const fmt = (opts, d) =>
      new Intl.DateTimeFormat('es-CO', { ...opts, timeZone: 'UTC' }).format(d).replace('.', '');
    const chips = [];
    for (let i = 0; i < Math.min(CHIP_DAYS, maxDaysAhead + 1); i++) {
      const date = G.addDays(today, i);
      const d = new Date(date + 'T12:00:00Z');
      const dow = i === 0 ? 'Hoy' : i === 1 ? 'Mañana' : fmt({ weekday: 'short' }, d);
      chips.push(
        `<button type="button" class="date-chip" data-date="${date}" aria-pressed="false">` +
          `<span class="dow">${dow}</span><span class="day">${d.getUTCDate()}</span>` +
          `<span class="mon">${fmt({ month: 'short' }, d)}</span></button>`
      );
    }
    $('date-strip').innerHTML = chips.join('');
  }

  function selectDate(date) {
    state.date = date;
    state.time = null;
    document.querySelectorAll('.date-chip').forEach((c) => {
      c.setAttribute('aria-pressed', String(c.dataset.date === date));
    });
    $('other-date').value = date;
    hideError();
    updateSummary();
    loadSlots();
  }

  $('date-strip').addEventListener('click', (e) => {
    const chip = e.target.closest('.date-chip');
    if (chip) selectDate(chip.dataset.date);
  });

  $('other-date').addEventListener('change', (e) => {
    const v = e.target.value;
    if (v && v >= e.target.min && v <= e.target.max) {
      selectDate(v);
      document.querySelector(`.date-chip[data-date="${v}"]`)?.scrollIntoView({ block: 'nearest', inline: 'center' });
    }
  });

  // --- Horas ---------------------------------------------------------------

  async function loadSlots() {
    const seq = ++state.loadSeq;
    const box = $('slots');
    const empty = (msg) => {
      box.innerHTML = `<div class="slots-empty">${G.esc(msg)}</div>`;
    };
    box.innerHTML = '<div class="spinner"></div>';

    let data;
    try {
      data = await G.api('/api/availability?date=' + state.date);
    } catch (err) {
      if (seq === state.loadSeq) empty(err.message);
      return;
    }
    if (seq !== state.loadSeq) return; // el usuario ya cambió de día

    if (!data.inRange) return empty('Esa fecha está fuera del rango de reservas.');
    if (!data.openDay) return empty('Este día no recibimos reservas. Elige otra fecha.');
    if (data.dayBlocked) return empty('Este día ya no tenemos disponibilidad. Prueba con otra fecha.');
    if (!data.slots.length) return empty('Ya no quedan horarios para hoy. Prueba con otra fecha.');

    const anyFree = data.slots.some((s) => s.available);
    box.innerHTML =
      (anyFree ? '' : '<div class="alert alert-info">Todas las horas de este día están llenas. Prueba con otra fecha.</div>') +
      '<div class="slots">' +
      data.slots
        .map(
          (s) =>
            `<button type="button" class="slot" data-time="${s.time}" aria-pressed="false" ${s.available ? '' : 'disabled'}>` +
            `<span class="t">${G.fmtTime(s.time)}</span>${s.available ? '' : '<small>Lleno</small>'}</button>`
        )
        .join('') +
      '</div>';
  }

  $('slots').addEventListener('click', (e) => {
    const btn = e.target.closest('.slot');
    if (!btn || btn.disabled) return;
    state.time = btn.dataset.time;
    document.querySelectorAll('.slot').forEach((s) => s.setAttribute('aria-pressed', String(s === btn)));
    hideError();
    updateSummary();
  });

  // --- Personas ------------------------------------------------------------

  function updatePeople() {
    const max = state.config?.maxPeople ?? 12;
    state.people = Math.min(Math.max(1, state.people), max);
    $('people-out').textContent = `${state.people} ${state.people === 1 ? 'persona' : 'personas'}`;
    $('people-minus').disabled = state.people <= 1;
    $('people-plus').disabled = state.people >= max;
    const hint = $('people-hint');
    hint.hidden = state.people < max;
    hint.textContent = `¿Son más de ${max}? Escríbenos por WhatsApp y armamos tu reserva de grupo.`;
    updateSummary();
  }

  $('people-minus').addEventListener('click', () => {
    state.people--;
    updatePeople();
  });
  $('people-plus').addEventListener('click', () => {
    state.people++;
    updatePeople();
  });

  // --- Resumen y envío -----------------------------------------------------

  function updateSummary() {
    $('sum-date').textContent = state.date ? G.fmtDate(state.date, { weekday: 'short', day: 'numeric', month: 'short' }) : '—';
    $('sum-time').textContent = state.time ? G.fmtTime(state.time) : '—';
    $('sum-people').textContent = String(state.people);
  }

  function showError(message, link) {
    const box = $('form-error');
    box.textContent = message;
    if (link) {
      const a = document.createElement('a');
      a.href = link.href;
      a.textContent = ' ' + link.text;
      box.append(a);
    }
    box.hidden = false;
  }

  function hideError() {
    $('form-error').hidden = true;
  }

  $('booking-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError();
    const name = $('name').value.trim();
    const phone = $('phone').value.trim();
    const email = $('email').value.trim();

    if (!state.time) return showError('Elige una hora para tu reserva.');
    if (name.length < 2) {
      $('name').focus();
      return showError('Escribe tu nombre.');
    }
    const digits = phone.replace(/\D/g, '').length;
    if (digits < 7 || digits > 15) {
      $('phone').focus();
      return showError('Escribe un número de celular válido.');
    }
    if (email && !$('email').checkValidity()) {
      $('email').focus();
      return showError('El correo no es válido.');
    }

    const btn = $('submit-btn');
    btn.disabled = true;
    btn.textContent = 'Enviando…';
    try {
      const r = await G.api('/api/reservations', {
        method: 'POST',
        body: JSON.stringify({
          name,
          phone,
          email,
          notes: $('notes').value.trim(),
          website: e.target.elements.website.value,
          date: state.date,
          time: state.time,
          people: state.people,
        }),
      });
      G.rememberReservation(r.id);
      showSuccess(r, name);
    } catch (err) {
      if (err.data?.code === 'duplicate') {
        showError(err.message, { href: '/reserva?id=' + encodeURIComponent(err.data.id), text: 'Ver mi reserva →' });
      } else {
        showError(err.message);
      }
      if (err.data?.code === 'slot') {
        state.time = null;
        updateSummary();
        loadSlots();
      }
    } finally {
      btn.disabled = false;
      btn.textContent = 'Solicitar reserva';
    }
  });

  function showSuccess(r, fullName) {
    const view = $('success-view');
    view.innerHTML = `
      <div style="height:48px"></div>
      <div class="card ticket">
        <div class="check"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div>
        <h1 style="font-size:2.4rem">¡Recibimos tu solicitud!</h1>
        <p class="muted">Tu reserva está <strong>pendiente de pago</strong>.</p>

        <div class="ticket-code">
          <span class="label">Tu código de reserva</span>
          <div class="code" id="ticket-code">${G.esc(r.id)}</div>
          <button type="button" class="btn btn-ghost btn-sm" id="copy-code" style="margin-top:10px">Copiar código</button>
        </div>

        ${G.paymentBox(state.config, r, fullName)}

        <dl class="ticket-details">
          <div><dt>Día</dt><dd>${G.esc(G.fmtDate(r.date, { weekday: 'short', day: 'numeric', month: 'short' }))}</dd></div>
          <div><dt>Hora</dt><dd>${G.esc(G.fmtTime(r.time))}</dd></div>
          <div><dt>Personas</dt><dd>${r.people}</dd></div>
          <div><dt>Estado</dt><dd>${G.statusChip(r.status)}</dd></div>
        </dl>

        <div class="next-steps">
          <h3>¿Cómo confirmo mi reserva?</h3>
          <ol>
            <li>Escríbenos ${state.config.whatsapp ? 'por WhatsApp' : 'por Instagram'} con tu código <strong>${G.esc(r.id)}</strong>.</li>
            <li>Te indicamos el valor del abono y cómo hacer el pago.</li>
            <li>Al recibir el pago confirmamos tu mesa y el estado cambia a <strong>Confirmada</strong>.</li>
          </ol>
        </div>

        <div class="ticket-actions">
          <a class="btn btn-ghost" href="/reserva?id=${encodeURIComponent(r.id)}">Consultar el estado de mi reserva</a>
        </div>
      </div>`;
    $('booking-view').hidden = true;
    view.hidden = false;
    $('copy-code').addEventListener('click', () => G.copy(r.id));
    window.scrollTo({ top: 0 });
  }

  init();
})();

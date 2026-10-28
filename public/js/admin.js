(() => {
  const G = Galilea;
  const $ = (id) => document.getElementById(id);
  const TOKEN_KEY = 'galilea:admin-token';
  const POLL_MS = 20000;
  const DAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

  let token = G.storage.get(TOKEN_KEY, null);

  const state = {
    tab: 'reservas',
    today: null,
    filters: { q: '', status: 'pendiente', scope: 'upcoming', date: '' },
    cache: new Map(), // id → reserva, para las acciones
    knownPending: null, // ids pendientes vistos; null hasta la primera carga
    newIds: new Set(),
    avDate: null,
    listSeq: 0,
    avSeq: 0,
    pollTimer: null,
  };

  async function api(path, opts = {}) {
    try {
      return await G.api(path, { ...opts, headers: { Authorization: `Bearer ${token}` } });
    } catch (err) {
      if (err.status === 401) logout(err.message);
      throw err;
    }
  }

  // --- Sesión --------------------------------------------------------------

  function showLogin(message) {
    $('app-view').hidden = true;
    $('login-view').hidden = false;
    $('login-error').textContent = message || '';
    $('login-error').hidden = !message;
    $('password').focus();
  }

  function logout(message) {
    token = null;
    G.storage.remove(TOKEN_KEY);
    clearInterval(state.pollTimer);
    state.knownPending = null;
    showLogin(message);
  }

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await G.api('/api/admin/login', {
        method: 'POST',
        body: JSON.stringify({ password: $('password').value }),
      });
      token = res.token;
      G.storage.set(TOKEN_KEY, token);
      $('password').value = '';
      start();
    } catch (err) {
      $('login-error').textContent = err.message;
      $('login-error').hidden = false;
    }
  });

  $('logout').addEventListener('click', () => logout());

  async function start() {
    $('login-view').hidden = true;
    $('app-view').hidden = false;
    try {
      await loadSummary();
      await checkNew();
    } catch {
      return; // sesión inválida: ya se mostró el ingreso
    }
    switchTab(state.tab);
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(poll, POLL_MS);
  }

  async function poll() {
    try {
      await Promise.all([loadSummary(), checkNew()]);
      if (state.tab === 'reservas') await loadList({ quiet: true });
      if (state.tab === 'disponibilidad') await loadAvailability({ quiet: true });
    } catch {
      /* sin conexión: se reintenta en el próximo ciclo */
    }
  }

  // --- Pestañas ------------------------------------------------------------

  document.querySelector('.admin-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) switchTab(b.dataset.tab);
  });

  function switchTab(tab) {
    state.tab = tab;
    document.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    document.querySelectorAll('[data-panel]').forEach((p) => {
      p.hidden = p.dataset.panel !== tab;
    });
    const loaders = {
      reservas: () => Promise.all([loadSummary(), loadList()]),
      disponibilidad: () => loadAvailability(),
      qr: () => loadQr(),
      config: () => loadConfig(),
    };
    loaders[tab]().catch(() => {});
  }

  // --- Formatos ------------------------------------------------------------

  function dateLabel(date) {
    if (date === state.today) return 'Hoy';
    if (state.today && date === G.addDays(state.today, 1)) return 'Mañana';
    return G.fmtDate(date, { weekday: 'short', day: 'numeric', month: 'short' });
  }

  const fmtPhone = (p) => (p.length === 10 ? `${p.slice(0, 3)} ${p.slice(3, 6)} ${p.slice(6)}` : p);

  function ago(iso) {
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    const rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });
    if (mins < 60) return rtf.format(-Math.max(mins, 0), 'minute');
    if (mins < 60 * 24) return rtf.format(-Math.round(mins / 60), 'hour');
    return rtf.format(-Math.round(mins / 1440), 'day');
  }

  // --- Resumen y avisos de reservas nuevas ---------------------------------

  async function loadSummary() {
    const s = await api('/api/admin/summary');
    state.today = s.today;
    $('stats').innerHTML = `
      <button class="stat ${s.pendingUpcoming ? 'attention' : ''}" data-stat="pending">
        <div class="k">Por confirmar</div>
        <div class="v">${s.pendingUpcoming}</div>
        <div class="s">Esperando el pago del cliente</div>
      </button>
      <button class="stat" data-stat="today">
        <div class="k">Hoy</div>
        <div class="v">${s.todayReservations}</div>
        <div class="s">${s.todayPeople} personas · ${s.todayConfirmed} confirmadas</div>
      </button>
      <div class="stat">
        <div class="k">Próximos 7 días</div>
        <div class="v">${s.weekConfirmed}</div>
        <div class="s">confirmadas · ${s.weekPeople} personas</div>
      </div>`;
    $('tab-count').textContent = s.pendingUpcoming;
    $('tab-count').hidden = !s.pendingUpcoming;
    document.title = (s.pendingUpcoming ? `(${s.pendingUpcoming}) ` : '') + 'Panel · Plaza Galilea';
  }

  // Dos tonos cortos cuando llega una reserva. Si el navegador bloquea el audio, no pasa nada.
  function chime() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [880, 1320].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const t = ctx.currentTime + i * 0.18;
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.2, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.4);
      });
      setTimeout(() => ctx.close(), 1000);
    } catch {
      /* sin audio */
    }
  }

  async function checkNew() {
    const pending = await api('/api/admin/reservations?status=pendiente&scope=upcoming');
    if (state.knownPending) {
      const fresh = pending.filter((r) => !state.knownPending.has(r.id));
      fresh.forEach((r) => state.newIds.add(r.id));
      if (fresh.length) chime();
      if (fresh.length === 1) {
        const r = fresh[0];
        G.toast(`Nueva reserva ${r.id}: ${r.name}, ${dateLabel(r.date)} ${G.fmtTime(r.time)}`, 7000);
      } else if (fresh.length > 1) {
        G.toast(`${fresh.length} reservas nuevas pendientes`, 7000);
      }
    }
    state.knownPending = new Set(pending.map((r) => r.id));
  }

  $('stats').addEventListener('click', (e) => {
    const b = e.target.closest('[data-stat]');
    if (!b) return;
    if (b.dataset.stat === 'pending') {
      setDateFilter('');
      setStatusFilter('pendiente');
      state.filters.scope = 'upcoming';
      $('f-scope').value = 'upcoming';
    } else {
      setStatusFilter('');
      setDateFilter(state.today);
    }
    loadList();
  });

  // --- Lista de reservas ---------------------------------------------------

  const actionBtn = (action, label, cls) =>
    `<button type="button" class="btn btn-sm ${cls}" data-action="${action}">${label}</button>`;

  // Mensaje para escribirle al cliente desde la fila, según el estado de su reserva.
  function clientMessage(r) {
    const first = r.name.split(' ')[0];
    const when = `${G.fmtDate(r.date)}, ${G.fmtTime(r.time)}`;
    if (r.status === 'confirmada') {
      return `Hola ${first}, recibimos tu pago. Tu reserva ${r.id} para el ${when} (${r.people} personas) quedó confirmada. ¡Te esperamos en Plaza Galilea!`;
    }
    return `Hola ${first}, te escribimos de Plaza Galilea sobre tu reserva ${r.id} para el ${when}.`;
  }

  function rowHtml(r) {
    state.cache.set(r.id, r);
    const wa = G.waLink(G.waNumber(r.phone), clientMessage(r));
    const actions = {
      pendiente:
        actionBtn('confirm', 'Pago recibido · Confirmar', 'btn-ok') + actionBtn('cancel', 'Cancelar', 'btn-danger-ghost'),
      confirmada: actionBtn('pending', 'Volver a pendiente', 'btn-ghost') + actionBtn('cancel', 'Cancelar', 'btn-danger-ghost'),
      cancelada: actionBtn('pending', 'Reactivar', 'btn-ghost'),
    }[r.status];

    return `
      <article class="res-row is-${r.status} ${state.newIds.has(r.id) ? 'is-new' : ''}" data-id="${G.esc(r.id)}">
        <div class="res-code">
          <span class="mono">${G.esc(r.id)}</span>${G.statusChip(r.status)}
          ${r.status === 'confirmada' ? '<span class="paid-tag">✓ Pagada</span>' : ''}
        </div>
        <div class="res-when"><strong>${G.esc(dateLabel(r.date))}</strong><span>${G.esc(G.fmtTime(r.time))}</span></div>
        <div class="res-who">
          <strong>${G.esc(r.name)}</strong>
          <a href="${G.esc(wa)}" target="_blank" rel="noopener" title="Escribir por WhatsApp">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2z"/></svg>
            ${G.esc(fmtPhone(r.phone))}
          </a>
          ${r.email ? `<small>${G.esc(r.email)}</small>` : ''}
        </div>
        <div class="res-people">${r.people} pers.</div>
        <div class="res-notes">
          ${r.notes ? G.esc(r.notes) : '<span class="res-meta">Sin comentarios</span>'}
          ${r.paymentRef ? `<span class="pay">Pago: ${G.esc(r.paymentRef)}</span>` : ''}
          <span class="res-meta">Creada ${G.esc(ago(r.createdAt))}</span>
        </div>
        <div class="res-actions">${actions}</div>
      </article>`;
  }

  function renderRows(container, list, emptyMsg) {
    container.innerHTML = list.length ? list.map(rowHtml).join('') : `<div class="empty">${emptyMsg}</div>`;
  }

  async function loadList({ quiet = false } = {}) {
    const seq = ++state.listSeq;
    const f = state.filters;
    const params = new URLSearchParams();
    if (f.q) params.set('q', f.q);
    if (f.status) params.set('status', f.status);
    if (f.date) params.set('date', f.date);
    else params.set('scope', f.scope);

    if (!quiet) $('res-list').innerHTML = '<div class="spinner"></div>';
    let list;
    try {
      list = await api('/api/admin/reservations?' + params);
    } catch (err) {
      if (seq === state.listSeq && err.status !== 401) {
        $('res-list').innerHTML = `<div class="empty">${G.esc(err.message)}</div>`;
      }
      return;
    }
    if (seq !== state.listSeq) return;

    const EMPTY = {
      pendiente: 'No hay reservas por confirmar. Las nuevas llegan aquí automáticamente.',
      confirmada: 'No hay reservas confirmadas en este periodo.',
      cancelada: 'No hay reservas canceladas en este periodo.',
      '': 'Todavía no hay reservas en este periodo.',
    };
    renderRows($('res-list'), list, f.q || f.date ? 'No hay reservas con estos filtros.' : EMPTY[f.status]);
    state.newIds.clear();
  }

  // Filtros
  function setStatusFilter(v) {
    state.filters.status = v;
    $('f-status').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === v)));
  }

  function setDateFilter(v) {
    state.filters.date = v;
    $('f-date').value = v;
    $('f-clear').hidden = !v;
    $('f-scope').disabled = Boolean(v);
  }

  let qTimer;
  $('f-q').addEventListener('input', (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      const q = e.target.value.trim();
      // "gal 7k3qh" o "GAL-7K3QH" se buscan como código exacto.
      state.filters.q = /^gal[\s-]*[a-z0-9]{5}$/i.test(q) ? G.normalizeCode(q) : q;
      loadList();
    }, 250);
  });

  $('f-status').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    setStatusFilter(b.dataset.v);
    loadList();
  });

  $('f-scope').addEventListener('change', (e) => {
    state.filters.scope = e.target.value;
    loadList();
  });

  $('f-date').addEventListener('change', (e) => {
    setDateFilter(e.target.value);
    loadList();
  });

  $('f-clear').addEventListener('click', () => {
    setDateFilter('');
    loadList();
  });

  // --- Acciones sobre una reserva ------------------------------------------

  function dialog({ title, body, input, ok, okClass = 'btn-primary' }) {
    const modal = $('modal');
    $('modal-title').textContent = title;
    $('modal-body').innerHTML = body;
    $('modal-field').hidden = !input;
    $('modal-input').value = '';
    if (input) {
      $('modal-label').textContent = input.label;
      $('modal-input').placeholder = input.placeholder || '';
    }
    $('modal-ok').textContent = ok;
    $('modal-ok').className = `btn ${okClass}`;
    modal.returnValue = '';
    modal.showModal();
    if (input) $('modal-input').focus();
    return new Promise((resolve) => {
      modal.addEventListener(
        'close',
        () => resolve({ ok: modal.returnValue === 'ok', value: $('modal-input').value.trim() }),
        { once: true }
      );
    });
  }

  $('modal-cancel').addEventListener('click', () => $('modal').close('cancel'));

  const summaryHtml = (r) => `
    <div class="modal-summary">
      <strong class="mono">${G.esc(r.id)}</strong> · ${G.esc(r.name)}<br>
      ${G.esc(G.fmtDate(r.date))}, ${G.esc(G.fmtTime(r.time))} · ${r.people} personas
    </div>`;

  async function setStatus(id, body, message) {
    try {
      const r = await api('/api/admin/reservations/' + encodeURIComponent(id), {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      // Los cambios hechos aquí no cuentan como "reserva nueva".
      if (r.status === 'pendiente') state.knownPending?.add(r.id);
      else state.knownPending?.delete(r.id);
      G.toast(message);
    } catch (err) {
      if (err.status !== 401) G.toast(err.message, 5000);
    }
    await loadSummary().catch(() => {});
    if (state.tab === 'reservas') await loadList({ quiet: true });
    if (state.tab === 'disponibilidad') await loadAvailability({ quiet: true });
  }

  async function onAction(e) {
    const b = e.target.closest('[data-action]');
    if (!b) return;
    const id = b.closest('[data-id]').dataset.id;
    const r = state.cache.get(id);
    if (!r) return;

    if (b.dataset.action === 'confirm') {
      const res = await dialog({
        title: 'Confirmar reserva',
        body:
          summaryHtml(r) +
          '<p>¿Ya recibiste el pago por WhatsApp? La reserva quedará <strong>Confirmada y pagada</strong>, y el cliente lo verá al consultar su código.</p>',
        input: { label: 'Referencia o valor del pago (opcional)', placeholder: 'Ej: Nequi $50.000 · ref 12345' },
        ok: 'Sí, pago recibido',
        okClass: 'btn-ok',
      });
      if (res.ok) {
        await setStatus(id, { status: 'confirmada', paymentRef: res.value }, `Reserva ${id} confirmada y pagada`);
      }
    }

    if (b.dataset.action === 'cancel') {
      const res = await dialog({
        title: 'Cancelar reserva',
        body: summaryHtml(r) + '<p>La hora vuelve a quedar libre para otros clientes.</p>',
        ok: 'Sí, cancelar',
        okClass: 'btn-primary',
      });
      if (res.ok) await setStatus(id, { status: 'cancelada' }, `Reserva ${id} cancelada`);
    }

    if (b.dataset.action === 'pending') {
      await setStatus(id, { status: 'pendiente' }, `Reserva ${id} marcada como pendiente`);
    }
  }

  $('res-list').addEventListener('click', onAction);
  $('av-res').addEventListener('click', onAction);

  // --- Disponibilidad ------------------------------------------------------

  function tileKind(s, day) {
    if (s.reason === 'pasado' || day.date < state.today) return 'past';
    if (s.reason === 'fuera_horario') return s.blocked ? 'blocked' : 'off';
    if (s.blocked || day.dayBlocked) return 'blocked';
    if (s.reason === 'cupo_completo') return 'auto';
    return 'free';
  }

  const TILE_TEXT = {
    free: 'Disponible',
    blocked: 'Llena · tocar para abrir',
    auto: 'Cupo completo',
    past: 'Ya pasó',
    off: 'Fuera de horario',
  };

  function renderDay(day) {
    const isPast = day.date < state.today;
    $('av-title').textContent = G.fmtDate(day.date) + (day.date === state.today ? ' · Hoy' : '');

    const kinds = day.slots.map((s) => tileKind(s, day));
    const free = kinds.filter((k) => k === 'free').length;
    const open = kinds.filter((k) => k !== 'off').length;
    let badge;
    if (isPast) badge = '<span class="status status-bad">Día pasado</span>';
    else if (!day.openDay) badge = '<span class="status status-bad">Cerrado según el horario</span>';
    else if (day.dayBlocked) badge = '<span class="status status-bad">Día completo marcado como lleno</span>';
    else if (!day.inRange) badge = '<span class="status status-warn">Aún no se puede reservar (fuera del rango de días)</span>';
    else badge = `<span class="status status-ok">${free} de ${open} horas disponibles</span>`;
    $('av-badge').innerHTML = badge;

    const toggle = $('av-day-toggle');
    toggle.hidden = isPast || !day.openDay;
    toggle.textContent = day.dayBlocked ? 'Abrir todo el día' : 'Marcar todo el día lleno';
    toggle.className = `btn btn-sm ${day.dayBlocked ? 'btn-primary' : 'btn-danger-ghost'}`;
    toggle.dataset.block = day.dayBlocked ? '0' : '1';

    if (!day.slots.length) {
      $('av-slots').innerHTML = '<div class="empty" style="grid-column:1/-1">No hay horas de reserva configuradas para este día.</div>';
      return;
    }

    $('av-slots').innerHTML = day.slots
      .map((s, i) => {
        const kind = kinds[i];
        // Un bloqueo de día completo se quita con el botón del día, no hora por hora.
        const locked = kind === 'past' || kind === 'off' || (kind === 'blocked' && !s.blocked);
        const load = s.reservations ? `${s.reservations} ${s.reservations === 1 ? 'reserva' : 'reservas'} · ${s.people} pers.` : 'Sin reservas';
        const label = kind === 'blocked' && !s.blocked ? 'Día lleno' : TILE_TEXT[kind];
        return `
          <button type="button" class="slot-tile ${kind}" data-time="${s.time}" data-block="${s.blocked ? '0' : '1'}" ${locked ? 'disabled' : ''}
            title="${locked ? '' : s.blocked ? 'Reabrir esta hora' : 'Marcar esta hora como llena'}">
            <span class="t">${G.fmtTime(s.time)}</span>
            <span class="n">${load}</span>
            <span class="st">${label}</span>
          </button>`;
      })
      .join('');
  }

  async function loadAvailability({ quiet = false } = {}) {
    state.avDate ??= state.today;
    const date = state.avDate;
    const seq = ++state.avSeq;
    $('av-date').value = date;
    if (!quiet) {
      $('av-slots').innerHTML = '<div class="spinner" style="grid-column:1/-1"></div>';
      $('av-res').innerHTML = '';
    }
    const [day, list] = await Promise.all([
      api('/api/admin/availability?date=' + date),
      api('/api/admin/reservations?date=' + date),
    ]);
    if (seq !== state.avSeq) return;
    renderDay(day);
    renderRows($('av-res'), list, 'No hay reservas para este día.');
  }

  async function setBlock(time, blocked) {
    try {
      const day = await api('/api/admin/blocks', {
        method: 'PUT',
        body: JSON.stringify({ date: state.avDate, time, blocked }),
      });
      renderDay(day);
      const what = time === '*' ? 'El día completo' : G.fmtTime(time);
      G.toast(blocked ? `${what}: marcada como llena` : `${what}: abierta para reservas`);
    } catch (err) {
      if (err.status !== 401) G.toast(err.message, 5000);
    }
  }

  $('av-slots').addEventListener('click', (e) => {
    const tile = e.target.closest('.slot-tile');
    if (tile && !tile.disabled) setBlock(tile.dataset.time, tile.dataset.block === '1');
  });

  $('av-day-toggle').addEventListener('click', (e) => setBlock('*', e.currentTarget.dataset.block === '1'));

  const goToDay = (date) => {
    if (!date) return;
    state.avDate = date;
    loadAvailability().catch(() => {});
  };
  $('av-prev').addEventListener('click', () => goToDay(G.addDays(state.avDate, -1)));
  $('av-next').addEventListener('click', () => goToDay(G.addDays(state.avDate, 1)));
  $('av-today').addEventListener('click', () => goToDay(state.today));
  $('av-date').addEventListener('change', (e) => goToDay(e.target.value));

  // --- QR ------------------------------------------------------------------

  async function loadQr() {
    const { menuUrl } = await api('/api/admin/settings');
    $('qr-img').src = '/qr/menu.svg?t=' + Date.now();
    $('qr-url').textContent = menuUrl;
    $('qr-warning').hidden = !/\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(menuUrl);
  }

  $('qr-print').addEventListener('click', () => {
    const clamp = (v) => Math.min(200, Math.max(1, Number.parseInt(v, 10) || 1));
    let from = clamp($('qr-from').value);
    let to = clamp($('qr-to').value);
    if (from > to) [from, to] = [to, from];
    window.open(`/qr-mesas.html?desde=${from}&hasta=${to}`, '_blank');
  });

  // --- Configuración -------------------------------------------------------

  async function loadConfig() {
    const { settings: s } = await api('/api/admin/settings');
    $('c-whatsapp').value = s.whatsapp;
    $('c-url').value = s.publicUrl;
    $('c-slot').value = String(s.slotMinutes);
    if ($('c-slot').value !== String(s.slotMinutes)) {
      $('c-slot').add(new Option(`${s.slotMinutes} min`, s.slotMinutes, true, true));
    }
    $('c-advance').value = s.minAdvanceMinutes;
    $('c-days').value = s.maxDaysAhead;
    $('c-people').value = s.maxPeople;
    $('c-perslot').value = s.maxReservationsPerSlot;
    $('c-hours').innerHTML =
      '<div class="hour-row" style="padding-top:0"><span></span><span class="label">Primera hora</span><span class="label">Última hora</span></div>' +
      DAY_ORDER.map((d) => {
        const h = s.hours[d];
        return `
          <div class="hour-row ${h.open ? '' : 'closed'}" data-day="${d}">
            <label><input type="checkbox" ${h.open ? 'checked' : ''}> ${DAYS[d]}</label>
            <input class="input" type="time" step="900" value="${G.esc(h.from)}" aria-label="Primera hora ${DAYS[d]}">
            <input class="input" type="time" step="900" value="${G.esc(h.to)}" aria-label="Última hora ${DAYS[d]}">
          </div>`;
      }).join('');
    $('config-error').hidden = true;
  }

  $('c-hours').addEventListener('change', (e) => {
    if (e.target.type === 'checkbox') e.target.closest('.hour-row').classList.toggle('closed', !e.target.checked);
  });

  $('config-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const hours = {};
    document.querySelectorAll('#c-hours .hour-row[data-day]').forEach((row) => {
      const [from, to] = row.querySelectorAll('input[type=time]');
      hours[row.dataset.day] = {
        open: row.querySelector('input[type=checkbox]').checked,
        from: from.value,
        to: to.value,
      };
    });
    try {
      await api('/api/admin/settings', {
        method: 'PUT',
        body: JSON.stringify({
          whatsapp: $('c-whatsapp').value,
          publicUrl: $('c-url').value,
          slotMinutes: $('c-slot').value,
          minAdvanceMinutes: $('c-advance').value,
          maxDaysAhead: $('c-days').value,
          maxPeople: $('c-people').value,
          maxReservationsPerSlot: $('c-perslot').value,
          hours,
        }),
      });
      $('config-error').hidden = true;
      G.toast('Configuración guardada');
    } catch (err) {
      $('config-error').textContent = err.message;
      $('config-error').hidden = false;
    }
  });

  // --- Arranque ------------------------------------------------------------

  if (token) start();
  else showLogin();
})();

(() => {
  const G = Galilea;
  const $ = (id) => document.getElementById(id);
  let config = null;

  const MESSAGES = {
    pendiente: {
      title: 'Pendiente de pago',
      text: 'Escríbenos por WhatsApp con tu código para hacer el pago. Cuando lo recibamos, confirmamos tu mesa.',
    },
    confirmada: {
      title: '¡Reserva confirmada!',
      text: 'Recibimos tu pago. Te esperamos; si vas a llegar tarde, avísanos.',
    },
    cancelada: {
      title: 'Reserva cancelada',
      text: 'Esta reserva fue cancelada. Si crees que es un error, escríbenos con tu código.',
    },
  };

  function renderRecent() {
    const list = G.storage.get('galilea:reservas', []);
    const box = $('recent');
    if (!list.length) {
      box.hidden = true;
      return;
    }
    box.innerHTML =
      '<span>Tus reservas recientes:</span>' +
      list.map((id) => `<button type="button" data-id="${G.esc(id)}">${G.esc(id)}</button>`).join('');
    box.hidden = false;
  }

  async function lookup(raw) {
    const id = G.normalizeCode(raw);
    const box = $('result');
    if (!id) {
      box.innerHTML = '<div class="lookup"><div class="alert alert-error">Escribe tu código de reserva.</div></div>';
      return;
    }
    $('code').value = id;
    history.replaceState(null, '', '/reserva?id=' + encodeURIComponent(id));
    box.innerHTML = '<div class="spinner"></div>';

    try {
      config ??= await G.api('/api/config');
      const r = await G.api('/api/reservations/' + encodeURIComponent(id));
      G.rememberReservation(r.id);
      renderRecent();
      render(r);
    } catch (err) {
      box.innerHTML = `<div class="lookup"><div class="alert alert-error">${G.esc(err.message)}</div></div>`;
    }
  }

  function render(r) {
    const m = MESSAGES[r.status];
    const cls = G.STATUS[r.status].cls;

    $('result').innerHTML = `
      <div class="card ticket">
        <span class="label muted">Reserva a nombre de ${G.esc(r.name)}</span>
        <div class="ticket-code" style="margin-top:10px">
          <span class="label">Código</span>
          <div class="code">${G.esc(r.id)}</div>
        </div>
        <div class="status-banner ${cls}">
          <div>
            <strong>${m.title}</strong>
            <p>${m.text}</p>
          </div>
        </div>
        ${r.status === 'pendiente' ? G.paymentBox(config, r) : ''}
        <dl class="ticket-details">
          <div><dt>Día</dt><dd>${G.esc(G.fmtDate(r.date, { weekday: 'short', day: 'numeric', month: 'short' }))}</dd></div>
          <div><dt>Hora</dt><dd>${G.esc(G.fmtTime(r.time))}</dd></div>
          <div><dt>Personas</dt><dd>${r.people}</dd></div>
          <div><dt>Estado</dt><dd>${G.statusChip(r.status)}</dd></div>
        </dl>
        <div class="ticket-actions">
          <button type="button" class="btn btn-ghost" id="refresh">Actualizar estado</button>
        </div>
      </div>`;
    $('refresh').addEventListener('click', () => lookup(r.id));
  }

  $('lookup-form').addEventListener('submit', (e) => {
    e.preventDefault();
    lookup($('code').value);
  });

  $('recent').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-id]');
    if (btn) lookup(btn.dataset.id);
  });

  renderRecent();
  const initial = new URLSearchParams(location.search).get('id');
  if (initial) lookup(initial);
})();

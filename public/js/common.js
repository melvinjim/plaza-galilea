// Utilidades compartidas por las páginas públicas y el panel.
const Galilea = (() => {
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* respuesta sin cuerpo JSON */
    }
    if (!res.ok) {
      const err = new Error(data?.error || 'Ocurrió un error. Intenta de nuevo.');
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

  const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  // Las fechas llegan como 'YYYY-MM-DD'; se formatean en UTC para que no se corran de día.
  function fmtDate(date, opts = { weekday: 'long', day: 'numeric', month: 'long' }) {
    return capitalize(
      new Intl.DateTimeFormat('es-CO', { ...opts, timeZone: 'UTC' }).format(new Date(date + 'T12:00:00Z'))
    );
  }

  function fmtTime(t) {
    const [h, m] = t.split(':').map(Number);
    return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'a. m.' : 'p. m.'}`;
  }

  const fmtCOP = (n) => '$' + Number(n).toLocaleString('es-CO');

  function addDays(date, n) {
    const d = new Date(date + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  function normalizeCode(input) {
    let c = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (c.length === 8 && c.startsWith('GAL')) c = c.slice(3);
    return c ? 'GAL-' + c : '';
  }

  const STATUS = {
    pendiente: { label: 'Pendiente', cls: 'warn' },
    confirmada: { label: 'Confirmada', cls: 'ok' },
    cancelada: { label: 'Cancelada', cls: 'bad' },
  };

  const statusChip = (s) => `<span class="status status-${STATUS[s].cls}">${STATUS[s].label}</span>`;

  // localStorage puede no existir (modo privado, bloqueado): nunca debe romper la página.
  const storage = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v == null ? fallback : JSON.parse(v);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* sin almacenamiento */
      }
    },
    remove(key) {
      try {
        localStorage.removeItem(key);
      } catch {
        /* sin almacenamiento */
      }
    },
  };

  function rememberReservation(id) {
    const list = storage.get('galilea:reservas', []).filter((x) => x !== id);
    list.unshift(id);
    storage.set('galilea:reservas', list.slice(0, 5));
  }

  // Celulares colombianos de 10 dígitos se completan con el indicativo 57.
  const waNumber = (phone) => (phone.length === 10 && phone.startsWith('3') ? '57' + phone : phone);
  const waLink = (number, text) => `https://wa.me/${number}?text=${encodeURIComponent(text)}`;

  const WA_ICON =
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2c-1.5 0-3-.4-4.3-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2c0 1.3.9 2.5 1 2.7.1.2 1.8 2.8 4.4 3.9 1.6.7 2.3.8 3.1.6.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2-.1-.1-.3-.2-.5-.3z"/></svg>';

  // Mensaje que el cliente le envía al restaurante para pagar su reserva.
  function paymentMessage(r, name) {
    const lines = [
      `Hola, este es mi código de reserva: ${r.id}`,
      'Quiero confirmar mi reserva para hacer el pago.',
      '',
      `Fecha: ${fmtDate(r.date)}, ${fmtTime(r.time)}`,
      `Personas: ${r.people}`,
    ];
    if (name) lines.push(`Nombre: ${name}`);
    return lines.join('\n');
  }

  // Recuadro "escríbenos para pagar" de la pantalla final y de la consulta.
  function paymentBox(config, r, name) {
    if (!config.whatsapp) {
      return `
        <div class="pay-box">
          <h2>Escríbenos para hacer el pago de tu reserva</h2>
          <p>Envíanos tu código <strong>${esc(r.id)}</strong> por mensaje directo. Te indicamos el valor del abono y, al recibirlo, confirmamos tu mesa.</p>
          <a class="btn btn-primary btn-lg" href="https://ig.me/m/${esc(config.instagram)}" target="_blank" rel="noopener">Escribir por Instagram</a>
        </div>`;
    }
    return `
      <div class="pay-box">
        <h2>Escríbenos por WhatsApp para hacer el pago de tu reserva</h2>
        <p>Se abre el chat con un mensaje listo que incluye tu código. Te indicamos el valor del abono y, al recibirlo, confirmamos tu mesa.</p>
        <a class="btn btn-whatsapp btn-lg" href="${esc(waLink(config.whatsapp, paymentMessage(r, name)))}" target="_blank" rel="noopener">${WA_ICON} Escribir por WhatsApp</a>
      </div>`;
  }

  function toast(message, ms = 3200) {
    let wrap = document.querySelector('.toast-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'toast-wrap';
      wrap.setAttribute('role', 'status');
      document.body.append(wrap);
    }
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = message;
    wrap.append(el);
    setTimeout(() => el.remove(), ms);
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Código copiado');
    } catch {
      toast('No se pudo copiar. Selecciona el código y cópialo manualmente.');
    }
  }

  // Menú móvil del encabezado.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-nav-toggle]');
    if (!btn) return;
    const nav = document.getElementById(btn.getAttribute('aria-controls'));
    const open = nav.classList.toggle('open');
    btn.setAttribute('aria-expanded', String(open));
  });

  return {
    api,
    esc,
    fmtDate,
    fmtTime,
    fmtCOP,
    addDays,
    normalizeCode,
    STATUS,
    statusChip,
    storage,
    rememberReservation,
    waNumber,
    waLink,
    WA_ICON,
    paymentMessage,
    paymentBox,
    toast,
    copy,
  };
})();

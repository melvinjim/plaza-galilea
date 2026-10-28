(() => {
  const G = Galilea;
  const $ = (id) => document.getElementById(id);
  const ACCENTS = { olivia: '#d2702c', bebidas: '#c0612a', ramon: '#d9502b', lunch: '#b04a26' };
  let menu = null;

  const mesa = Number.parseInt(new URLSearchParams(location.search).get('mesa'), 10);
  if (mesa > 0) {
    $('table-badge').textContent = `Mesa ${mesa}`;
    $('table-badge').hidden = false;
  }

  function itemHtml(item) {
    const flags = [];
    if (item.star) flags.push(`<span class="flag flag-star">${item.star > 1 ? '★★ Favorito' : '★ Recomendado'}</span>`);
    if (item.spicy) flags.push('<span class="flag flag-spicy">Picante</span>');
    if (item.tag) flags.push(`<span class="flag flag-tag">${G.esc(item.tag)}</span>`);
    const price = item.price ? `<span class="dots"></span><span class="menu-item-price">${G.fmtCOP(item.price)}</span>` : '';
    return `
      <li class="menu-item">
        <div class="menu-item-head">
          <span class="menu-item-name">${G.esc(item.name)}${flags.length ? `<span class="menu-flags">${flags.join('')}</span>` : ''}</span>
          ${price}
        </div>
        ${item.desc ? `<p class="menu-item-desc">${G.esc(item.desc)}</p>` : ''}
      </li>`;
  }

  function renderGroup(id) {
    const group = menu.groups.find((g) => g.id === id) || menu.groups[0];
    document.querySelectorAll('.menu-tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.id === group.id)));

    const intro = group.intro
      ? `<div class="lunch-intro">
           <div><div class="amount">${G.fmtCOP(group.intro.price)}</div><div>${G.esc(group.intro.text)}</div></div>
           <ul>${group.intro.extras.map((x) => `<li>${G.esc(x)}</li>`).join('')}</ul>
         </div>`
      : '';

    const body = $('menu-body');
    body.style.setProperty('--accent', ACCENTS[group.id] || 'var(--orange)');
    body.innerHTML = `
      <div class="menu-group-head">
        <h1>${G.esc(group.label.toUpperCase())}</h1>
        <p>${G.esc(group.subtitle)}</p>
      </div>
      ${intro}
      ${group.sections
        .map(
          (s) => `
        <section class="menu-section">
          <h2>${G.esc(s.title)}</h2>
          ${s.note ? `<p class="section-note">${G.esc(s.note)}</p>` : ''}
          <ul class="menu-items">${s.items.map(itemHtml).join('')}</ul>
        </section>`
        )
        .join('')}
      <p class="menu-legend"><strong>★</strong> Recomendados de la casa · ${G.esc(menu.allergyNote)}</p>
      <div class="menu-cta"><a class="btn btn-ghost" href="/reservar">Reservar una mesa</a></div>`;
  }

  function select(id) {
    renderGroup(id);
    history.replaceState(null, '', location.pathname + location.search + '#' + id);
    window.scrollTo({ top: 0 });
  }

  async function init() {
    try {
      menu = await G.api('/data/menu.json');
    } catch {
      $('menu-body').innerHTML = '<div class="alert alert-error">No pudimos cargar el menú. Recarga la página.</div>';
      return;
    }
    $('menu-tabs').innerHTML = menu.groups
      .map((g) => `<button class="menu-tab" role="tab" data-id="${g.id}" aria-selected="false">${G.esc(g.label)}</button>`)
      .join('');
    $('menu-tabs').addEventListener('click', (e) => {
      const tab = e.target.closest('.menu-tab');
      if (tab) select(tab.dataset.id);
    });
    renderGroup(location.hash.slice(1));
  }

  init();
})();

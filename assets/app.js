/* Gig Tracker UI — plain JS, no dependencies. Loads data/gigs.json + config/favourites.json. */
(() => {
  'use strict';

  const state = {
    view: 'list',
    q: '',
    country: '',
    genre: '',
    type: 'all',
    favOnly: false,
    month: null, // Date at the 1st of the displayed calendar month
  };

  let gigs = [];
  let favNames = [];
  let newBadgeDays = 7;

  const $ = (sel) => document.querySelector(sel);
  const norm = (s) =>
    (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

  const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
  const countryName = (cc) => {
    try { return regionNames.of(cc) || cc; } catch { return cc; }
  };
  const flag = (cc) =>
    cc && /^[A-Z]{2}$/i.test(cc)
      ? String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0)))
      : '';

  const parseDate = (iso) => new Date(`${iso}T12:00:00`);
  const fmtDay = (iso) =>
    parseDate(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const fmtMonthYear = (d) => d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

  const isFav = (gig) =>
    favNames.some(
      (f) => gig.bands.some((b) => norm(b) === f) || ` ${norm(gig.title)} `.includes(` ${f} `)
    );
  const isNew = (gig) => Date.now() - new Date(gig.firstSeen).getTime() < newBadgeDays * 86400_000;

  // Broad category from the source classifications. Precedence matters:
  // anything metal is Metal, then Hard Rock claims its events before plain Rock.
  const categoryOf = (gig) => {
    const s = norm(`${gig.genre || ''} ${gig.subGenre || ''}`);
    if (s.includes('metal')) return 'Metal';
    if (s.includes('hard rock')) return 'Hard Rock';
    if (s.includes('rock')) return 'Rock';
    return null;
  };

  // Deterministic gradient per gig for the image fallback
  const hue = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  const initials = (title) =>
    title.split(/\s+/).filter((w) => /^[a-z0-9]/i.test(w)).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function filteredGigs() {
    const today = new Date().toISOString().slice(0, 10);
    const q = norm(state.q);
    return gigs.filter((g) => {
      if (g.date < today) return false;
      if (state.country && g.country !== state.country) return false;
      if (state.genre && g._cat !== state.genre) return false;
      if (state.type === 'festival' && !g.isFestival) return false;
      if (state.type === 'gig' && g.isFestival) return false;
      if (state.favOnly && !g._fav) return false;
      if (q) {
        const hay = norm([g.title, ...g.bands, g.city, g.venue, countryName(g.country)].join(' '));
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  /* ---------- ticker ---------- */
  function renderTicker() {
    const sorted = [...gigs].sort((a, b) => new Date(b.firstSeen) - new Date(a.firstSeen));
    let latest = sorted.filter(isNew).slice(0, 12);
    if (latest.length < 4) latest = sorted.slice(0, 8); // sample data / quiet weeks
    const html = latest
      .map(
        (g) => `<a class="ticker-item${g._fav ? ' fav' : ''}" href="${esc(g.url) || '#'}" target="_blank" rel="noopener">
          ${g._fav ? '🤘 ' : ''}<span class="tk-band">${esc(g.title)}</span>
          <span class="tk-date"> — ${esc(g.city)} ${flag(g.country)} · ${fmtDay(g.date)}</span></a>`
      )
      .join('');
    // Two copies so the CSS -50% translate loops seamlessly
    $('#ticker-track').innerHTML = html + html;
  }

  /* ---------- cards ---------- */
  function cardHTML(g) {
    const badges = [
      isNew(g) ? '<span class="badge badge-new">New</span>' : '',
      g._fav ? '<span class="badge badge-fav">🤘 Favourite</span>' : '',
      g.isFestival ? '<span class="badge badge-fest">Festival</span>' : '',
    ].join('');
    const d = parseDate(g.date);
    const media = `
      <div class="card-media">
        <div class="media-fallback" style="background:linear-gradient(135deg,hsl(${hue(g.title)},45%,22%),hsl(${(hue(g.title) + 60) % 360},55%,12%))">${esc(initials(g.title))}</div>
        ${g.image ? `<img src="${esc(g.image)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
        <div class="badge-row">${badges}</div>
        <div class="card-date"><span class="d-day">${d.getDate()}</span><span class="d-mon">${d.toLocaleDateString('en-GB', { month: 'short' })} ${d.getFullYear()}</span></div>
      </div>`;
    const bands = g.bands.filter((b) => !norm(g.title).includes(norm(b)));
    return `
      <article class="card${g._fav ? ' fav' : ''}">
        ${media}
        <div class="card-body">
          <h3 class="card-title">${esc(g.title)}</h3>
          ${bands.length ? `<div class="card-bands">${esc(bands.join(' · '))}</div>` : ''}
          <div class="card-where">📍 ${esc([g.venue, g.city].filter(Boolean).join(', '))} ${flag(g.country)} ${esc(countryName(g.country))}</div>
          <div class="card-when">🗓 ${fmtDay(g.date)}${g.time ? ` · ${esc(g.time)}` : ''}</div>
          <div class="card-footer">
            <span class="chip-row">
              ${g._cat ? `<span class="genre-chip cat" data-cat="${esc(g._cat)}">${esc(g._cat)}</span>` : ''}
              ${g.subGenre && norm(g.subGenre) !== norm(g._cat || '') ? `<span class="genre-chip">${esc(g.subGenre)}</span>` : ''}
            </span>
            ${g.url ? `<a class="ticket-link" href="${esc(g.url)}" target="_blank" rel="noopener">Tickets ↗</a>` : ''}
          </div>
        </div>
      </article>`;
  }

  function renderList() {
    const list = filteredGigs();
    $('#empty-state').hidden = list.length > 0;
    const byMonth = new Map();
    for (const g of list) {
      const key = g.date.slice(0, 7);
      if (!byMonth.has(key)) byMonth.set(key, []);
      byMonth.get(key).push(g);
    }
    $('#list-view').innerHTML = [...byMonth.entries()]
      .map(
        ([key, items]) => `
          <h2 class="month-header">${fmtMonthYear(parseDate(`${key}-01`))} <small>(${items.length})</small></h2>
          <div class="card-grid">${items.map(cardHTML).join('')}</div>`
      )
      .join('');
  }

  /* ---------- calendar ---------- */
  function renderCalendar() {
    const list = filteredGigs();
    $('#empty-state').hidden = list.length > 0;
    const byDate = new Map();
    for (const g of list) {
      if (!byDate.has(g.date)) byDate.set(g.date, []);
      byDate.get(g.date).push(g);
    }

    const first = state.month;
    $('#cal-title').textContent = fmtMonthYear(first);
    const startOffset = (first.getDay() + 6) % 7; // Monday-first
    const gridStart = new Date(first);
    gridStart.setDate(1 - startOffset);

    const todayISO = new Date().toISOString().slice(0, 10);
    let html = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<div class="cal-dow">${d}</div>`).join('');

    for (let i = 0; i < 42; i++) {
      const day = new Date(gridStart);
      day.setDate(gridStart.getDate() + i);
      const iso = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
      const outside = day.getMonth() !== first.getMonth();
      const chips = (byDate.get(iso) || [])
        .map(
          (g) =>
            `<button class="cal-chip${g._fav ? ' fav' : ''}${g.isFestival ? ' fest' : ''}" data-gig="${esc(g.id)}" title="${esc(g.title)}">${g._fav ? '🤘 ' : ''}${esc(g.title)}</button>`
        )
        .join('');
      const hasEvents = byDate.has(iso);
      html += `<div class="cal-day${outside ? ' outside' : ''}${iso === todayISO ? ' today' : ''}${hasEvents ? ' has-events' : ''}" data-date="${iso}"><span class="cal-day-num">${day.getDate()}</span>${chips}</div>`;
    }
    $('#calendar-grid').innerHTML = html;
  }

  function openModal(id) {
    const g = gigs.find((x) => x.id === id);
    if (!g) return;
    $('#modal-body').innerHTML = cardHTML(g);
    $('#gig-modal').showModal();
  }

  // Tapping a calendar day shows everything on that date — the main way to
  // open events on mobile, where chips collapse into small bars.
  function openDayModal(iso) {
    const list = filteredGigs().filter((g) => g.date === iso);
    if (!list.length) return;
    $('#modal-body').innerHTML = `
      <div class="day-modal">
        <h3 class="day-modal-title">${fmtDay(iso)} · ${list.length} event${list.length > 1 ? 's' : ''}</h3>
        ${list.map(cardHTML).join('')}
      </div>`;
    $('#gig-modal').showModal();
  }

  /* ---------- render root ---------- */
  function render() {
    $('#btn-list').classList.toggle('active', state.view === 'list');
    $('#btn-calendar').classList.toggle('active', state.view === 'calendar');
    $('#list-view').hidden = state.view !== 'list';
    $('#calendar-view').hidden = state.view !== 'calendar';
    if (state.view === 'list') renderList();
    else renderCalendar();
  }

  function populateCountryFilter() {
    const seen = [...new Set(gigs.map((g) => g.country).filter(Boolean))]
      .map((cc) => [cc, countryName(cc)])
      .sort((a, b) => a[1].localeCompare(b[1]));
    $('#country-filter').innerHTML =
      '<option value="">All countries</option>' +
      seen.map(([cc, name]) => `<option value="${cc}">${flag(cc)} ${esc(name)}</option>`).join('');
  }

  function wireEvents() {
    $('#btn-list').addEventListener('click', () => { state.view = 'list'; location.hash = ''; render(); });
    $('#btn-calendar').addEventListener('click', () => { state.view = 'calendar'; location.hash = 'calendar'; render(); });
    $('#search').addEventListener('input', (e) => { state.q = e.target.value; render(); });
    $('#country-filter').addEventListener('change', (e) => { state.country = e.target.value; render(); });
    $('#genre-filter').addEventListener('change', (e) => { state.genre = e.target.value; render(); });
    $('#type-filter').addEventListener('change', (e) => { state.type = e.target.value; render(); });
    $('#fav-only').addEventListener('change', (e) => { state.favOnly = e.target.checked; render(); });
    $('#cal-prev').addEventListener('click', () => { state.month = new Date(state.month.getFullYear(), state.month.getMonth() - 1, 1); render(); });
    $('#cal-next').addEventListener('click', () => { state.month = new Date(state.month.getFullYear(), state.month.getMonth() + 1, 1); render(); });
    $('#cal-today').addEventListener('click', () => { const n = new Date(); state.month = new Date(n.getFullYear(), n.getMonth(), 1); render(); });
    $('#calendar-grid').addEventListener('click', (e) => {
      const chip = e.target.closest('.cal-chip');
      if (chip) return openModal(chip.dataset.gig);
      const day = e.target.closest('.cal-day.has-events');
      if (day) openDayModal(day.dataset.date);
    });
    $('#modal-close').addEventListener('click', () => $('#gig-modal').close());
    $('#gig-modal').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
  }

  async function init() {
    const bust = `?t=${Date.now()}`;
    const [dataRes, favRes] = await Promise.all([
      fetch(`data/gigs.json${bust}`),
      fetch(`config/favourites.json${bust}`),
    ]);
    const data = await dataRes.json();
    favNames = ((await favRes.json()).bands || []).map(norm).filter(Boolean);

    gigs = (data.gigs || []).map((g) => ({ ...g, _fav: false, _cat: categoryOf(g) }));
    gigs.forEach((g) => { g._fav = isFav(g); });

    const updated = new Date(data.updatedAt);
    $('#updated-at').textContent = `Updated ${updated.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
    $('#sample-banner').hidden = data.source !== 'sample';

    const now = new Date();
    state.month = new Date(now.getFullYear(), now.getMonth(), 1);
    if (location.hash === '#calendar') state.view = 'calendar';

    populateCountryFilter();
    wireEvents();
    renderTicker();
    render();
  }

  init().catch((err) => {
    $('#list-view').innerHTML = `<p class="empty-state">Failed to load gig data: ${esc(err.message)}.<br>
      Serve this folder over HTTP (e.g. <code>npm run serve</code>) — browsers block JSON loading from file:// URLs.</p>`;
    console.error(err);
  });
})();

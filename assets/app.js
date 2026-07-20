/* Gig Tracker UI — plain JS, no dependencies. Loads data/gigs.json + config/favourites.json. */
(() => {
  'use strict';

  // Rendering thousands of cards at once freezes phones, so the list view
  // paginates and the panels cap their rows.
  const LIST_PAGE = 120;
  const PANEL_MAX_ROWS = 100;

  const state = {
    view: 'list',
    q: '',
    country: '',
    genre: '',
    avail: '',
    type: 'all',
    favOnly: false,
    sort: '', // '' = gig date | 'added' = firstSeen desc | 'onsale' = sale date
    month: null, // Date at the 1st of the displayed calendar month
    listLimit: LIST_PAGE,
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

  // Exact band-name matches only — matching against event titles pulls in
  // tribute acts ("Daft Punkz", "Some Kind Of Metalica") that name-drop the
  // real band.
  const isFav = (gig) => gig.bands.some((b) => favNames.includes(norm(b)));
  const isNew = (gig) => Date.now() - new Date(gig.firstSeen).getTime() < newBadgeDays * 86400_000;

  // Broad category from the source classifications. Precedence matters:
  // anything metal is Metal, then Hard Rock claims its events before plain Rock.
  // A "Pop" genre is vetoed outright (e.g. Pop/Pop Rock), leaving the event
  // out of scope unless it's a favourite.
  const categoryOf = (gig) => {
    if (norm(gig.genre || '').includes('pop')) return null;
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
      if (state.avail === 'not-soldout' && g.availability === 'soldout') return false;
      if (state.avail === 'available' && g.availability !== 'available') return false;
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

  /* ---------- notice panels (latest additions / on sale soon) ---------- */
  const PANEL_PREVIEW_ROWS = 5;

  const shortName = (g) => (g.isFestival ? g.title : g.bands.slice(0, 2).join(' & '));
  const shortDay = (iso) =>
    parseDate(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

  function panelItemHTML(g, detail) {
    return `<li class="p-item${g._fav ? ' fav' : ''}" data-gig="${esc(g.id)}">
      <button class="p-item-btn">${g._fav ? '🤘 ' : ''}<strong>${esc(shortName(g))}</strong>
      <span class="p-detail"> — ${esc([g.venue, g.city].filter(Boolean).join(', '))} ${flag(g.country)} · ${detail}</span></button></li>`;
  }

  // Fills a panel <ul>, hiding rows past the preview limit behind "See all".
  // At most PANEL_MAX_ROWS items go into the DOM (phones choke on thousands);
  // an empty result shows a message instead of hiding the panel.
  function fillPanel(baseId, rows, itemCount, emptyMessage) {
    const list = $(`#${baseId}-list`);
    const toggle = $(`#${baseId}-toggle`);
    $(`#${baseId}-panel`).hidden = false;
    if (!rows.length) {
      list.innerHTML = `<li class="p-empty">${emptyMessage}</li>`;
      toggle.hidden = true;
      return;
    }
    let shown = 0;
    const parts = [];
    for (const row of rows) {
      if (row.head !== undefined) {
        if (shown < PANEL_MAX_ROWS) parts.push({ extra: shown >= PANEL_PREVIEW_ROWS, html: row.head });
        continue;
      }
      shown++;
      if (shown > PANEL_MAX_ROWS) break;
      parts.push({ extra: shown > PANEL_PREVIEW_ROWS, html: row.item });
    }
    if (itemCount > PANEL_MAX_ROWS) {
      parts.push({
        extra: true,
        html: `<li class="p-empty">…and ${itemCount - PANEL_MAX_ROWS} more — use the filters above to narrow the list</li>`,
      });
    }
    list.innerHTML = parts
      .map((r) => (r.extra ? r.html.replace(/^<li class="/, '<li class="extra ') : r.html))
      .join('');
    toggle.hidden = itemCount <= PANEL_PREVIEW_ROWS;
    toggle.dataset.seeAll = `See all (${itemCount > PANEL_MAX_ROWS ? `first ${PANEL_MAX_ROWS} of ${itemCount}` : itemCount})`;
    // Keep the user's expand/collapse choice across filter-driven re-renders
    toggle.textContent = list.classList.contains('collapsed') ? toggle.dataset.seeAll : 'Show less';
  }

  // Panels respect whatever is set in the toolbar (search, country, genre, …)
  function renderPanels() {
    const visible = filteredGigs();

    // Latest additions, grouped: Favourites, then Metal / Hard Rock / Rock
    const latest = visible.filter(isNew).sort((a, b) => a.date.localeCompare(b.date));
    const groups = [
      ['🤘 Favourites', 'fav', (g) => g._fav],
      ['Metal', 'metal', (g) => !g._fav && g._cat === 'Metal'],
      ['Hard Rock', 'hardrock', (g) => !g._fav && g._cat === 'Hard Rock'],
      ['Rock', 'rock', (g) => !g._fav && g._cat === 'Rock'],
      ['Other', 'other', (g) => !g._fav && !g._cat],
    ];
    const latestRows = [];
    let latestCount = 0;
    for (const [label, cls, match] of groups) {
      const items = latest.filter(match);
      if (!items.length) continue;
      latestRows.push({ head: `<li class="p-head p-head-${cls}">${label}</li>` });
      for (const g of items) {
        latestRows.push({ item: panelItemHTML(g, shortDay(g.date)) });
        latestCount++;
      }
    }
    fillPanel('latest', latestRows, latestCount, 'No new additions in the last 7 days for this selection.');

    // Tickets going on public sale within the next 7 days, soonest first
    const now = Date.now();
    const soon = now + 7 * 86400_000;
    const onSale = visible
      .filter((g) => g.onSaleDate && new Date(g.onSaleDate) > now && new Date(g.onSaleDate) <= soon)
      .sort((a, b) => new Date(a.onSaleDate) - new Date(b.onSaleDate));
    const onSaleRows = onSale.map((g) => ({
      item: panelItemHTML(
        g,
        `${esc(shortDay(g.date))} — <em>on sale ${new Date(g.onSaleDate).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</em>`
      ),
    }));
    fillPanel(
      'onsale',
      onSaleRows,
      onSale.length,
      'No public ticket sales starting in the next 7 days for this selection — most sales open on Friday mornings, so check back then.'
    );
  }

  /* ---------- cards ---------- */
  const AVAILABILITY = {
    available: ['av-green', 'Tickets available'],
    limited: ['av-yellow', 'Low capacity'],
    soldout: ['av-red', 'Sold out'],
  };

  function availabilityHTML(g) {
    if (g.onSaleDate && new Date(g.onSaleDate) > Date.now()) {
      return `<div class="card-avail av-onsale">🎟️ On sale ${new Date(g.onSaleDate).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>`;
    }
    const av = AVAILABILITY[g.availability];
    return av ? `<div class="card-avail ${av[0]}"><i class="av-dot"></i>${av[1]}</div>` : '';
  }
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
          ${state.sort === 'added' && g.firstSeen ? `<div class="card-when">➕ Added ${fmtDay(g.firstSeen.slice(0, 10))}</div>` : ''}
          ${state.sort === 'onsale' && g.onSaleDate && new Date(g.onSaleDate) <= Date.now() ? `<div class="card-when">🎟️ On sale since ${fmtDay(g.onSaleDate.slice(0, 10))}</div>` : ''}
          ${availabilityHTML(g)}
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

  // List-view ordering. 'added' surfaces the newest announcements first;
  // 'onsale' puts upcoming ticket sales first (soonest at the top), then
  // already-open sales newest first, then events with no sale date.
  function sortGigs(list) {
    if (state.sort === 'added') {
      return [...list].sort(
        (a, b) => new Date(b.firstSeen) - new Date(a.firstSeen) || a.date.localeCompare(b.date)
      );
    }
    if (state.sort === 'onsale') {
      const now = Date.now();
      return [...list].sort((a, b) => {
        const ka = a.onSaleDate ? new Date(a.onSaleDate).getTime() : null;
        const kb = b.onSaleDate ? new Date(b.onSaleDate).getTime() : null;
        if (ka === null || kb === null) {
          return ka === kb ? a.date.localeCompare(b.date) : ka === null ? 1 : -1;
        }
        const upA = ka > now;
        const upB = kb > now;
        if (upA !== upB) return upA ? -1 : 1;
        return upA ? ka - kb : kb - ka;
      });
    }
    return list; // data is already sorted by gig date
  }

  const SORT_HEADINGS = { added: 'Most recently added first', onsale: 'Upcoming ticket sales first' };

  function renderList() {
    const list = sortGigs(filteredGigs());
    $('#empty-state').hidden = list.length > 0;
    // Only state.listLimit cards go into the DOM; the rest sit behind a
    // "Show more" button. Month headers still show the month's full count.
    const shown = list.slice(0, state.listLimit);
    const remaining = list.length - shown.length;
    const showMoreBtn =
      remaining > 0 ? `<button class="show-more" id="show-more">Show more (${remaining} remaining)</button>` : '';

    // Alternative sorts render as one flat section; month grouping only
    // makes sense in gig-date order.
    if (state.sort) {
      $('#list-view').innerHTML = shown.length
        ? `<h2 class="month-header">${SORT_HEADINGS[state.sort]} <small>(${list.length})</small></h2>
           <div class="card-grid">${shown.map(cardHTML).join('')}</div>` + showMoreBtn
        : '';
      return;
    }

    const monthTotals = new Map();
    for (const g of list) {
      const key = g.date.slice(0, 7);
      monthTotals.set(key, (monthTotals.get(key) || 0) + 1);
    }
    const byMonth = new Map();
    for (const g of shown) {
      const key = g.date.slice(0, 7);
      if (!byMonth.has(key)) byMonth.set(key, []);
      byMonth.get(key).push(g);
    }
    $('#list-view').innerHTML =
      [...byMonth.entries()]
        .map(
          ([key, items]) => `
          <h2 class="month-header">${fmtMonthYear(parseDate(`${key}-01`))} <small>(${monthTotals.get(key)})</small></h2>
          <div class="card-grid">${items.map(cardHTML).join('')}</div>`
        )
        .join('') + showMoreBtn;
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
      const dayGigs = byDate.get(iso) || [];
      const chips = dayGigs
        .slice(0, 4)
        .map(
          (g) =>
            `<button class="cal-chip${g._fav ? ' fav' : ''}${g.isFestival ? ' fest' : ''}" data-gig="${esc(g.id)}" title="${esc(g.title)}">${AVAILABILITY[g.availability] ? `<i class="av-dot ${AVAILABILITY[g.availability][0]}"></i>` : ''}${g._fav ? '🤘 ' : ''}${esc(g.title)}</button>`
        )
        .join('');
      // Overflow collapses into "+N more" — clicking the day shows everything
      const more = dayGigs.length > 4 ? `<span class="cal-more">+${dayGigs.length - 4} more</span>` : '';
      html += `<div class="cal-day${outside ? ' outside' : ''}${iso === todayISO ? ' today' : ''}${dayGigs.length ? ' has-events' : ''}" data-date="${iso}"><span class="cal-day-num">${day.getDate()}</span>${chips}${more}</div>`;
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
    $('#sort-filter').hidden = state.view !== 'list'; // calendar is inherently date-ordered
    renderPanels();
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
    // Any filter change starts the list from the first page again
    const applyFilter = (mutate) => { mutate(); state.listLimit = LIST_PAGE; render(); };
    $('#btn-list').addEventListener('click', () => { state.view = 'list'; location.hash = ''; render(); });
    $('#btn-calendar').addEventListener('click', () => { state.view = 'calendar'; location.hash = 'calendar'; render(); });
    // Debounced so fast typing doesn't re-render per keystroke (janky on phones)
    let searchTimer;
    $('#search').addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => applyFilter(() => { state.q = e.target.value; }), 200);
    });
    $('#sort-filter').addEventListener('change', (e) => applyFilter(() => { state.sort = e.target.value; }));
    $('#country-filter').addEventListener('change', (e) => applyFilter(() => { state.country = e.target.value; }));
    $('#genre-filter').addEventListener('change', (e) => applyFilter(() => { state.genre = e.target.value; }));
    $('#avail-filter').addEventListener('change', (e) => applyFilter(() => { state.avail = e.target.value; }));
    $('#type-filter').addEventListener('change', (e) => applyFilter(() => { state.type = e.target.value; }));
    $('#fav-only').addEventListener('change', (e) => applyFilter(() => { state.favOnly = e.target.checked; }));
    $('#list-view').addEventListener('click', (e) => {
      if (e.target.closest('#show-more')) {
        state.listLimit += 2 * LIST_PAGE;
        render();
      }
    });
    $('#cal-prev').addEventListener('click', () => { state.month = new Date(state.month.getFullYear(), state.month.getMonth() - 1, 1); render(); });
    $('#cal-next').addEventListener('click', () => { state.month = new Date(state.month.getFullYear(), state.month.getMonth() + 1, 1); render(); });
    $('#cal-today').addEventListener('click', () => { const n = new Date(); state.month = new Date(n.getFullYear(), n.getMonth(), 1); render(); });
    $('#calendar-grid').addEventListener('click', (e) => {
      const chip = e.target.closest('.cal-chip');
      if (chip) return openModal(chip.dataset.gig);
      const day = e.target.closest('.cal-day.has-events');
      if (day) openDayModal(day.dataset.date);
    });
    for (const base of ['latest', 'onsale']) {
      $(`#${base}-list`).addEventListener('click', (e) => {
        const item = e.target.closest('.p-item');
        if (item) openModal(item.dataset.gig);
      });
      $(`#${base}-toggle`).addEventListener('click', (e) => {
        const list = $(`#${base}-list`);
        const collapsed = list.classList.toggle('collapsed');
        e.target.textContent = collapsed ? e.target.dataset.seeAll : 'Show less';
      });
    }
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
    // The tracker is rock/metal only: drop anything that got no category from
    // its classifications (fuzzy API matches: pop, theatre, sport, …) unless
    // it's one of the favourite bands, which are welcome regardless of genre.
    gigs = gigs.filter((g) => g._fav || g._cat);

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

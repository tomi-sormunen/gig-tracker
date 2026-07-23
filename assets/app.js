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
    savedOnly: false,
    sort: '', // '' = gig date | 'added' = firstSeen desc | 'onsale' = sale date
    month: null, // Date at the 1st of the displayed calendar month
    listLimit: LIST_PAGE,
  };

  let allGigs = []; // every event from the data file (post-categorisation)
  let gigs = []; // the in-scope working set (favourites + rock/metal)
  let favNames = [];
  let favRawNames = [];
  let newBadgeDays = 7;

  // Saved ("★") and hidden events live in localStorage, per browser.
  const store = {
    read: (key) => {
      try { return new Set(JSON.parse(localStorage.getItem(key)) || []); } catch { return new Set(); }
    },
    write: (key, set) => localStorage.setItem(key, JSON.stringify([...set])),
  };
  const savedIds = store.read('gt-saved');
  const hiddenIds = store.read('gt-hidden');

  // User settings (Settings panel): home location + radius, trip distance,
  // and per-favourite enable/disable. All local to this browser.
  const DEFAULT_SETTINGS = { home: null, radius: 0, tripKm: 300, disabledFavs: [] };
  let settings = { ...DEFAULT_SETTINGS };
  try {
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('gt-settings') || '{}') };
  } catch { /* corrupted storage — fall back to defaults */ }
  const saveSettings = () => localStorage.setItem('gt-settings', JSON.stringify(settings));

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
  // real band. Favourites disabled in Settings don't count.
  const activeFavNames = () => favNames.filter((n) => !settings.disabledFavs.includes(n));

  // Recompute favourite flags and the in-scope set — run at load and
  // whenever a favourite is toggled in Settings.
  function recomputeFavs() {
    const active = activeFavNames();
    for (const g of allGigs) g._fav = g.bands.some((b) => active.includes(norm(b)));
    gigs = allGigs.filter((g) => g._fav || g._cat);
  }
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
      if (hiddenIds.has(g.id)) return false;
      if (state.savedOnly && !savedIds.has(g.id)) return false;
      if (state.country && g.country !== state.country) return false;
      if (state.genre && g._cat !== state.genre) return false;
      // Home + radius from Settings: a location filter can only judge events
      // that carry coordinates, so coordless ones are excluded while active.
      if (settings.radius > 0 && settings.home) {
        if (g.lat == null || g.lon == null || haversineKm(settings.home, g) > settings.radius) return false;
      }
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
    renderTrips(visible);
  }

  /* ---------- trip planner ---------- */
  const haversineKm = (a, b) => {
    const rad = Math.PI / 180;
    const h =
      Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 +
      Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lon - a.lon) * rad) / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(h));
  };

  // Chains favourite/saved gigs that are ≤2 days and ≤300 km apart into
  // weekend-trip suggestions ("Gojira Fri in Hamburg + Meshuggah Sat in
  // Copenhagen"). Needs venue coordinates, so only gigs with lat/lon count.
  function renderTrips(visible) {
    const empty =
      'No favourite or saved gigs close together in time and place right now — ★-save gigs to feed the planner.';
    const cands = visible
      .filter((g) => (g._fav || savedIds.has(g.id)) && g.lat != null && g.lon != null)
      .sort((a, b) => a.date.localeCompare(b.date));
    const clusters = [];
    for (const g of cands) {
      const cluster = clusters.find((c) => {
        const last = c[c.length - 1];
        const days = (parseDate(g.date) - parseDate(last.date)) / 86400_000;
        return days <= 2 && haversineKm(last, g) <= settings.tripKm;
      });
      if (cluster) cluster.push(g);
      else clusters.push([g]);
    }
    // A trip needs stops by DIFFERENT bands — following one band's (or one
    // co-headline tour's) route through two cities isn't a combo. Any shared
    // band between two stops means they're the same act, so each kept stop
    // must have a fully disjoint lineup from the ones before it. This also
    // collapses duplicate listings of the same show (VIP packages, day
    // tickets) into a single stop.
    const bandsOf = (g) => (g.bands.length ? g.bands : [g.title]).map(norm);
    const trips = clusters
      .map((c) => {
        const kept = [];
        for (const g of c) {
          if (!kept.some((k) => bandsOf(k).some((b) => bandsOf(g).includes(b)))) kept.push(g);
        }
        return kept;
      })
      .filter((c) => c.length >= 2);
    const rows = trips.map((c) => {
      const short = (iso) => parseDate(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      const range = c[0].date === c[c.length - 1].date ? fmtDay(c[0].date) : `${short(c[0].date)} – ${fmtDay(c[c.length - 1].date)}`;
      let km = 0;
      for (let i = 1; i < c.length; i++) km += haversineKm(c[i - 1], c[i]);
      const parts = c
        .map(
          (g) =>
            `<button class="p-gig" data-gig="${esc(g.id)}">${g._fav ? '🤘' : '★'} ${esc(shortName(g))}</button><span class="p-detail"> (${esc(g.city)} ${flag(g.country)})</span>`
        )
        .join('<span class="p-detail"> + </span>');
      return {
        item: `<li class="p-item p-trip"><span class="p-detail">${range} · </span>${parts}${km >= 1 ? `<span class="p-detail"> · ~${Math.round(km)} km apart</span>` : ''}</li>`,
      };
    });
    fillPanel('trips', rows, rows.length, empty);
  }

  /* ---------- cards ---------- */
  const AVAILABILITY = {
    available: ['av-green', 'Tickets available'],
    limited: ['av-yellow', 'Low capacity'],
    soldout: ['av-red', 'Sold out'],
  };

  const CURRENCY_SYMBOLS = { EUR: '€', GBP: '£', SEK: 'kr', NOK: 'kr', DKK: 'kr', PLN: 'zł', CZK: 'Kč', CHF: 'CHF', HUF: 'Ft' };

  function priceHTML(g) {
    if (g.priceMin == null) return '';
    const sym = CURRENCY_SYMBOLS[g.currency] || g.currency || '';
    const range =
      g.priceMax && g.priceMax !== g.priceMin ? `${g.priceMin}–${g.priceMax}` : `from ${g.priceMin}`;
    return `<div class="card-when">💶 ${esc(range)} ${esc(sym)}</div>`;
  }

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
        <div class="card-actions">
          <button class="icon-btn save-btn${savedIds.has(g.id) ? ' active' : ''}" data-save="${esc(g.id)}" title="Save to my list">${savedIds.has(g.id) ? '★' : '☆'}</button>
          <button class="icon-btn" data-hide="${esc(g.id)}" title="Hide this event">✕</button>
        </div>
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
          ${priceHTML(g)}
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

  function updateHiddenNote() {
    const btn = $('#reset-hidden');
    btn.hidden = hiddenIds.size === 0;
    btn.textContent = `Unhide ${hiddenIds.size} hidden event${hiddenIds.size > 1 ? 's' : ''}`;
  }

  /* ---------- .ics export (saved gigs, or the current selection) ---------- */
  const icsEscape = (s) =>
    String(s ?? '').replace(/\\/g, '\\\\').replace(/[,;]/g, '\\$&').replace(/\n/g, '\\n');

  function exportICS() {
    const source = savedIds.size ? gigs.filter((g) => savedIds.has(g.id)) : filteredGigs();
    if (!source.length) return alert('Nothing to export — save some gigs with ★ first.');
    if (source.length > 500) {
      return alert(`That would export ${source.length} events. Narrow the filters or use ★ to save the gigs you care about, then export again.`);
    }
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//gig-tracker//EN', 'X-WR-CALNAME:Gig Tracker'];
    for (const g of source) {
      lines.push(
        'BEGIN:VEVENT',
        `UID:${g.id}@gig-tracker`,
        `DTSTART;VALUE=DATE:${g.date.replace(/-/g, '')}`,
        `SUMMARY:${icsEscape(g.title)}`,
        `LOCATION:${icsEscape([g.venue, g.city, g.country].filter(Boolean).join(', '))}`,
        `DESCRIPTION:${icsEscape([g.bands.join(' · '), g.url].filter(Boolean).join('\n'))}`,
        'END:VEVENT'
      );
    }
    lines.push('END:VCALENDAR');
    const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar' });
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: 'gig-tracker.ics',
    });
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /* ---------- map view ---------- */
  let map = null;
  let markersLayer = null;

  function mapPopupHTML(cityGigs) {
    const sorted = [...cityGigs].sort((a, b) => a.date.localeCompare(b.date));
    const items = sorted
      .slice(0, 8)
      .map(
        (g) => `<div class="map-pop-item">${g._fav ? '🤘 ' : ''}<a href="${esc(g.url) || '#'}" target="_blank" rel="noopener">${esc(shortName(g))}</a> <span>${parseDate(g.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span></div>`
      )
      .join('');
    const more = sorted.length > 8 ? `<div class="map-pop-more">…and ${sorted.length - 8} more</div>` : '';
    return `<div class="map-pop"><div class="map-pop-city">${esc(sorted[0].city)} ${flag(sorted[0].country)} · ${sorted.length} gig${sorted.length > 1 ? 's' : ''}</div>${items}${more}</div>`;
  }

  // One circle per city, sized by gig count; gold when a favourite or saved
  // gig is in town. Only events with venue coordinates can be plotted.
  function renderMap() {
    if (typeof L === 'undefined') return;
    if (!map) {
      map = L.map('map').setView([51, 12], 4);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(map);
      markersLayer = L.layerGroup().addTo(map);
    }
    setTimeout(() => map.invalidateSize(), 0); // the section was display:none a moment ago
    markersLayer.clearLayers();
    const byCity = new Map();
    for (const g of filteredGigs()) {
      if (g.lat == null || g.lon == null) continue;
      const key = `${norm(g.city)}|${g.country}`;
      if (!byCity.has(key)) byCity.set(key, []);
      byCity.get(key).push(g);
    }
    for (const cityGigs of byCity.values()) {
      const first = cityGigs[0];
      const special = cityGigs.some((g) => g._fav || savedIds.has(g.id));
      L.circleMarker([first.lat, first.lon], {
        radius: Math.min(6 + Math.sqrt(cityGigs.length) * 2.2, 22),
        color: special ? '#ffc247' : '#ff4438',
        weight: special ? 2 : 1,
        fillColor: special ? '#ffc247' : '#a32c24',
        fillOpacity: 0.55,
      })
        .bindPopup(mapPopupHTML(cityGigs), { maxWidth: 320 })
        .addTo(markersLayer);
    }
  }

  /* ---------- render root ---------- */
  function render() {
    $('#btn-list').classList.toggle('active', state.view === 'list');
    $('#btn-calendar').classList.toggle('active', state.view === 'calendar');
    $('#btn-map').classList.toggle('active', state.view === 'map');
    $('#list-view').hidden = state.view !== 'list';
    $('#calendar-view').hidden = state.view !== 'calendar';
    $('#map-view').hidden = state.view !== 'map';
    $('#sort-ctl').hidden = state.view !== 'list'; // only the list can re-sort
    renderPanels();
    if (state.view === 'list') renderList();
    else if (state.view === 'calendar') renderCalendar();
    else {
      $('#empty-state').hidden = true;
      renderMap();
    }
  }

  function populateCountryFilter() {
    const seen = [...new Set(gigs.map((g) => g.country).filter(Boolean))]
      .map((cc) => [cc, countryName(cc)])
      .sort((a, b) => a[1].localeCompare(b[1]));
    $('#country-filter').innerHTML =
      '<option value="">All</option>' +
      seen.map(([cc, name]) => `<option value="${cc}">${flag(cc)} ${esc(name)}</option>`).join('');
  }

  /* ---------- settings panel ---------- */
  let cityOptions = [];

  function populateSettings() {
    // Home locations: every city in the data that has coordinates
    const byCity = new Map();
    for (const g of allGigs) {
      if (g.lat == null || g.lon == null || !g.city) continue;
      const key = `${norm(g.city)}|${g.country}`;
      if (!byCity.has(key)) byCity.set(key, { label: `${g.city} ${flag(g.country)}`, lat: g.lat, lon: g.lon });
    }
    cityOptions = [...byCity.values()].sort((a, b) => a.label.localeCompare(b.label));
    const homeSel = $('#set-home');
    homeSel.innerHTML =
      '<option value="">Not set</option>' +
      cityOptions.map((c, i) => `<option value="${i}">${esc(c.label)}</option>`).join('');
    if (settings.home) {
      const idx = cityOptions.findIndex((c) => c.label === settings.home.label);
      if (idx >= 0) homeSel.value = String(idx);
    }
    $('#set-radius').value = String(settings.radius);
    $('#set-trip').value = String(settings.tripKm);

    // Favourite band toggles (deduped, original casing kept)
    const seen = new Map();
    for (const name of favRawNames) if (!seen.has(norm(name))) seen.set(norm(name), name);
    $('#fav-chips').innerHTML = [...seen.entries()]
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(
        ([key, label]) =>
          `<button class="fav-chip${settings.disabledFavs.includes(key) ? '' : ' active'}" data-fav="${esc(key)}">${esc(label)}</button>`
      )
      .join('');
  }

  function settingsChanged() {
    saveSettings();
    renderTicker();
    render();
  }

  function wireSettings() {
    $('#set-home').addEventListener('change', (e) => {
      settings.home = e.target.value === '' ? null : cityOptions[Number(e.target.value)];
      settingsChanged();
    });
    $('#set-radius').addEventListener('change', (e) => {
      settings.radius = Number(e.target.value);
      settingsChanged();
    });
    $('#set-trip').addEventListener('change', (e) => {
      settings.tripKm = Number(e.target.value);
      settingsChanged();
    });
    $('#fav-chips').addEventListener('click', (e) => {
      const chip = e.target.closest('.fav-chip');
      if (!chip) return;
      const key = chip.dataset.fav;
      const idx = settings.disabledFavs.indexOf(key);
      if (idx >= 0) settings.disabledFavs.splice(idx, 1);
      else settings.disabledFavs.push(key);
      chip.classList.toggle('active', idx >= 0);
      recomputeFavs();
      settingsChanged();
    });
    $('#set-reset').addEventListener('click', () => {
      settings = { ...DEFAULT_SETTINGS, disabledFavs: [] };
      saveSettings();
      populateSettings();
      recomputeFavs();
      renderTicker();
      render();
    });
  }

  function wireEvents() {
    wireSettings();
    // Any filter change starts the list from the first page again
    const applyFilter = (mutate) => { mutate(); state.listLimit = LIST_PAGE; render(); };
    $('#btn-list').addEventListener('click', () => { state.view = 'list'; location.hash = ''; render(); });
    $('#btn-calendar').addEventListener('click', () => { state.view = 'calendar'; location.hash = 'calendar'; render(); });
    $('#btn-map').addEventListener('click', () => { state.view = 'map'; location.hash = 'map'; render(); });
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
    $('#saved-only').addEventListener('change', (e) => applyFilter(() => { state.savedOnly = e.target.checked; }));

    // Save/hide buttons appear on every card (list, modal, day modal) —
    // one body-level listener covers them all.
    document.body.addEventListener('click', (e) => {
      const saveBtn = e.target.closest('[data-save]');
      if (saveBtn) {
        const id = saveBtn.dataset.save;
        savedIds.has(id) ? savedIds.delete(id) : savedIds.add(id);
        store.write('gt-saved', savedIds);
        document.querySelectorAll(`[data-save="${CSS.escape(id)}"]`).forEach((b) => {
          b.classList.toggle('active', savedIds.has(id));
          b.textContent = savedIds.has(id) ? '★' : '☆';
        });
        if (state.savedOnly) render();
        return;
      }
      const hideBtn = e.target.closest('[data-hide]');
      if (hideBtn) {
        hiddenIds.add(hideBtn.dataset.hide);
        store.write('gt-hidden', hiddenIds);
        updateHiddenNote();
        const dlg = $('#gig-modal');
        if (dlg.open) dlg.close();
        render();
      }
    });
    $('#reset-hidden').addEventListener('click', () => {
      hiddenIds.clear();
      store.write('gt-hidden', hiddenIds);
      updateHiddenNote();
      render();
    });
    $('#export-ics').addEventListener('click', exportICS);
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
    for (const base of ['latest', 'onsale', 'trips']) {
      $(`#${base}-list`).addEventListener('click', (e) => {
        const gigBtn = e.target.closest('.p-gig');
        if (gigBtn) return openModal(gigBtn.dataset.gig);
        const item = e.target.closest('.p-item');
        if (item?.dataset.gig) openModal(item.dataset.gig);
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
    favRawNames = (await favRes.json()).bands || [];
    favNames = favRawNames.map(norm).filter(Boolean);

    // The tracker is rock/metal only: recomputeFavs drops anything that got
    // no category from its classifications (fuzzy API matches: pop, theatre,
    // sport, …) unless it's one of the enabled favourite bands, which are
    // welcome regardless of genre.
    allGigs = (data.gigs || []).map((g) => ({ ...g, _fav: false, _cat: categoryOf(g) }));
    recomputeFavs();

    const updated = new Date(data.updatedAt);
    $('#updated-at').textContent = `Updated ${updated.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
    $('#sample-banner').hidden = data.source !== 'sample';

    const now = new Date();
    state.month = new Date(now.getFullYear(), now.getMonth(), 1);
    if (location.hash === '#calendar') state.view = 'calendar';
    if (location.hash === '#map') state.view = 'map';

    populateCountryFilter();
    populateSettings();
    wireEvents();
    updateHiddenNote();
    renderTicker();
    render();
  }

  // Installable app + offline fallback (GitHub Pages only; skipped locally)
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  init().catch((err) => {
    $('#list-view').innerHTML = `<p class="empty-state">Failed to load gig data: ${esc(err.message)}.<br>
      Serve this folder over HTTP (e.g. <code>npm run serve</code>) — browsers block JSON loading from file:// URLs.</p>`;
    console.error(err);
  });
})();

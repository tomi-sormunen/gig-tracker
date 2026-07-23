#!/usr/bin/env node
// Fetches upcoming rock/metal gigs and festivals across Europe into data/gigs.json.
//
// Primary source:  Ticketmaster Discovery API (free key, 5000 calls/day, 5 req/s)
//                  https://developer.ticketmaster.com/products-and-docs/apis/discovery-api/v2/
// Optional source: Bandsintown artist events (requires an approved app_id)
//
// Usage:
//   TICKETMASTER_API_KEY=xxx node scripts/fetch-gigs.mjs
//   TICKETMASTER_API_KEY=xxx BANDSINTOWN_APP_ID=yyy node scripts/fetch-gigs.mjs

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = path.join(ROOT, 'data', 'gigs.json');

const config = JSON.parse(readFileSync(path.join(ROOT, 'config', 'config.json'), 'utf8'));
const rawFavourites = JSON.parse(readFileSync(path.join(ROOT, 'config', 'favourites.json'), 'utf8')).bands;

const API_KEY = process.env.TICKETMASTER_API_KEY;

const TM_HOST = 'https://app.ticketmaster.com';
const EUROPE = new Set(config.europeanCountries);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) =>
  (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// Dedupe the favourites list (case/diacritic-insensitive) so repeated
// entries don't cost duplicate API calls.
const favourites = [...new Map(rawFavourites.map((n) => [norm(n), n])).values()];
const FAVOURITE_SET = new Set(favourites.map(norm));
const isFavouriteGig = (gig) => gig.bands.some((b) => FAVOURITE_SET.has(norm(b)));

// Ticketmaster's classificationName matching is fuzzy keyword search — a "rock"
// sweep returns plenty of pop, theatre, and even sport. Keep an event only when
// its own genre/subgenre actually matches the allow list (favourites are exempt
// from all genre rules, and excludeGenres vetoes on the genre field).
function inScope(gig) {
  if (isFavouriteGig(gig)) return true;
  const genre = norm(gig.genre);
  if (config.excludeGenres.some((x) => genre.includes(norm(x)))) return false;
  const classification = `${genre} ${norm(gig.subGenre)}`;
  return config.allowGenres.some((x) => classification.includes(norm(x)));
}

async function tmGet(endpoint, params) {
  const url = new URL(`${TM_HOST}${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('apikey', API_KEY);

  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url);
    await sleep(250); // stay under the 5 req/s limit
    if (res.status === 429) {
      await sleep(1500 * 2 ** attempt);
      continue;
    }
    if (!res.ok) throw new Error(`Ticketmaster ${res.status} ${res.statusText} for ${endpoint}`);
    return res.json();
  }
  throw new Error(`Ticketmaster rate limit persisted for ${endpoint}`);
}

// Paginated event search. Deep paging is capped by Ticketmaster at size*page < 1000.
async function searchEvents(params) {
  const events = [];
  for (let page = 0; page < config.maxPagesPerQuery; page++) {
    const data = await tmGet('/discovery/v2/events.json', { ...params, size: 200, page, sort: 'date,asc' });
    events.push(...(data._embedded?.events ?? []));
    if (page >= Math.min((data.page?.totalPages ?? 1), config.maxPagesPerQuery) - 1) break;
  }
  return events;
}

function pickImage(images = []) {
  const wide = images
    .filter((i) => i.ratio === '16_9' && i.width >= 500 && !i.fallback)
    .sort((a, b) => a.width - b.width);
  return wide[0]?.url ?? images.find((i) => !i.fallback)?.url ?? images[0]?.url ?? null;
}

function mapTmEvent(ev) {
  const venue = ev._embedded?.venues?.[0] ?? {};
  const bands = (ev._embedded?.attractions ?? []).map((a) => a.name).filter(Boolean);
  const cls = ev.classifications?.find((c) => c.primary) ?? ev.classifications?.[0] ?? {};
  const price = (ev.priceRanges ?? []).find((p) => p.type === 'standard') ?? ev.priceRanges?.[0];
  return {
    priceMin: price?.min ?? null,
    priceMax: price?.max ?? null,
    currency: price?.currency ?? null,
    lat: venue.location?.latitude ? Number(venue.location.latitude) : null,
    lon: venue.location?.longitude ? Number(venue.location.longitude) : null,
    id: `tm-${ev.id}`,
    title: ev.name,
    bands: bands.length ? bands : [ev.name],
    date: ev.dates?.start?.localDate ?? null,
    time: ev.dates?.start?.localTime?.slice(0, 5) ?? null,
    venue: venue.name ?? null,
    city: venue.city?.name ?? null,
    country: venue.country?.countryCode ?? null,
    genre: cls.genre?.name ?? null,
    subGenre: cls.subGenre?.name && cls.subGenre.name !== 'Undefined' ? cls.subGenre.name : null,
    url: ev.url ?? null,
    image: pickImage(ev.images),
    isFestival: /\bfest(ival)?\b|open air/i.test(ev.name),
    onSaleDate: ev.sales?.public?.startDateTime ?? null,
    status: ev.dates?.status?.code ?? null,
    availability: null, // filled in by fetchAvailability
  };
}

// Traffic-light data from the Inventory Status API. Supported for events in
// AT BE CH CZ DE DK ES FI GB IE NL NO PL SE (plus US/CA/AU/NZ/MX) — events in
// unsupported markets simply come back without a status and stay null.
const INVENTORY_STATUS = {
  TICKETS_AVAILABLE: 'available',
  FEW_TICKETS_LEFT: 'limited',
  TICKETS_NOT_AVAILABLE: 'soldout',
};

async function fetchAvailability(found) {
  const tmIds = [...found.values()].filter((g) => g.id.startsWith('tm-')).map((g) => g.id.slice(3));
  console.log(`Inventory status for ${tmIds.length} events:`);
  let known = 0;
  for (let i = 0; i < tmIds.length; i += 40) {
    const batch = tmIds.slice(i, i + 40);
    try {
      const data = await tmGet('/inventory-status/v1/availability', { events: batch.join(',') });
      for (const entry of Array.isArray(data) ? data : []) {
        const gig = found.get(`tm-${entry.eventId}`);
        const availability = INVENTORY_STATUS[entry.status];
        if (gig && availability) {
          gig.availability = availability;
          known++;
        }
      }
    } catch (err) {
      if (err.message.includes('401')) {
        console.warn(
          '  Inventory Status API rejected this key (401) — it is a separate, restricted\n' +
          '  Ticketmaster product. Request access via devportalinquiry@ticketmaster.com;\n' +
          '  until then availability uses the offsale fallback only.'
        );
        return;
      }
      console.warn(`  batch ${i / 40 + 1}: skipped (${err.message})`);
    }
  }
  console.log(`  ${known} events with a known inventory status`);
}

async function fetchGenreSweep(startISO, endISO) {
  const found = new Map();
  for (const country of config.countries) {
    for (const genre of config.classifications) {
      try {
        const events = await searchEvents({
          classificationName: genre,
          countryCode: country,
          startDateTime: startISO,
          endDateTime: endISO,
        });
        let kept = 0;
        for (const ev of events) {
          const gig = mapTmEvent(ev);
          if (gig.date && inScope(gig)) {
            found.set(gig.id, gig);
            kept++;
          }
        }
        console.log(`  ${country}/${genre}: ${events.length} events, ${kept} in scope`);
      } catch (err) {
        console.warn(`  ${country}/${genre}: skipped (${err.message})`);
      }
    }
  }
  return found;
}

// Favourite bands are tracked Europe-wide with no genre restriction. Their
// attraction images also backfill events that ship without one of their own.
async function fetchFavourites(found, startISO, endISO) {
  const favImages = new Map();
  for (const name of favourites) {
    try {
      const search = await tmGet('/discovery/v2/attractions.json', { keyword: name, size: 5 });
      const match = (search._embedded?.attractions ?? []).find((a) => norm(a.name) === norm(name));
      if (!match) {
        console.log(`  ${name}: no exact attraction match, relying on genre sweep`);
        continue;
      }
      const img = pickImage(match.images);
      if (img) favImages.set(norm(name), img);
      const events = await searchEvents({
        attractionId: match.id,
        startDateTime: startISO,
        endDateTime: endISO,
      });
      let added = 0;
      for (const ev of events) {
        const gig = mapTmEvent(ev);
        if (gig.date && EUROPE.has(gig.country) && !found.has(gig.id)) {
          found.set(gig.id, gig);
          added++;
        }
      }
      console.log(`  ${name}: ${events.length} events, ${added} new European`);
    } catch (err) {
      console.warn(`  ${name}: skipped (${err.message})`);
    }
  }
  let backfilled = 0;
  for (const gig of found.values()) {
    if (gig.image) continue;
    const img = gig.bands.map((b) => favImages.get(norm(b))).find(Boolean);
    if (img) {
      gig.image = img;
      backfilled++;
    }
  }
  if (backfilled) console.log(`  backfilled ${backfilled} event images from favourite bands`);
}

// Some Ticketmaster markets attach artists to listings inconsistently — a
// Helsinki stop of a tour may not link Lamb of God as an attraction even
// though the name is right there in the listing title — which makes those
// events invisible to the attraction-based favourite lookup. This keyword
// sweep catches them: an event is kept only when the favourite's name
// genuinely appears in its title/lineup text (the API's keyword matching is
// fuzzier than that), and title-only mentions must still pass the genre
// rules so tribute acts that name-drop the real band don't slip in.
async function fetchFavouriteKeywords(found, startISO, endISO) {
  console.log('Favourite keyword sweep:');
  for (const name of favourites) {
    try {
      const events = await searchEvents({ keyword: name, startDateTime: startISO, endDateTime: endISO });
      let added = 0;
      for (const ev of events) {
        const gig = mapTmEvent(ev);
        if (!gig.date || !EUROPE.has(gig.country) || found.has(gig.id)) continue;
        const text = ` ${norm(`${gig.title} ${gig.bands.join(' ')}`)} `;
        if (!text.includes(` ${norm(name)} `)) continue;
        if (!isFavouriteGig(gig) && !inScope(gig)) continue;
        found.set(gig.id, gig);
        added++;
      }
      if (added) console.log(`  ${name}: ${added} extra events via keyword`);
    } catch (err) {
      console.warn(`  ${name}: keyword sweep skipped (${err.message})`);
    }
  }
}

/* ---------- Skiddle (UK live music, free public API) ---------- */

// Shared genre gate for keyword/aggregator sources: keep only events whose
// genre text matches the allow list and no exclude term.
function genresInScope(genreNames) {
  const text = genreNames.map(norm).join(' ');
  if (!text) return false;
  if (config.excludeGenres.some((x) => text.includes(norm(x)))) return false;
  return config.allowGenres.some((x) => text.includes(norm(x)));
}

function mapSkiddleEvent(ev, eventcode) {
  if (!ev?.date || !ev?.id) return null;
  const venue = ev.venue ?? {};
  const artists = (ev.artists ?? []).map((a) => a.name).filter(Boolean);
  const genres = (ev.genres ?? []).map((g) => g.name).filter(Boolean);
  const price = parseFloat(String(ev.entryprice ?? '').replace(/[^\d.]/g, ''));
  return {
    id: `sk-${ev.id}`,
    title: ev.eventname,
    bands: artists.length ? artists : [ev.eventname],
    date: ev.date,
    time: ev.openingtimes?.doorsopen || null,
    venue: venue.name ?? null,
    city: venue.town ?? null,
    country: 'GB',
    genre: genres[0] ?? null,
    subGenre: genres[1] ?? null,
    url: ev.link ?? null,
    image: ev.largeimageurl ?? ev.imageurl ?? null,
    isFestival: eventcode === 'FEST' || /\bfest(ival)?\b|open air/i.test(ev.eventname ?? ''),
    onSaleDate: null,
    status: null,
    availability: null,
    priceMin: Number.isFinite(price) && price > 0 ? price : null,
    priceMax: null,
    currency: 'GBP',
    lat: venue.latitude ? Number(venue.latitude) : null,
    lon: venue.longitude ? Number(venue.longitude) : null,
    _genres: genres, // used for scoping, stripped before writing
  };
}

// Skiddle covers the UK's club/venue circuit that Ticketmaster misses.
// Free key from https://www.skiddle.com/api/join.php (SKIDDLE_API_KEY).
async function fetchSkiddle(found) {
  const key = process.env.SKIDDLE_API_KEY;
  if (!key) return;
  console.log('Skiddle (UK live music):');
  const today = new Date();
  const minDate = today.toISOString().slice(0, 10);
  const maxDate = new Date(today.getTime() + config.lookAheadDays * 86400_000).toISOString().slice(0, 10);
  for (const eventcode of ['LIVE', 'FEST']) {
    let offset = 0;
    let total = Infinity;
    let kept = 0;
    try {
      while (offset < Math.min(total, 5000)) {
        const url = new URL('https://www.skiddle.com/api/v1/events/search/');
        for (const [k, v] of Object.entries({
          api_key: key, country: 'GB', eventcode, minDate, maxDate,
          limit: 100, offset, order: 'date', description: 1,
        })) url.searchParams.set(k, v);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        total = Number(data.totalcount ?? 0);
        const events = data.results ?? [];
        if (!events.length) break;
        for (const ev of events) {
          const gig = mapSkiddleEvent(ev, eventcode);
          if (!gig || found.has(gig.id)) continue;
          if (isFavouriteGig(gig) || genresInScope(gig._genres)) {
            found.set(gig.id, gig);
            kept++;
          }
        }
        offset += 100;
        await sleep(350);
      }
      console.log(`  ${eventcode}: ${kept} in scope of ${total} events`);
    } catch (err) {
      console.warn(`  ${eventcode}: stopped at offset ${offset} (${err.message})`);
    }
  }
}

/* ---------- JamBase (concert/festival aggregator, free tier) ---------- */

// JamBase returns Schema.org (JSON-LD) event objects, so fields are read
// defensively: addressCountry can be an ISO2 string or a { identifier, name }
// object; performer/offers/image may be single values or arrays.
const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

function resolveCountryCode(addressCountry) {
  if (!addressCountry) return null;
  const id = typeof addressCountry === 'string' ? addressCountry : addressCountry.identifier || addressCountry.name || '';
  if (/^[A-Z]{2}$/.test(id)) return id;
  const name = typeof addressCountry === 'string' ? addressCountry : addressCountry.name;
  return BIT_COUNTRIES[norm(name)] ?? null;
}

function mapJamBaseEvent(ev) {
  const start = ev?.startDate;
  const rawId = ev?.identifier ?? ev?.['@id'] ?? ev?.url;
  if (!start || !rawId) return null;
  const place = ev.location ?? {};
  const addr = place.address ?? {};
  const performers = asArray(ev.performer).map((p) => p?.name).filter(Boolean);
  const offer = asArray(ev.offers)[0] ?? null;
  const image = typeof ev.image === 'string' ? ev.image : asArray(ev.image)[0]?.url ?? asArray(ev.image)[0] ?? null;
  // Genre may live on the event and/or its performers, as strings or objects.
  const genreStrings = [
    ...asArray(ev.genre),
    ...asArray(ev['x-genres']),
    ...asArray(ev.performer).flatMap((p) => asArray(p?.genre).concat(asArray(p?.['x-genres']))),
  ]
    .map((g) => (typeof g === 'string' ? g : g?.name))
    .filter(Boolean);
  const geo = place.geo ?? {};
  const price = offer?.price != null ? Number(offer.price) : null;
  return {
    id: `jb-${String(rawId).replace(/[^a-zA-Z0-9]+/g, '')}`,
    title: ev.name,
    bands: performers.length ? performers : [ev.name],
    date: start.slice(0, 10),
    time: /T\d{2}:\d{2}/.test(start) ? start.slice(11, 16) : null,
    venue: place.name ?? null,
    city: addr.addressLocality ?? null,
    country: resolveCountryCode(addr.addressCountry),
    genre: genreStrings[0] ?? null,
    subGenre: genreStrings[1] ?? null,
    url: offer?.url ?? ev.url ?? null,
    image,
    isFestival: ev['x-isFestival'] === true || /\bfest(ival)?\b|open air/i.test(ev.name ?? ''),
    onSaleDate: null,
    status: null,
    availability: null,
    priceMin: Number.isFinite(price) && price > 0 ? price : null,
    priceMax: null,
    currency: offer?.priceCurrency ?? null,
    lat: geo.latitude != null ? Number(geo.latitude) : null,
    lon: geo.longitude != null ? Number(geo.longitude) : null,
    _genres: genreStrings,
  };
}

// Sweeps the configured European markets by date range. Free key from
// https://data.jambase.com/ (JAMBASE_API_KEY). A User-Agent header is
// mandatory; the x-jb-api-requests-remaining header lets us stop before
// exhausting the quota.
async function fetchJamBase(found) {
  const key = process.env.JAMBASE_API_KEY;
  if (!key) return;
  console.log('JamBase (aggregator):');
  const today = new Date();
  const eventDateFrom = today.toISOString().slice(0, 10);
  const eventDateTo = new Date(today.getTime() + config.lookAheadDays * 86400_000).toISOString().slice(0, 10);
  for (const country of config.countries) {
    let page = 1;
    let kept = 0;
    try {
      while (page <= config.maxPagesPerQuery) {
        const url = new URL('https://www.jambase.com/jb-api/v1/events');
        for (const [k, v] of Object.entries({
          apikey: key, geoCountryIso2: country, eventDateFrom, eventDateTo, perPage: 50, page,
        })) url.searchParams.set(k, v);
        const res = await fetch(url, { headers: { 'user-agent': 'gig-tracker personal aggregator' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        for (const ev of data.events ?? []) {
          const gig = mapJamBaseEvent(ev);
          if (!gig || !gig.date || !EUROPE.has(gig.country) || found.has(gig.id)) continue;
          if (isFavouriteGig(gig) || genresInScope(gig._genres)) {
            found.set(gig.id, gig);
            kept++;
          }
        }
        const remaining = Number(res.headers.get('x-jb-api-requests-remaining'));
        if (Number.isFinite(remaining) && remaining <= 1) {
          console.log('  quota nearly exhausted — stopping JamBase early');
          return;
        }
        if (page >= (data.pagination?.totalPages ?? 1)) break;
        page++;
        await sleep(900); // free tier ~1 req/s
      }
      if (kept) console.log(`  ${country}: ${kept} in scope`);
    } catch (err) {
      console.warn(`  ${country}: stopped at page ${page} (${err.message})`);
    }
  }
}

/* ---------- custom iCal feeds (venues/festivals without an API) ---------- */

const hash = (s) => {
  let h = 5381;
  for (const c of s) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0;
  return h.toString(36);
};

// Minimal iCalendar parser: unfolds wrapped lines and pulls the fields we
// need out of each VEVENT. Deliberately forgiving — feeds in the wild vary.
function parseICS(text) {
  const lines = text.replace(/\r\n[ \t]/g, '').split(/\r?\n/);
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') cur = {};
    else if (line === 'END:VEVENT') {
      if (cur) events.push(cur);
      cur = null;
    } else if (cur) {
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      const prop = line.slice(0, idx).split(';')[0].toUpperCase();
      const value = line.slice(idx + 1).trim();
      if (prop === 'DTSTART') {
        const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2}))?/);
        if (m) {
          cur.date = `${m[1]}-${m[2]}-${m[3]}`;
          cur.time = m[4] ? `${m[4]}:${m[5]}` : null;
        }
      } else if (prop === 'SUMMARY') cur.summary = value.replace(/\\([,;])/g, '$1').replace(/\\n/gi, ' ');
      else if (prop === 'LOCATION') cur.location = value.replace(/\\([,;])/g, '$1');
      else if (prop === 'URL') cur.url = value;
      else if (prop === 'UID') cur.uid = value;
    }
  }
  return events;
}

// config/feeds.json lets any public .ics calendar act as a source — the
// pragmatic answer for vendors like Tiketti that offer no API: point this at
// venue/festival calendars instead. Feed events bypass the genre rules
// (adding the feed IS the opt-in) and use the feed's declared city/country.
async function fetchFeeds(found) {
  let feeds = [];
  try {
    feeds = JSON.parse(readFileSync(path.join(ROOT, 'config', 'feeds.json'), 'utf8')).feeds ?? [];
  } catch {
    return;
  }
  if (!feeds.length) return;
  console.log('Custom iCal feeds:');
  const today = new Date().toISOString().slice(0, 10);
  for (const feed of feeds) {
    try {
      const res = await fetch(feed.url, { headers: { 'user-agent': 'gig-tracker personal aggregator' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let added = 0;
      for (const ev of parseICS(await res.text())) {
        if (!ev.date || !ev.summary || ev.date < today) continue;
        const id = `feed-${hash(`${feed.url}|${ev.uid ?? `${ev.summary}${ev.date}`}`)}`;
        if (found.has(id)) continue;
        found.set(id, {
          id,
          title: ev.summary,
          bands: [ev.summary.split(/\s+[-–|:]\s+/)[0].trim() || ev.summary],
          date: ev.date,
          time: ev.time ?? null,
          venue: ev.location || feed.venue || null,
          city: feed.city ?? null,
          country: feed.country ?? null,
          genre: feed.genre ?? 'Rock',
          subGenre: null,
          url: ev.url ?? feed.website ?? null,
          image: null,
          isFestival: /\bfest(ival)?\b|open air/i.test(ev.summary),
          onSaleDate: null, status: null, availability: null,
          priceMin: null, priceMax: null, currency: null,
          lat: feed.lat ?? null,
          lon: feed.lon ?? null,
        });
        added++;
      }
      console.log(`  ${feed.label ?? feed.url}: ${added} events`);
    } catch (err) {
      console.warn(`  ${feed.label ?? feed.url}: skipped (${err.message})`);
    }
  }
}

/* ---------- cross-source dedupe ---------- */

// The same gig can be listed by several vendors. Two events from DIFFERENT
// sources on the same date in the same city that share a band count as one;
// the richer source wins (Ticketmaster > Skiddle > feeds > Bandsintown).
// Same-source listings are never merged (Ticketmaster's own VIP/day-ticket
// variants are handled elsewhere).
function dedupeAcrossSources(found) {
  const priority = { tm: 0, sk: 1, jb: 2, feed: 3, bit: 4 };
  const source = (g) => g.id.split('-')[0];
  const bandsOf = (g) => (g.bands.length ? g.bands : [g.title]).map(norm);
  const ordered = [...found.values()].sort(
    (a, b) => (priority[source(a)] ?? 9) - (priority[source(b)] ?? 9)
  );
  const buckets = new Map();
  const kept = new Map();
  let removed = 0;
  for (const g of ordered) {
    const bucketKey = `${g.date}|${norm(g.city)}`;
    const bucket = buckets.get(bucketKey) ?? [];
    const gBands = bandsOf(g);
    const dup = bucket.some((h) => source(h) !== source(g) && bandsOf(h).some((b) => gBands.includes(b)));
    if (dup) {
      removed++;
      continue;
    }
    bucket.push(g);
    buckets.set(bucketKey, bucket);
    kept.set(g.id, g);
  }
  if (removed) console.log(`Dedupe: dropped ${removed} cross-source duplicate listings`);
  return kept;
}

// Bandsintown venue.country is a full country name, not an ISO code.
const BIT_COUNTRIES = {
  austria: 'AT', belgium: 'BE', bulgaria: 'BG', croatia: 'HR', cyprus: 'CY', czechia: 'CZ',
  'czech republic': 'CZ', denmark: 'DK', estonia: 'EE', finland: 'FI', france: 'FR', germany: 'DE',
  greece: 'GR', hungary: 'HU', iceland: 'IS', ireland: 'IE', italy: 'IT', latvia: 'LV',
  lithuania: 'LT', luxembourg: 'LU', malta: 'MT', netherlands: 'NL', 'the netherlands': 'NL',
  norway: 'NO', poland: 'PL', portugal: 'PT', romania: 'RO', serbia: 'RS', slovakia: 'SK',
  slovenia: 'SI', spain: 'ES', sweden: 'SE', switzerland: 'CH', ukraine: 'UA',
  'united kingdom': 'GB', 'great britain': 'GB', uk: 'GB',
};

async function fetchBandsintown(found) {
  const appId = process.env.BANDSINTOWN_APP_ID;
  if (!appId) return;
  console.log('Bandsintown (favourites):');
  const dupKeys = new Set(
    [...found.values()].flatMap((g) => g.bands.map((b) => `${g.date}|${norm(g.city)}|${norm(b)}`))
  );
  for (const name of favourites) {
    try {
      const enc = encodeURIComponent(name);
      const [artistRes, eventsRes] = await Promise.all([
        fetch(`https://rest.bandsintown.com/artists/${enc}?app_id=${appId}`),
        fetch(`https://rest.bandsintown.com/artists/${enc}/events?app_id=${appId}&date=upcoming`),
      ]);
      if (!artistRes.ok || !eventsRes.ok) throw new Error(`HTTP ${artistRes.status}/${eventsRes.status}`);
      const artist = await artistRes.json();
      const events = await eventsRes.json();
      let added = 0;
      for (const ev of Array.isArray(events) ? events : []) {
        const country = BIT_COUNTRIES[norm(ev.venue?.country)];
        const date = ev.datetime?.slice(0, 10);
        if (!country || !date) continue;
        const key = `${date}|${norm(ev.venue?.city)}|${norm(name)}`;
        if (dupKeys.has(key)) continue; // already covered by Ticketmaster
        found.set(`bit-${ev.id}`, {
          id: `bit-${ev.id}`,
          title: ev.title || `${name} @ ${ev.venue?.name ?? ev.venue?.city}`,
          bands: [name, ...(ev.lineup ?? []).filter((b) => norm(b) !== norm(name))],
          date,
          time: ev.datetime?.slice(11, 16) || null,
          venue: ev.venue?.name ?? null,
          city: ev.venue?.city ?? null,
          country,
          genre: null,
          subGenre: null,
          url: (ev.offers ?? []).find((o) => o.type === 'Tickets')?.url ?? ev.url ?? null,
          image: artist?.thumb_url ?? null,
          isFestival: /\bfest(ival)?\b|open air/i.test(ev.title ?? ''),
          onSaleDate: null,
          status: null,
          availability: null,
          priceMin: null,
          priceMax: null,
          currency: null,
          lat: ev.venue?.latitude ? Number(ev.venue.latitude) : null,
          lon: ev.venue?.longitude ? Number(ev.venue.longitude) : null,
        });
        added++;
      }
      console.log(`  ${name}: ${added} extra gigs`);
      await sleep(300);
    } catch (err) {
      console.warn(`  ${name}: skipped (${err.message})`);
    }
  }
}

// Minimal iCalendar output. Hosted on GitHub Pages, data/favourites.ics is a
// subscribable calendar of every gig by a favourite band, refreshed daily.
const icsEscape = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/[,;]/g, '\\$&').replace(/\n/g, '\\n');

function buildICS(gigs, calName) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//gig-tracker//EN',
    `X-WR-CALNAME:${icsEscape(calName)}`,
  ];
  for (const g of gigs) {
    const date = g.date.replace(/-/g, '');
    lines.push(
      'BEGIN:VEVENT',
      `UID:${g.id}@gig-tracker`,
      `DTSTART;VALUE=DATE:${date}`,
      `SUMMARY:${icsEscape(g.title)}`,
      `LOCATION:${icsEscape([g.venue, g.city, g.country].filter(Boolean).join(', '))}`,
      `DESCRIPTION:${icsEscape([g.bands.join(' · '), g.url].filter(Boolean).join('\n'))}`,
      'END:VEVENT'
    );
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

async function main() {
  if (!API_KEY) {
    console.error(
      'TICKETMASTER_API_KEY is not set.\n\n' +
      'Get a free key at https://developer.ticketmaster.com/ (instant on signup), then run:\n' +
      '  TICKETMASTER_API_KEY=<your-key> npm run fetch\n\n' +
      'For the GitHub Actions daily refresh, add the key as a repository secret named TICKETMASTER_API_KEY.'
    );
    process.exit(1);
  }
  const now = new Date();
  const startISO = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const endISO = new Date(now.getTime() + config.lookAheadDays * 86400_000)
    .toISOString().replace(/\.\d{3}Z$/, 'Z');

  console.log(`Genre sweep (${config.classifications.join(', ')}) across ${config.countries.length} markets:`);
  const found = await fetchGenreSweep(startISO, endISO);
  console.log('Favourite bands (Europe-wide, any genre):');
  await fetchFavourites(found, startISO, endISO);
  await fetchFavouriteKeywords(found, startISO, endISO);
  await fetchSkiddle(found);
  await fetchJamBase(found);
  await fetchFeeds(found);
  await fetchBandsintown(found);
  const deduped = dedupeAcrossSources(found);
  found.clear();
  for (const [id, g] of deduped) found.set(id, g);
  await fetchAvailability(found);

  for (const [id, g] of found) {
    if (g.status === 'cancelled') found.delete(id);
    // Fallback when the Inventory Status API has no answer: an event marked
    // offsale whose public sale already started is almost certainly sold out.
    else if (!g.availability && g.status === 'offsale' && (!g.onSaleDate || g.onSaleDate <= startISO)) {
      g.availability = 'soldout';
    }
  }

  // Preserve firstSeen timestamps from the previous run so the "new" ticker works.
  let previousFirstSeen = new Map();
  if (existsSync(OUT_FILE)) {
    const prev = JSON.parse(readFileSync(OUT_FILE, 'utf8'));
    if (prev.source !== 'sample') {
      previousFirstSeen = new Map((prev.gigs ?? []).map((g) => [g.id, g.firstSeen]));
    }
  }

  const today = now.toISOString().slice(0, 10);
  const gigs = [...found.values()]
    .filter((g) => g.date >= today)
    .map(({ status, _genres, ...g }) => ({ ...g, firstSeen: previousFirstSeen.get(g.id) ?? now.toISOString() }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));

  mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify({ updatedAt: now.toISOString(), source: 'live', gigs }, null, 2) + '\n');
  const favGigs = gigs.filter(isFavouriteGig);
  writeFileSync(path.join(ROOT, 'data', 'favourites.ics'), buildICS(favGigs, 'Gig Tracker — Favourites'));
  console.log(`Wrote data/favourites.ics with ${favGigs.length} favourite-band gigs`);
  const newCount = gigs.filter((g) => g.firstSeen === now.toISOString()).length;
  console.log(`\nWrote ${gigs.length} upcoming gigs (${newCount} new since last run) to ${path.relative(ROOT, OUT_FILE)}`);
}

// Exported for tests; main runs only when executed directly.
export { parseICS, mapSkiddleEvent, mapJamBaseEvent, dedupeAcrossSources, genresInScope };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

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
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = path.join(ROOT, 'data', 'gigs.json');

const config = JSON.parse(readFileSync(path.join(ROOT, 'config', 'config.json'), 'utf8'));
const favourites = JSON.parse(readFileSync(path.join(ROOT, 'config', 'favourites.json'), 'utf8')).bands;

const API_KEY = process.env.TICKETMASTER_API_KEY;
if (!API_KEY) {
  console.error(
    'TICKETMASTER_API_KEY is not set.\n\n' +
    'Get a free key at https://developer.ticketmaster.com/ (instant on signup), then run:\n' +
    '  TICKETMASTER_API_KEY=<your-key> npm run fetch\n\n' +
    'For the GitHub Actions daily refresh, add the key as a repository secret named TICKETMASTER_API_KEY.'
  );
  process.exit(1);
}

const TM_HOST = 'https://app.ticketmaster.com';
const EUROPE = new Set(config.europeanCountries);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) =>
  (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

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
  return {
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

// Favourite bands are tracked Europe-wide with no genre restriction.
async function fetchFavourites(found, startISO, endISO) {
  for (const name of favourites) {
    try {
      const search = await tmGet('/discovery/v2/attractions.json', { keyword: name, size: 5 });
      const match = (search._embedded?.attractions ?? []).find((a) => norm(a.name) === norm(name));
      if (!match) {
        console.log(`  ${name}: no exact attraction match, relying on genre sweep`);
        continue;
      }
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

async function main() {
  const now = new Date();
  const startISO = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const endISO = new Date(now.getTime() + config.lookAheadDays * 86400_000)
    .toISOString().replace(/\.\d{3}Z$/, 'Z');

  console.log(`Genre sweep (${config.classifications.join(', ')}) across ${config.countries.length} markets:`);
  const found = await fetchGenreSweep(startISO, endISO);
  console.log('Favourite bands (Europe-wide, any genre):');
  await fetchFavourites(found, startISO, endISO);
  await fetchBandsintown(found);
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
    .map(({ status, ...g }) => ({ ...g, firstSeen: previousFirstSeen.get(g.id) ?? now.toISOString() }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));

  mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify({ updatedAt: now.toISOString(), source: 'live', gigs }, null, 2) + '\n');
  const newCount = gigs.filter((g) => g.firstSeen === now.toISOString()).length;
  console.log(`\nWrote ${gigs.length} upcoming gigs (${newCount} new since last run) to ${path.relative(ROOT, OUT_FILE)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

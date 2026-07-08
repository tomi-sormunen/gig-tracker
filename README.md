# ⚡ Gig Tracker 🤘

A personal tracker for **rock & metal gigs and festivals across Europe**. A daily
GitHub Actions job pulls upcoming events from the Ticketmaster Discovery API into a
JSON file, and a dependency-free static web UI presents them as a card list and a
calendar — with a "latest additions" ticker, favourite-band highlighting, band
images, and direct ticket links.

No server, no database, no hosting bill: the whole thing is this repository.

## Quick start

```bash
# 1. See the UI immediately (ships with sample data)
npm run serve          # → http://localhost:8420

# 2. Get live data: grab a free API key from https://developer.ticketmaster.com/
#    (instant on signup, 5000 calls/day) and run:
TICKETMASTER_API_KEY=<your-key> npm run fetch
```

Requires Node.js 18+. There are no npm dependencies to install.

### Automatic daily refresh (free)

1. Add your key as a repository secret: **Settings → Secrets and variables →
   Actions → New repository secret**, name it `TICKETMASTER_API_KEY`.
2. The included workflow (`.github/workflows/update-gigs.yml`) runs every morning
   at 05:00 UTC, commits a fresh `data/gigs.json`, and can also be triggered
   manually from the **Actions** tab ("Run workflow") whenever you want an
   on-demand refresh.
3. Optional: enable **GitHub Pages** (Settings → Pages → deploy from branch, root
   folder) and the UI is hosted for free at
   `https://<user>.github.io/gig-tracker/`, always showing the latest data.

## Favourite bands

Edit `config/favourites.json`:

```json
{ "bands": ["Iron Maiden", "Gojira", "Nightwish", "..."] }
```

Favourites get two special treatments:

- **In the UI** — gold highlight, 🤘 badge, a favourites-only filter, and emphasis
  in the ticker. Matching is done live in the browser, so edits show up on the
  next page reload without refetching.
- **In the fetcher** — favourite bands are tracked **Europe-wide and regardless of
  genre**, so a favourite that isn't classified as rock/metal still shows up.

## How it works

```
config/favourites.json ─┐
config/config.json ─────┤
                        ▼
scripts/fetch-gigs.mjs ──► data/gigs.json ──► index.html + assets/ (static UI)
   (GitHub Actions cron          ▲
    or `npm run fetch`)          └─ firstSeen timestamps drive the 🆕 ticker
```

- The fetcher sweeps 17 European Ticketmaster markets for the `metal` and `rock`
  classifications, plus a per-band lookup for every favourite. It dedupes by
  event ID, keeps only European countries, and preserves each event's
  `firstSeen` timestamp across runs so genuinely *new* announcements can be
  surfaced in the ticker and with pulsing "NEW" badges (7-day window).
- The UI is plain HTML/CSS/JS — list view grouped by month, a Monday-first
  monthly calendar with clickable event chips, search, country/genre/type
  filters, and a favourites-only toggle. Every event gets a broad category tag
  derived from its classification — **Metal**, **Hard Rock**, or **Rock** —
  with precedence in that order, so an event only counts as plain "Rock" when
  it doesn't qualify as Hard Rock or Metal.
- The layout is mobile-friendly (it works well on GitHub Pages from a phone):
  on small screens the calendar collapses event chips into colour-coded bars
  and tapping a day opens that day's gigs. Band/venue images come straight from the
  Ticketmaster event data; when an event has no image, a generated placeholder
  is shown instead.

## Design decisions (and why)

**Refresh model — scheduled, but free.** Instead of choosing between "pay for a
server" and "click refresh manually", the data refresh runs as a **GitHub Actions
cron job**, which is free for public repositories and effectively free for private
ones at one short run per day (~1 minute of the 2000 free minutes/month). You
still get a manual refresh button (the `workflow_dispatch` trigger, or
`npm run fetch` locally). Gig announcements don't move faster than daily anyway.

**Tool — a static site, not an app server.** All rendering happens in the
browser from a committed JSON file. That means zero runtime cost, free hosting on
GitHub Pages, works locally with any static server, and the git history doubles
as an archive of when each gig was announced.

**Sources.** Considered and chosen:

| Source | Verdict |
| --- | --- |
| **Ticketmaster Discovery API** | ✅ Primary. Free instant key, 5000 calls/day, covers most European markets, genre classifications, ticket URLs, and event images in one API. |
| **Bandsintown API** | ⚠️ Optional secondary (`BANDSINTOWN_APP_ID` secret). Great per-artist coverage incl. non-Ticketmaster venues, but access now requires written approval from Bandsintown. Supported out of the box if you obtain an app id. |
| Songkick API | ❌ No longer issues new API keys. |
| Setlist.fm / MusicBrainz | ❌ Past shows / metadata only, no upcoming-event focus. |
| Scraping metal-archives, concerts-metal.com, local promoters | ❌ Deliberately avoided: brittle, against most ToS, and Ticketmaster already covers the big European markets. Easy to add later as extra fetcher modules if a gap appears. |

Note: Ticketmaster's coverage is thinner in a few countries where it doesn't
operate (e.g. parts of Eastern/Southern Europe) — that's the main gap Bandsintown
fills for your favourite bands.

## Repository layout

```
index.html               UI entry point
assets/                  Styles + UI logic (no build step, no dependencies)
config/favourites.json   ← your favourite bands, edit freely
config/config.json       Markets, genres, look-ahead window, paging limits
data/gigs.json           The dataset (committed; starts as sample data)
scripts/fetch-gigs.mjs   Data fetcher (Ticketmaster + optional Bandsintown)
scripts/serve.mjs        Tiny local static server
.github/workflows/       Daily refresh cron + manual trigger
```

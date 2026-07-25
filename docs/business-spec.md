# Gig Tracker — Business Version Spec & Handoff

> **Purpose of this document.** This is the handoff/context brief for building the
> multi-user, commercial version of Gig Tracker in a **new repository**. It captures
> the product vision, recommended architecture, API choices, feature backlog, cost
> model, and — most valuably — the **hard-won lessons from the v1 personal build**
> so they don't have to be re-learned.
>
> **How to use it:** copy this file into the new repo as `CLAUDE.md` (Claude Code
> auto-loads that filename as context at the start of every session) or keep it as
> `docs/business-spec.md` and reference it. A fresh Claude Code chat has **no memory
> of the conversation that produced the v1 tool** — this document is the bridge.

---

## 1. What this is

A web app that aggregates **live music gigs and festivals** and helps fans **discover
shows and plan trips to them** — including flights and hotels — with a budget filter.

- **v1 (personal, existing repo `gig-tracker`):** metal/rock in Europe, single user,
  static site + JSON data file committed by a daily GitHub Actions cron. Works great,
  stays lightweight, and serves as the **sandbox** for testing ideas before they land
  in the product.
- **v2 (this spec):** multi-user, accounts, user-chosen genres/regions, Spotify
  favourites sync, a recommendation engine, and trip planning with flight + hotel
  pricing. Free to use; monetised via **affiliate revenue** on tickets, hotels, and
  flights.

### The core differentiator
Nobody serves the **"fly somewhere with friends for a gig weekend"** use case well.
The trip planner — clustering nearby-in-time-and-place gigs, then attaching
flight + hotel prices and a budget filter, with **shared/group trips** — is the
unique hook and the organic-growth engine (each shared trip invites new users).

---

## 2. Recommended architecture

The jump from v1 is: static files + cron → **multi-user app with accounts, per-user
data, and third-party OAuth**. That needs a real backend + database.

| Layer | Recommendation | Why |
| --- | --- | --- |
| **Frontend** | Next.js (React) on **Vercel** or Cloudflare Pages | Biggest ecosystem, easiest deploy, SSR for SEO on gig/artist pages |
| **Backend + DB + Auth** | **Supabase** (Postgres + Auth + storage + edge functions + cron) | Collapses 4 services into 1; generous free tier; row-level security; magic-link + OAuth built in |
| **Data pipeline** | Scheduled job (Supabase cron or a Render/Railway worker) writing gigs into Postgres | Port v1's fetcher logic almost verbatim |
| **Caching** | Postgres tables or **Upstash Redis** (free tier) with TTL | Hotel/flight APIs are slow + rate-limited — never call them live per page load |
| **Email** | **Resend** or **Postmark** | Alerts + weekly digest |

### Critical secrets distinction (common mistake)
- **Your app's own provider keys** (Bandsintown, Amadeus, Ticketmaster, …) → host
  **secrets/env vars**. NEVER a DB table, never committed.
- **Per-user OAuth tokens** (each user's Spotify token) → **database, encrypted at
  rest** (Supabase supports this). These are user data, not app config.

### Suggested data model (starting point)
- `users` (Supabase auth) · `profiles` (home location, home coords, genres, region prefs, theme)
- `artists` (canonical, MusicBrainz ID) · `user_favourites` (user ↔ artist, source: manual/spotify/songkick)
- `gigs` (deduped, normalized — same schema as v1's gig objects) · `gig_artists`
- `user_saved_gigs` · `user_hidden_gigs`
- `trips` (clustered) · `trip_members` (for group/shared trips) · `trip_votes`
- `alerts` (user ↔ rule: favourite-announces / on-sale / price-drop) · `sent_alerts`
- `oauth_tokens` (encrypted, per-user Spotify etc.)

---

## 3. APIs

### Gigs / music (data sources)
- **Bandsintown — the new base source.** Their business/partnership track is
  receptive (they refuse hobby projects but work with businesses). Best per-artist
  coverage including non-Ticketmaster venues.
- **Keep as supplements:** Ticketmaster Discovery, Skiddle (UK), JamBase. v1's
  **cross-source dedupe** (same date + city + shared band → keep richest source)
  ports directly.
- **MusicBrainz** (free) for canonical artist IDs — essential at scale so name
  variants and cross-source duplicates resolve. v1 had no canonical layer and relied
  on normalized-string matching; the product needs real IDs.

### Artist metadata / recommendations
- **Spotify** for *favourites sync only* (followed artists + top artists). Requires
  OAuth + a **quota-extension review** to exceed 25 users. **It cannot return
  concerts** — that's a private Ticketmaster/Songkick partnership, not in the API.
- ⚠️ **Spotify removed related-artists & recommendations endpoints for new apps
  (late 2024).** Build the **recommendation engine on Last.fm "similar artists"**
  (free) or ListenBrainz, keyed off synced favourites. Do NOT design around Spotify
  recommendations — they're gone for new apps.

### Hotels
- **Start:** **Amadeus Self-Service Hotel Search** — instant developer tier, real
  data, build immediately.
- **Upgrade for revenue:** **Booking.com** (Demand API / affiliate) and **Expedia
  Rapid** (covers Hotels.com) — partner-gated, pursue once you have traffic.

### Flights
- **Start:** **Amadeus Self-Service Flight Offers** — instant dev tier for prices.
- **Revenue layer:** **Kiwi.com (Tequila)** — real search API with an affiliate model.
- Skyscanner & Duffel are partner-gated; **Google Flights has no API**.

### Affiliate plumbing (how money actually flows)
Join a network — **Awin**, **Impact**, or **CJ** — which hosts the Booking.com,
Expedia, and Ticketmaster affiliate programs. You get tracking links + payouts there.

---

## 4. Feature backlog (priority order)

1. **Accounts + cross-device sync** of favourites / saved / hidden (v1 used
   localStorage — fine for one user, not a product).
2. **Alerts — the retention killer.** "Favourite announced a gig," "on sale in 24h,"
   "price dropped." Email first (v1 has a digest prototype), push later. This is what
   makes it a daily-use app rather than a bookmark.
3. **Spotify onboarding** — "connect Spotify → instant favourites" kills the
   cold-start problem.
4. **Trip planner v2** — cluster nearby gigs (v1 logic), attach **flight + hotel
   prices**, **budget filter**, deep affiliate links out to book.
5. **Group / shared trips** — invite friends, vote on weekends, see who's going. The
   unique differentiator and growth loop.
6. **User configuration** — genres, region/countries, home location + radius, trip
   distance, budget (v1 has a Settings panel prototype with home/radius/trip-distance
   in localStorage — port the UX, back it with the DB).
7. **Per-user iCal subscription** so their gigs land in their real calendar.
8. **Themes / UI customization** (more than v1's dark theme).
9. **Price tracking & drop alerts.**

---

## 5. Cost & revenue reality (be honest with yourself)

### Monthly cost by stage
- **MVP / first ~1k users:** mostly free tiers → **$0–45/mo** (Supabase Pro $25 if you
  outgrow free, domain ~$12/yr, email free tier).
- **~10k active users:** **$100–300/mo** (DB compute, bandwidth, Redis, email, cron worker).
- **~100k users:** **$500–2,000+/mo**, plus the wildcard — hotel/flight/Bandsintown APIs
  may bill per-call above free tiers and can dominate the bill.

### Affiliate revenue — the honest part
Payouts are **thin and volume-dependent**: hotel booking ~€3–7, flight ~€1–5, ticket a
few percent. Clearing even ~€500/mo needs on the order of **100+ completed travel
bookings/month**, i.e. **thousands of engaged users who actually book trips through
you.** At small scale, affiliate revenue is effectively **zero**.

**Framing:** at launch and for a while, this **runs at a small loss** — but early costs
are so low (~$25–45/mo) that the runway is cheap. It becomes break-even-to-profitable
only with real traffic, and the **travel affiliate angle is the only path to meaningful
money** (ticket affiliate alone is too thin). Viable as a passion project that may pay
for itself and then some; **not** a fast or reliable income. Go in with that mindset.

### Also budget for (non-infra)
Domain, a logo/brand, and **GDPR basics** (EU users + email = consent, unsubscribe,
data export/delete, a privacy policy). Not optional for a real product.

---

## 6. Lessons from the v1 build (don't re-learn these)

**Data-source gotchas discovered the hard way:**
- **Ticketmaster Discovery API omits `priceRanges` for essentially all European
  events** — prices live only on the purchase page. TM price coverage was ~0% in
  practice. Don't rely on TM for prices; expect prices mainly from JamBase/Skiddle
  and the travel APIs.
- **Ticketmaster Inventory Status API** (availability "traffic lights") is a
  **separate, gated product** — a plain Discovery key gets 401. Needs a request to
  `devportalinquiry@ticketmaster.com`.
- **Ticketmaster's `classificationName` search is fuzzy** — a "rock"/"metal" sweep
  returns pop, theatre, even sport. v1 filters by the event's *own* genre/subgenre
  against an allow/exclude list (favourites exempt). Keep genre scoping server-side.
- **JamBase**: the developer portal is `https://api.data.jambase.com/v3/events`, auth
  is **Bearer token only** (not the legacy `www.jambase.com/jb-api/v1` + apikey param).
  Developer plan **caps the `eventDateTo` window** (~180 days) — parse the limit from
  the `date-window-exceeded` error and retry. And v3 does **not** send an
  `x-jb-api-requests-remaining` header, so guard against `Number(null) === 0` false
  positives in any quota check.
- **Songkick**: API is closed to new users. The **per-user `.ics` calendar** works as
  a source, but `filter=attendance` only lists concerts the user **marked
  going/interested** (NOT tracked artists), the calendar must be **public**, and it's
  **cached server-side** — add a cache-bust param + no-cache headers for fresh data.
- **Bandsintown** refuses hobby projects but is open to businesses — hence its role as
  the v2 base source.
- **Tiketti / Eventim / Lippu.fi**: no public APIs. v1 added a generic **iCal feed
  ingester** (`config/feeds.json`) so any public venue/festival `.ics` calendar can be
  a source — a good pattern to keep.

**Reusable code from v1 (port, don't rewrite):**
- Source **mappers** (Ticketmaster / Skiddle / JamBase / Songkick → common gig schema).
- The **iCalendar parser** (`parseICS`) — folded lines, all-day vs timed, escapes.
- **Cross-source dedupe** (date + city + shared-band, source-priority to keep richest).
- Genre allow/exclude scoping; the trip-clustering (haversine + date-window) logic.
- The **normalized gig object shape** — a sensible canonical schema already.

**Architecture notes:**
- v1's push race (GitHub Actions committing data while main moved) → the pipeline
  should write to a **DB**, not commit files, which sidesteps this entirely.
- v1 rendered ~5,600 gigs client-side and had to add pagination/debounce to stop
  mobile jank — the product should **paginate/query server-side** from the DB.
- Favourites matching in v1 is exact-band-name (to avoid tribute-act false positives
  like "Daft Punkz"). With MusicBrainz IDs in v2, match on IDs instead.

---

## 7. How to start the new repo

1. **New repository, not a fork.** The stack is fundamentally different (framework +
   DB + auth); a clean start beats deleting most of a copy. Selectively port the
   reusable modules listed in §6.
2. **Put this file in the new repo as `CLAUDE.md`** so every Claude Code session loads
   it as context automatically.
3. **Start a fresh Claude Code chat in the new repo.** It has no memory of the v1
   conversation, but with `CLAUDE.md` present it starts productive from message one.
4. Suggested first milestones: (a) Supabase project + schema + auth, (b) port the
   fetcher into a scheduled job writing to Postgres, (c) a minimal Next.js list/detail
   UI reading from the DB, (d) Spotify OAuth + favourites sync, (e) trip planner v2
   with Amadeus prices, (f) alerts.

---

## 8. v1 reference (the personal tool)

Repo: `tomi-sormunen/gig-tracker`. Static site + `scripts/fetch-gigs.mjs` (the
multi-source fetcher) + daily GitHub Actions cron committing `data/gigs.json`. Sources
live today: **Ticketmaster, Skiddle, JamBase, Songkick (personal .ics), + iCal feeds**.
Features: list/calendar/map views, favourites (manual + Songkick-synced), trip ideas,
on-sale + latest panels, availability traffic-lights (pending TM inventory access),
`.ics` export, weekly email digest, PWA, Settings (home/radius/trip-distance/favourite
toggles). Keep it as the **lightweight sandbox** for prototyping v2 ideas cheaply.

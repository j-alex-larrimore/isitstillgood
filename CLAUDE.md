# IsItStillGood

Backend for isitstillgood.com — a social review site combining Goodreads
(books), IMDB (movies/TV), and BoardGameGeek (games), with a friends-based
activity feed. This repo is the API only; the frontend is static HTML hosted
separately on DreamHost and is not version-controlled here.

## What the product actually is

The name is a name. "Is it still good?" — whether something holds up over
time — is **not** the main draw, and copy that leads on it is selling the
wrong thing. The draw is these five, roughly in order:

1. **All four media types in one place.** Films, TV, books and games under
   one profile and one taste graph. Letterboxd does films, Goodreads does
   books; nothing does the lot. This is the differentiator most worth
   leading on, and the thing `Omnivore` (see `src/lib/badges.js`) exists to
   encourage.
2. **Reviews among friends**, not a public firehose. The feed is built
   around people you have actually added.
3. **Only positive interactions, by design.** Upvotes and private messages
   — there are no downvotes and no public comment threads. This is a
   deliberate product stance, not a missing feature: do not add public
   commenting or any negative-signal reaction without asking first.
4. **Heavy stat tracking.** Taste profiles, favourite actor/director/author
   /decade, rating distributions, verdict breakdowns.
5. **Shareable cards** summarising a user's ratings — the stat work made
   into something a person wants to post.

The cards are the hook in practice. The Reddit ads lead with them (the
"Damon vs Affleck" comparison card is the one that catches the eye), so the
thing bringing people to the site is a personalised stat card — which means
the landing page needs to deliver on cards and stats, not on friends or on
whether a film holds up.

## Stack

- Node.js 20, Express 5
- PostgreSQL via Prisma 5 (`prisma/schema.prisma`) — **do not upgrade to
  Prisma 7**, its config format is a breaking change incompatible with this
  schema (see git history from March 2026 for the full saga)
- Auth: Passport (Google OAuth2 + local strategy), JWT access tokens +
  rotating refresh tokens, both set as httpOnly cookies
- Email via Resend (`src/services/email.js`)
- Hosting: Railway (Postgres + the Node app), auto-deploys from `main` on push

## Structure

- `src/routes/` — one file per resource (`admin`, `auth`, `media`, `reviews`,
  `friends`, `feed`, `lists`, `users`, `messages`, `requests`, `invites`,
  `sitemap`, `prerender`)
- `src/middleware/` — `auth` (JWT), `admin` (requires `isAdmin`), `passport`
  (Google OAuth strategy)
- `src/services/` — `externalRatings.js` (background rating refresh),
  `mediaLookup.js` (TMDB/Google Books/Open Library/IGDB search+detail,
  shared by the admin UI and `scripts/bulk-import.js`), `email.js`
- `src/lib/` — `prisma.js` (shared singleton client), `tokens.js` (JWT/refresh
  token helpers), `mediaHelpers.js` (slugify, person-relation upserts, tag/genre
  normalization, duplicate detection — shared by admin routes and scripts)
- `scripts/` — one-off/CLI scripts, run with `node scripts/<name>.js`, each
  creates or imports the shared `prisma` client and disconnects when done

## Data model

`MediaItem` is a single table covering all four media types (`MOVIE`, `BOOK`,
`TV_SHOW`, `VIDEO_GAME`) with type-specific nullable fields. Two patterns to
know before touching media data:

- **TV shows**: a parent show row (`parentId: null`) holds `seasons` (total
  count); each season is its own `MediaItem` row with `parentId` pointing at
  the parent and `seasonNumber` set. Reviews are written per season.
- **Book series**: no parent/child relation — books share a `seriesName`
  string and are ordered by `seriesNumber`. The lowest-numbered book in a
  series acts as the "series page" dynamically (whichever book currently has
  the lowest number), aggregating ratings across the whole series.
  `seriesNumber` is a `Float?`, so interstitial/companion volumes (e.g. a
  novella between books 2 and 3) get their real fractional number (`2.5`)
  rather than being left unnumbered.

`Review.rating` (1–10) drives an auto-computed `verdict`: 1–3 `NOT_GOOD`,
4–6 `MIXED`, 7–8 `STILL_GOOD`, 9–10 `TIMELESS`. Visibility is per-review:
`PUBLIC` / `FRIENDS_ONLY` / `PRIVATE`.

External ratings: TMDB (movies/TV), Open Library (books, no key required),
IGDB (games, via Twitch OAuth client-credentials). IMDb and Rotten Tomatoes
were deliberately removed — licensing concerns, don't re-add them.

## Environment variables (`.env`, not committed)

Local `.env` currently only has `DATABASE_URL` pointing at Railway's public
Postgres connection string — scripts run locally write directly to
production data, be careful. To use `scripts/bulk-import.js` for real
lookups (not just dry-runs), add these too, copied from Railway's Variables
tab: `TMDB_READ_ACCESS_TOKEN`, `GOOGLE_BOOKS_API_KEY`, `IGDB_CLIENT_ID`,
`IGDB_CLIENT_SECRET`. `scripts/sync-new-books.js` additionally needs
`NYT_API_KEY` — a free key from the Books API product at
developer.nytimes.com (Apps → New App → enable Books API), not something
Railway already has.

Full list of vars the app itself uses (set in Railway, not locally):
`DATABASE_URL`, `NODE_ENV`, `PORT`, `CLIENT_URL`, `SESSION_SECRET`,
`JWT_SECRET`, `JWT_EXPIRES_IN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`GOOGLE_CALLBACK_URL`, `RESEND_API_KEY`, `TMDB_READ_ACCESS_TOKEN`,
`GOOGLE_BOOKS_API_KEY`, `IGDB_CLIENT_ID`, `IGDB_CLIENT_SECRET`. `NYT_API_KEY`
is used by the sync workflow but not by the app itself, so it doesn't need
to go in Railway — only in local `.env` (for testing) and GitHub Actions
secrets (for the scheduled job).

## Deploy flow

Push to `main` on GitHub → Railway auto-deploys (`npm ci && npm start`,
`postinstall` runs `prisma generate`). Nothing else is automatic — schema
changes need two manual steps:

1. Locally: `npm run db:migrate` (creates a migration file, prompts for a
   name) → commit `prisma/migrations/` and push.
2. In Railway, migrations do **not** run automatically on deploy. If a
   deploy needs new tables/columns, temporarily set the service's start
   command to `npm run db:migrate:prod && node src/server.js`, let it
   redeploy once, then change it back to `node src/server.js`.

Database backups run daily via `.github/workflows/database-backup.yml`
(`pg_dump` → gzip → Backblaze B2, 30-day retention). This is already working;
if it breaks again the known gotcha is that Ubuntu's default `apt` only has
Postgres client v16 but Railway runs Postgres 18 — the workflow installs the
v18 client explicitly from the official PGDG apt repo.

New releases sync weekly (Mondays) via `.github/workflows/sync-new-releases.yml`,
running `scripts/sync-new-releases.js` (movies) and `scripts/sync-new-tv.js`
(TV shows) against a curated list of major studios/networks/streamers —
see each script's header comment for the studio/network/provider lists and
the setting-genre (Schools/Police/Legal/Courtroom/Medical) keyword heuristic
they apply. Both auto-publish (`verified: true`) rather than queuing for
review, a deliberate exception to the bulk-import default — see "Adding
media" below. The workflow needs a `TMDB_READ_ACCESS_TOKEN` secret in GitHub
(Settings → Secrets → Actions) in addition to the `DATABASE_PUBLIC_URL`
secret the backup workflow already uses — these are GitHub Actions secrets,
separate from Railway's env vars, and must be added there directly.
`sync-new-tv.js` only catches brand-new shows premiering their first season
(TMDB's discover filters on a show's overall first-air-date) — it does not
detect new seasons of shows already in the DB.

`scripts/sync-new-books.js` (also part of the same weekly workflow) is a
different shape from the other two — Google Books has no reliable
discover-by-date API (verified empirically: `orderBy=newest` doesn't sort by
actual recency, and publisher+date-range queries returned zero results for
a major publisher's current-year catalog), so it isn't built on Google Books
for discovery. It uses the NYT Books API's current-week bestseller lists
instead (a real "what's current" endpoint), then does a precise Google Books
**ISBN** lookup (not fuzzy title/author search) for each book's
description/cover/metadata. Needs `GOOGLE_BOOKS_API_KEY` and `NYT_API_KEY`
as GitHub Actions secrets in addition to the ones the other two steps use.
Genres come from which NYT list a book appeared on
(`LIST_GENRE_MAP` in the script), not from Google Books' own genre field —
Google Books' genre and release-date data is unreliable for fuzzy-matched
results specifically (wrong-edition mismatches); an exact ISBN lookup
doesn't have that problem for release year, but genre quality is still poor
across the board on Google Books, hence the override either way.

`scripts/sync-new-games.js` (also part of the same weekly workflow) runs
two IGDB discovery passes, since a single popularity metric doesn't work
across both: recently-released games (last 8 days) filtered by
`rating_count` (same threshold as the historical backfill), and upcoming
games (next ~90 days) filtered by `hypes` instead, IGDB's pre-release
anticipation metric, since an unreleased game has zero accumulated ratings
by definition. Needs `IGDB_CLIENT_ID` and `IGDB_CLIENT_SECRET` as GitHub
Actions secrets in addition to the ones the other steps use.

## Adding media to the database

Three ways, all going through the same lookup/normalization logic
(`src/lib/mediaHelpers.js` + `src/services/mediaLookup.js`):

- **One at a time**: the admin UI's add-media form (calls
  `POST /api/admin/media`, admin-only route, requires a logged-in admin
  session).
- **In bulk**: `node scripts/bulk-import.js <file.csv|file.json> [--dry-run]`
  — reads a list of titles, looks each up against TMDB/Google
  Books+Open Library/IGDB depending on `mediaType`, skips anything already
  in the DB (matched by external ID first, then title), and inserts
  directly via Prisma. Always run with `--dry-run` first on a new list —
  see the header comment in the script for the CSV format and
  `scripts/sample-media-import.csv` for an example. TV seasons and full book
  series still need to be added/linked individually afterward.
- **Conversationally**: just paste a freeform list of titles into a Claude
  Code session, grouped by type or with type noted per title (e.g.
  "Movies: Sinners, The Batman / Books: Project Hail Mary by Andy Weir").
  Claude Code writes a temporary CSV under `scripts/`, runs the importer
  with `--dry-run` first, shows the results, and only runs it for real
  after you confirm — it should never skip the dry-run step for a new list.
- **Automatically, on a schedule**: `.github/workflows/sync-new-releases.yml`
  (weekly) pulls newly-released movies and newly-premiered TV shows from a
  curated studio/network/streamer list, newly-published books from NYT
  current bestseller lists, and newly-released/upcoming video games from
  IGDB — see "Deploy flow" above. Unlike every other path here, this one
  auto-publishes instead of queuing for review.

## Conventions

- Tag normalization (`normalizeTags` in `src/lib/mediaHelpers.js`) title-cases
  freeform tags but overrides known acronyms/networks (HBO, MCU, NFL, etc.) —
  extend `TAG_OVERRIDES` there, don't special-case tags elsewhere.
- `connectPersons(names, isUpdate)` is the only way cast/directors/authors
  should be written: `isUpdate: false` (create) uses `{connect}` — additive;
  `isUpdate: true` (PATCH) uses `{set}` — replaces the whole relation. Person
  records are upserted by a slugified name, so name changes should go through
  this helper too, not raw Prisma calls.
- Slugs are generated once via `slugify` + `uniqueSlug` and never
  regenerated on update — treat existing slugs as stable IDs for URLs.

## Checking a frontend change

The frontend is static HTML in the separate, un-versioned folder; there is no
build and no test suite, so a page is only ever as correct as the last time
somebody loaded it. Nothing below is optional before handing over a file —
every failure mode listed has already shipped to the live site at least once.

### Load the page before handing it over

Each page is one big inline `<script>`, so a single error anywhere in it kills
*every* function on that page — rating, submitting, popups, all of it. The
symptom is not "this feature misbehaves", it is "the page is dead". Treat any
console error on load as a release blocker.

To check a page without uploading it, serve the folder and open it:

```bash
python -m http.server 5500 --directory "C:\Users\jalex\Documents\Programming\isitstillgood"
```

Then load `http://127.0.0.1:5500/<page>.html` and read the console. Notes:

- **CORS errors against `api.isitstillgood.com` are expected locally and are
  the only acceptable errors.** Anything else — especially `SyntaxError` or
  `ReferenceError` — is a real bug. Script-level errors fire before any fetch,
  so they still show up despite the API being unreachable.
- Pages need their real query params or they redirect to the landing page and
  you end up checking the wrong file: `item.html?slug=…`,
  `profile.html?username=…` (it is `username`, not `u`).
- Confirm the script ran to the end, not just that the page rendered:
  `typeof someFunctionDefinedNearTheBottom` should be `"function"`.
- Port 5500, never 3000 — 3000 is the dev server. Stop it afterwards by its
  exact PID (`Get-NetTCPConnection -LocalPort 5500`), never by matching on
  process name.

**Parsing the file is not sufficient**, and believing otherwise has already
cost a round trip. `async` alone on a line followed by `function` on the next
is *valid syntax* — ASI makes it the statement `async;` — and fails only at
runtime with `async is not defined`. A parse check cleared that file. Loading
it caught it immediately. Parse checks are a useful first pass for finding an
unescaped apostrophe in a `'…'` string (another one that has shipped), but
they are a pre-filter, not the test.

### Check the layout

Two further habits catch nearly everything.

**Check every state a component has, not just the one it loads in.** Expanded
and collapsed, empty and full, one item and twenty, signed in and signed out.
A taste card shipped looking fine and ran 280px off the side of a phone the
moment it was expanded — collapsed it was 161px wide, expanded its contents
needed 305px. Testing it collapsed proved nothing, twice.

**Check at phone width, with real data.** 375px is the common case; 360px and
320px still exist. Real data is the point: seeded or sample content is short
and tidy, and the thing that breaks a layout is a title nobody expected to be
that long.

Two failure modes worth knowing, because both have already happened here:

- **Grid blowout.** `grid-template-columns: 1fr` means `minmax(auto, 1fr)`,
  and `auto` will not shrink an item below its min-content width. One wide
  item therefore widens its own track and pushes the rest off screen — the
  card above went from `1fr 1fr` to an actual `313.5px 307px` inside a 335px
  box. Use `minmax(0, 1fr)` on the tracks and `min-width: 0` on the items.
  Child elements already having `text-overflow: ellipsis` does not help; they
  never get the chance, because the container is what overflowed.
- **Hiding with transforms.** Hiding something with `translateY(140%)` depends
  on its own height, so it stops working when the content changes size. The
  badge popup parked itself flush against the bottom of every page this way,
  showing an unclosable sliver. Hide with `opacity` / `visibility` /
  `pointer-events`, which cannot drift.

And when a fix appears to do nothing, check the rule actually wins: a later
rule at equal specificity beats an earlier one, so a new `@media` block added
near the top of the file is silently overridden by an existing one further
down.

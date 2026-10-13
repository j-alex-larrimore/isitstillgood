# Reddit ad destinations

Where each creative points and what it tags itself as. Kept here because
nothing else in the repo knows the ad numbering — the creatives live
outside it, in `Documents/isitstillgood-ads/drop-1/`, and a session that
cannot see them will invent a plausible-looking `utm_content` instead of
asking.

Changes happen in the Reddit Ads dashboard, not here. This file is the
record of what should be there.

## Why the tagging matters

Every Reddit visit so far carries `utm_campaign=launch` — all 860 of
them. That makes campaigns indistinguishable in `scripts/visit-report.js`,
which is why none of the earlier "which ad worked" questions could be
answered. One campaign value per campaign, one content value per
creative, and the report starts separating them.

`analytics.js` reads `utm_source`, `utm_medium`, `utm_campaign`,
`utm_content` and `rdt_cid` into `VisitLog` (see `postVisit`).

## Live

All three verified: HTTP 200, zero redirects, both people resolving, and
each pair present in the curated list in `src/lib/vsBattles.js`. Use
`www.` — the bare domain 301s, and params survive it but the hop does not
need to happen.

### ad08 — affleck-vs-damon

    https://www.isitstillgood.com/vs.html?battle=matt-damon,ben-affleck&role=actor&utm_source=reddit&utm_medium=cpc&utm_campaign=vs-damon-affleck&utm_content=ad08

### ad11 — favorite-director

    https://www.isitstillgood.com/vs.html?battle=christopher-nolan,denis-villeneuve&role=director&utm_source=reddit&utm_medium=cpc&utm_campaign=vs-nolan-villeneuve&utm_content=ad11

### ad20 — favorite-actor

    https://www.isitstillgood.com/vs.html?battle=tom-hanks,tom-cruise&role=actor&utm_source=reddit&utm_medium=cpc&utm_campaign=vs-hanks-cruise&utm_content=ad20

## Not on VS

### ad17 — the-feed-honestly

About the feed, so VS would be a mismatch. Leave it on `/`, tagged
`utm_content=ad17` with its own campaign value.

## Pulled

### ad16 — exactly-one-review

The creative claims titles have exactly one review. They do not: The Dark
Knight has 3, Memento 2, The Martian 2. The ad contradicts the page it
sends people to, so it should not run in this form. The idea is salvageable
with honest copy — "be the second person to review this" — but that is a
new creative, not a destination change.

## Picking a destination for a new creative

Any two people in the catalogue work, not only the curated pairs — the VS
page resolves an arbitrary `?battle=slug-a,slug-b&role=` through
`/api/media/people`. Check both slugs resolve and that each side has
enough credits to fill a column:

    curl -s "https://api.isitstillgood.com/api/media/vs-people?role=actor&q=hanks"

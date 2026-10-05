#!/usr/bin/env node
//
// Replay a real export file through the actual import matchers.
//
//   node scripts/verify-import-format.js <file.csv>
//
// Read-only and database-free: the candidate maps are deliberately left empty,
// so a title this catalogue does happen to hold still reports as "missing"
// here. That is the point — this script checks the part of the pipeline that
// runs before any lookup (header shape, rating scale, title-type vocabulary),
// which is exactly the part a provider can break by re-casing one column.
//
// Why it exists: IMDb ships Title Type in two spellings, the classic
// `tvMiniSeries` and the display `TV Mini Series`. The table only had the
// first, so a genuine 50-row export mapped every single row to "unsupported"
// and the importer looked like it had rejected the file. Nothing about the
// file was wrong, and no amount of staring at the CSV would show it.
//
// The failure signature to watch for is *every* row unsupported, which is what
// a re-cased vocabulary looks like. A handful of unsupported rows is normal and
// correct — this catalogue genuinely does not take podcasts — so those are
// listed as a warning, not a failure.

const fs = require('fs');
const path = require('path');
const { parseCsv, matchImdbRow, imdbTypeKey, IMDB_TITLE_TYPES } =
  require('../src/routes/imports')._internals;

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/verify-import-format.js <file.csv>');
  process.exit(1);
}

const csv = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
const rows = parseCsv(csv);

console.log(`\nFile:    ${path.basename(file)}`);
console.log(`Rows:    ${rows.length}`);
if (!rows.length) { console.error('No rows parsed — not a CSV this importer reads.'); process.exit(1); }

console.log(`Columns: ${Object.keys(rows[0]).join(', ')}\n`);

// Which flavour of the export is this?
const hasConst = 'Const' in rows[0];
const hasOriginal = 'Original Title' in rows[0];
console.log(`Detected: IMDb ratings export${hasOriginal ? ' (current format, has Original Title)' : ' (classic format)'}`);
console.log(`          Const column ${hasConst ? 'present' : 'MISSING — id matching unavailable'}\n`);

// Title Type vocabulary, before anything else, since that is the failure mode.
const types = new Map();
for (const r of rows) {
  const raw = (r['Title Type'] || '').trim() || '(blank)';
  const key = imdbTypeKey(raw);
  const mapped = key === 'tvepisode' ? 'episode (skipped by design)'
    : IMDB_TITLE_TYPES[key] || 'UNSUPPORTED';
  if (!types.has(raw)) types.set(raw, { mapped, n: 0 });
  types.get(raw).n++;
}
console.log('Title Type → media type');
for (const [raw, { mapped, n }] of [...types].sort((a, b) => b[1].n - a[1].n)) {
  const flag = mapped === 'UNSUPPORTED' ? '  <-- not mapped' : '';
  console.log(`  ${String(n).padStart(4)}  ${raw.padEnd(18)} ${mapped}${flag}`);
}

// Now the full matcher, with empty maps.
const empty = { byId: new Map(), byTitle: new Map() };
const statuses = new Map();
let rated = 0;
for (const r of rows) {
  const m = matchImdbRow(r, empty);
  if (!m) { statuses.set('(no title, dropped)', (statuses.get('(no title, dropped)') || 0) + 1); continue; }
  statuses.set(m.status, (statuses.get(m.status) || 0) + 1);
  if (m.rating !== null) rated++;
}

console.log('\nRow status (no catalogue loaded, so "missing" is expected)');
for (const [s, n] of [...statuses].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${s}`);
}

const unsupported = statuses.get('unsupported') || 0;
const unmapped = [...types].filter(([, v]) => v.mapped === 'UNSUPPORTED').map(([k]) => k);

console.log(`\nRatings read: ${rated}/${rows.length}`);
console.log(`Unsupported:  ${unsupported}`);

// Every row unsupported is the format-break signature: a provider re-cased or
// renamed the column and nothing matches any more. A few unsupported rows just
// means the user rated something outside this catalogue's remit.
const broken = rows.length > 0 && unsupported === rows.length;

if (unmapped.length && !broken) {
  console.log(`\nNote: ${unsupported} row(s) in types this importer does not take — ${unmapped.join(', ')}.`);
  console.log('      Expected for podcasts and the like. Those rows are reported to the');
  console.log('      user and skipped; the rest of the file imports normally.');
}

console.log(broken
  ? `\nFAIL — every row is unsupported. The Title Type vocabulary has changed (${unmapped.join(', ')}). Add these to IMDB_TITLE_TYPES; keys are lowercase-alphanumeric.\n`
  : '\nPASS — the file parses and its types are understood; importing depends only on catalogue coverage.\n');

process.exit(broken ? 1 : 0);

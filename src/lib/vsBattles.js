/**
 * Curated head-to-head matchups for the VS tab.
 *
 * Pairs are chosen to be arguable rather than lopsided — the point is that
 * a visitor already has an opinion and wants to settle it. Every person
 * here was checked against the catalogue: each has at least six credited
 * titles in the relevant role, because a side with three entries makes a
 * thin card and a worse argument.
 *
 * Stored as slugs, not ids. Person ids are internal and would rot the day
 * a record is merged; a slug is the stable public handle (see the people
 * lookup in src/routes/media.js). Names here are only for reading — the
 * endpoint returns whatever the database currently calls the person.
 *
 * To add one: check both people exist with enough credits, then append.
 * The endpoint drops any pair it cannot fully resolve rather than serving
 * a half-built battle.
 */

const VS_BATTLES = [
  // ── Actors ────────────────────────────────────────────────────────────
  { category: 'actor', a: 'matt-damon',         b: 'ben-affleck' },
  { category: 'actor', a: 'leonardo-dicaprio',  b: 'brad-pitt' },
  { category: 'actor', a: 'tom-hanks',          b: 'tom-cruise' },
  { category: 'actor', a: 'denzel-washington',  b: 'samuel-l-jackson' },
  { category: 'actor', a: 'meryl-streep',       b: 'cate-blanchett' },
  { category: 'actor', a: 'robert-de-niro',     b: 'al-pacino' },
  { category: 'actor', a: 'scarlett-johansson', b: 'natalie-portman' },
  { category: 'actor', a: 'christian-bale',     b: 'joaquin-phoenix' },
  { category: 'actor', a: 'keanu-reeves',       b: 'nicolas-cage' },
  { category: 'actor', a: 'emma-stone',         b: 'jennifer-lawrence' },
  { category: 'actor', a: 'harrison-ford',      b: 'sylvester-stallone' },
  { category: 'actor', a: 'viola-davis',        b: 'octavia-spencer' },

  // ── Directors ─────────────────────────────────────────────────────────
  { category: 'director', a: 'christopher-nolan',  b: 'denis-villeneuve' },
  { category: 'director', a: 'martin-scorsese',    b: 'quentin-tarantino' },
  { category: 'director', a: 'steven-spielberg',   b: 'james-cameron' },
  { category: 'director', a: 'wes-anderson',       b: 'paul-thomas-anderson' },
  { category: 'director', a: 'david-fincher',      b: 'ridley-scott' },
  { category: 'director', a: 'stanley-kubrick',    b: 'alfred-hitchcock' },
  { category: 'director', a: 'kathryn-bigelow',    b: 'sofia-coppola' },
  { category: 'director', a: 'michael-bay',        b: 'zack-snyder' },
  { category: 'director', a: 'guillermo-del-toro', b: 'tim-burton' },
  { category: 'director', a: 'hayao-miyazaki',     b: 'brad-bird' },
  { category: 'director', a: 'joel-coen',          b: 'spike-lee' },

  // ── Authors ───────────────────────────────────────────────────────────
  { category: 'author', a: 'stephen-king',       b: 'dean-koontz' },
  { category: 'author', a: 'brandon-sanderson',  b: 'robin-hobb' },
  { category: 'author', a: 'j-k-rowling',        b: 'rick-riordan' },
  { category: 'author', a: 'george-r-r-martin',  b: 'robert-jordan' },
  { category: 'author', a: 'agatha-christie',    b: 'arthur-conan-doyle' },
  { category: 'author', a: 'neil-gaiman',        b: 'terry-pratchett' },
  { category: 'author', a: 'colleen-hoover',     b: 'sarah-j-maas' },
  { category: 'author', a: 'ernest-hemingway',   b: 'f-scott-fitzgerald' },
  { category: 'author', a: 'isaac-asimov',       b: 'kurt-vonnegut' },
  { category: 'author', a: 'charles-dickens',    b: 'jane-austen' },
];

// Which media the two sides should be compared across. An author battle
// listing their film adaptations would be comparing the wrong thing.
const CATEGORY_TYPE = {
  actor:    'SCREEN',
  director: 'SCREEN',
  author:   'BOOK',
};

module.exports = { VS_BATTLES, CATEGORY_TYPE };

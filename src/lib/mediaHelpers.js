// src/lib/mediaHelpers.js — shared media data helpers.
// Used by src/routes/admin.js (the admin UI) and scripts/bulk-import.js
// (the CLI importer) so both write identical, normalized data.
const prisma = require('./prisma');

// ─── Book series clustering ────────────────────────────────────────────────
// Shared by media.js (Browse's series-collapsed cards) and feed.js (showing
// the series name instead of one book's own title when the reviewed book is
// the series representative) — moved here so both use identical clustering/
// representative-picking logic instead of two definitions drifting apart.
//
// Clusters a list of `{ seriesName, seriesNumber, authors }`-shaped books
// into distinct series — an exact `seriesName` match is necessary but not
// sufficient, since two unrelated authors can each have a series with the
// identical name (confirmed live: Brandon Mull's and Toby Neighbors'
// unrelated "Five Kingdoms" series). A cluster requires overlapping
// authorship with its own books, unioned by shared-author rather than
// exact-set equality, so a series that gains a co-author partway through
// (the Wheel of Time: solely Robert Jordan for books 1-11, Jordan & Brandon
// Sanderson for 12-14) still stays one cluster. Returns an array of
// `{ authorIds: Set, books: [] }` groups per distinct seriesName.
function clusterBookSeries(books) {
  const clustersByName = new Map(); // seriesName -> array of clusters
  for (const book of books) {
    if (!book.seriesName) continue;
    const bookAuthorIds = new Set((book.authors || []).map(a => a.id));
    const clusters = clustersByName.get(book.seriesName) || [];
    let cluster = clusters.find(c => [...c.authorIds].some(id => bookAuthorIds.has(id)));
    if (!cluster) {
      cluster = { authorIds: new Set(), books: [] };
      clusters.push(cluster);
      clustersByName.set(book.seriesName, clusters);
    }
    for (const id of bookAuthorIds) cluster.authorIds.add(id);
    cluster.books.push(book);
  }
  return [...clustersByName.values()].flat();
}

// Picks which book in a series cluster acts as its representative (the one
// whose cover/page the series card shows). Prefers seriesNumber === 1 — the
// actual flagship first novel — over any lower-numbered prequel/novella
// (0, 0.5, etc.), since those exist specifically to NOT be a reader's first
// impression of the series. Falls back to the lowest available number only
// when no book is numbered exactly 1 (e.g. a series that starts at 0 with no
// separate "book 1"). Confirmed live: without this, series with a numbered
// prequel — Throne of Glass's "The Assassin's Blade" (0.5), the Powder Mage
// Trilogy's "Siege of Tilpur" (0) — showed the obscure prequel's cover as
// the series' public face instead of the actual first novel.
function pickSeriesRepresentative(books) {
  const bookOne = books.find(b => b.seriesNumber === 1);
  if (bookOne) return bookOne;
  return books.reduce((rep, book) =>
    (book.seriesNumber ?? Infinity) < (rep.seriesNumber ?? Infinity) ? book : rep
  );
}

// ─── Tag and genre normalization ──────────────────────────────────────────
const TAG_OVERRIDES = {
  'hbo': 'HBO', 'hbo max': 'HBO Max', 'hbomax': 'HBO Max',
  'apple tv': 'Apple TV', 'apple tv+': 'Apple TV+',
  'nbc': 'NBC', 'cbs': 'CBS', 'abc': 'ABC', 'amc': 'AMC', 'fx': 'FX',
  'bbc': 'BBC', 'pbs': 'PBS', 'mtv': 'MTV', 'vh1': 'VH1',
  'usa': 'USA', 'tnt': 'TNT', 'tbs': 'TBS', 'syfy': 'Syfy',
  'cnn': 'CNN', 'espn': 'ESPN', 'nfl': 'NFL', 'nba': 'NBA',
  'mlb': 'MLB', 'nhl': 'NHL', 'dc': 'DC', 'mcu': 'MCU', 'dceu': 'DCEU', 'dcu': 'DCU',
  'lgbtq': 'LGBTQ', 'lgbtq+': 'LGBTQ+', 'wwii': 'WWII', 'wwi': 'WWI',
  'uk': 'UK', 'us': 'US', 'snl': 'SNL',
};

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return tags;
  const normalized = tags.map(t => {
    const trimmed = t.trim();
    const lower   = trimmed.toLowerCase();
    if (TAG_OVERRIDES[lower]) return TAG_OVERRIDES[lower];
    return trimmed.split(' ').map(w => {
      const wl = w.toLowerCase();
      if (TAG_OVERRIDES[wl]) return TAG_OVERRIDES[wl];
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    }).join(' ');
  });
  // Dedupe post-normalization — a caller-supplied tag and an auto-detected
  // one (e.g. bulk-import.js's sport-genre detection alongside an explicit
  // --tags flag) can independently normalize to the same string. Confirmed
  // live: "Sports"/"Football" landing twice each on School Ties, Rudy, and
  // All the Right Moves.
  return [...new Set(normalized)];
}

function normalizeGenres(genres) {
  if (!Array.isArray(genres)) return genres;
  const result = [];
  for (const g of genres) {
    const parts = g.split(/\s*&\s*/);
    for (const p of parts) {
      const s = p.trim();
      if (!s) continue;
      if (/^sci[-\s]?fi$/i.test(s)) { result.push('Science Fiction'); continue; }
      result.push(s);
    }
  }
  return [...new Set(result)];
}

// ─── Sports genre inference (movies/TV) ────────────────────────────────────
// TMDB's own "Sports" genre is inconsistently applied — Varsity Blues, King
// Richard, The Legend of Bagger Vance, and The Greatest Game Ever Played all
// carry no genre signal at all, just plain Drama/Comedy. Detected instead by
// scanning title+description for a specific sport by name, which both
// confirms the item genuinely is a sports story AND identifies which sport —
// a bare "Sports" genre never says which one. Word-boundary matched so e.g.
// "golf" doesn't fire on an unrelated word containing it.
// Sports/Football/etc. are genres on this site (same tier as "Schools" below),
// not freeform tags — merged into the genres array by callers, not tags.
const SPORT_KEYWORDS = {
  Football:       [/\bfootballs?\b/i, /\bquarterbacks?\b/i, /\bnfl\b/i, /\bsuper bowl\b/i],
  Basketball:     [/\bbasketballs?\b/i, /\bnba\b/i, /\bslam dunks?\b/i],
  Baseball:       [/\bbaseballs?\b/i, /\bmajor league(?:s)? baseball\b/i, /\bworld series\b/i, /\blittle league\b/i],
  Soccer:         [/\bsoccer\b/i, /\bfifa\b/i, /\bworld cup\b/i],
  Tennis:         [/\btennis\b/i, /\bwimbledon\b/i, /\bgrand slam\b/i],
  Golf:           [/\bgolfers?\b/i, /\bgolfing\b/i, /\bgolf (?:tournament|course|swing|championship)\b/i, /\bpga\b/i],
  Boxing:         [/\bboxing\b/i, /\bboxers?\b/i, /\bheavyweight (?:champion|title|bout)\b/i],
  Wrestling:      [/\bwrestlings?\b/i, /\bwrestlers?\b/i],
  Hockey:         [/\bhockey\b/i, /\bnhl\b/i, /\bstanley cup\b/i],
  Swimming:       [/\bswimmers?\b/i, /\bswimming\b/i],
  Running:        [/\bmarathons?\b/i, /\btrack and field\b/i, /\bmiddle[- ]distance runners?\b/i],
  Cycling:        [/\bcyclists?\b/i, /\btour de france\b/i],
  Surfing:        [/\bsurfers?\b/i, /\bsurfing\b/i],
  Gymnastics:     [/\bgymnasts?\b/i, /\bgymnastics\b/i],
  'Ski Jumping':  [/\bski jump(?:ing|er)?\b/i],
  'Martial Arts': [/\bkarate\b/i, /\bkickbox(?:ing|ers?)\b/i, /\bmartial arts\b/i],
  Racing:         [/\bnascar\b/i, /\bformula (?:one|1)\b/i, /\bstock car racing\b/i],
};

function detectSportGenres(genres, title, description) {
  const text = `${title || ''} ${description || ''}`;
  const detected = new Set();
  if ((genres || []).includes('Sports')) detected.add('Sports');
  for (const [sport, patterns] of Object.entries(SPORT_KEYWORDS)) {
    if (patterns.some(p => p.test(text))) {
      detected.add('Sports');
      detected.add(sport);
    }
  }
  return [...detected];
}

// ─── Streaming-service tag inference (movies/TV) ───────────────────────────
// Unlike Sports/Schools above, a title's originating streaming platform is a
// franchise-style freeform label, not a classification — so it's a tag,
// matching the existing convention (Apple TV/Netflix/Amazon already used as
// tags on manually-added rows). Detected from TMDB's own `networks` (TV —
// the show's originating broadcaster/platform) and `production_companies`
// (movies — Netflix/Apple/Amazon list themselves as a production company on
// their own originals), not watch-provider availability, which would also
// catch titles merely licensed for streaming there rather than made for it.
const STREAMING_TAG_SOURCES = {
  'Apple TV': [/\bapple tv\+?\b/i, /\bapple studios\b/i, /\bapple original films\b/i],
  Netflix:    [/\bnetflix\b/i],
  Amazon:     [/\bamazon studios\b/i, /\bamazon mgm studios\b/i, /\bprime video\b/i, /\bamazon content services\b/i],
};

function detectStreamingTags(networks, productionCompanies) {
  const names = [...(networks || []), ...(productionCompanies || [])];
  const detected = new Set();
  for (const name of names) {
    for (const [tag, patterns] of Object.entries(STREAMING_TAG_SOURCES)) {
      if (patterns.some(p => p.test(name))) detected.add(tag);
    }
  }
  return [...detected];
}

// ─── Video game genre normalization ───────────────────────────────────────
// Unlike Open Library's freeform subject headings, IGDB's genre field is
// already a small controlled vocabulary (confirmed live: 34 distinct raw
// strings across 8,500+ games) — so this doesn't need book-genre-style
// keyword rules, just a direct cleanup map. Three problems in the raw IGDB
// names: awkward compound labels ("Hack and slash/Beat 'em up" — mapped to
// the cleaner umbrella term "Action"), redundant parenthetical abbreviations
// ("Role-playing (RPG)", "Turn-based strategy (TBS)"), and inconsistent
// splitting of "&"-joined names ("Card & Board Game" showing up standalone
// on some games alongside separately-split "Card"/"Board Game" on others —
// caused by some import paths not calling this normalizer at all; additive,
// so the combined form expands into both canonical tags rather than being
// dropped). Anything not in this map is kept as-is rather than dropped —
// IGDB's vocabulary is already curated, so an unrecognized value is more
// likely a genre this map hasn't been extended to cover yet than junk.
const VIDEO_GAME_GENRE_CANON = [
  'Action', 'Adventure', 'Platformer', 'Puzzle', 'Racing', 'Role-Playing',
  'Shooter', 'Simulation', 'Sports', 'Strategy', 'Turn-Based Strategy',
  'Real-Time Strategy', 'Tactical', 'Fighting', 'Arcade', 'Indie',
  'Point-and-Click', 'Visual Novel', 'Music', 'Card Game', 'Board Game',
  'Trivia', 'MOBA', 'Pinball', 'City Builder', 'Interactive Film',
  'Roguelike', 'Deck Builder',
];
const VIDEO_GAME_GENRE_MAP = {
  "hack and slash/beat 'em up": 'Action',
  'platform': 'Platformer',
  'role-playing (rpg)': 'Role-Playing',
  'rpg': 'Role-Playing',
  'simulator': 'Simulation',
  'sport': 'Sports',
  'turn-based strategy (tbs)': 'Turn-Based Strategy',
  'real time strategy (rts)': 'Real-Time Strategy',
  'point-and-click': 'Point-and-Click',
  'card': 'Card Game',
  'card & board game': ['Card Game', 'Board Game'],
  'quiz/trivia': 'Trivia',
  "rogue-like": 'Roguelike',
};

// IGDB's own genre taxonomy has no "Deck Builder" category — the closest it
// gets is "Card & Board Game" (mapped to Card Game + Board Game above), so a
// true deck-builder like Slay the Spire II or Across the Obelisk never gets
// it from IGDB's genre data alone (confirmed live: both list only Card
// Game/Board Game/Strategy despite their own IGDB summaries literally
// describing them as deckbuilders). Detected from title+description instead,
// the same pattern as detectSportGenres above. "Deck Builder" is already a
// recognized genre on this site (VIDEO_GAME_GENRE_CANON) — this is what
// actually populates it, since nothing did before.
function detectDeckBuilderGenre(title, description) {
  const text = `${title || ''} ${description || ''}`;
  return /\bdeck[\s-]?build(?:er|ers|ing)?\b/i.test(text) ? ['Deck Builder'] : [];
}

function normalizeGameGenres(genres) {
  if (!Array.isArray(genres)) return genres;
  const result = new Set();
  for (const raw of genres) {
    const trimmed = (raw || '').trim();
    if (!trimmed) continue;
    const mapped = VIDEO_GAME_GENRE_MAP[trimmed.toLowerCase()];
    if (Array.isArray(mapped)) mapped.forEach(m => result.add(m));
    else if (mapped) result.add(mapped);
    else result.add(trimmed);
  }
  return [...result];
}

// ─── Book genre normalization ─────────────────────────────────────────────
// Open Library's `subject` field (and to a lesser extent Google Books'
// `categories`) is a bag of Library-of-Congress-style subject headings, not
// genres — a single book routinely carries dozens of entries like "Married
// people", "Insurance agents", "Brothers and sisters", "Social life and
// customs" alongside the few that are real genres. Confirmed live against
// the full book catalog: 1,865 distinct raw genre strings across ~1,900
// books, the overwhelming majority appearing on just 1-2 books each — case
// variants, compound "X, fiction" forms, foreign-language duplicates, and
// pure subject-matter noise with nothing to do with genre.
//
// This is a curated, closed vocabulary: real, commonly-recognized genres
// only. Anything that doesn't map to one of these is dropped rather than
// kept as-is — a sparse-but-correct genre list beats a maximalist junk one.
const BOOK_GENRE_CANON = [
  'Fiction', 'Nonfiction', 'Literary Fiction', 'Classic Literature', 'Historical Fiction',
  'Fantasy', 'Epic Fantasy', 'Dark Fantasy', 'Urban Fantasy', 'Progression Fantasy', 'LitRPG', 'Romantasy',
  'Science Fiction', 'Space Opera', 'Dystopian', 'Cyberpunk', 'Paranormal', 'Superhero',
  'Mystery', 'Thriller', 'Crime', 'True Crime', 'Espionage', 'Horror',
  'Legal', 'Police', 'Medical', 'Courtroom', 'Schools',
  'Romance',
  'War', 'World War I', 'World War II', 'Vietnam War', 'Revolutionary War', 'Civil War', 'Korean War', 'Napoleonic Wars', 'Gulf War', 'Iraq War', 'War in Afghanistan',
  'Military', 'Western', 'Action', 'Adventure',
  'Young Adult', "Children's", 'Coming of Age',
  'Biography', 'Memoir', 'Poetry', 'Short Stories', 'Drama', 'Essays', 'Mythology & Fairy Tales',
  'Philosophy', 'Psychology', 'Politics', 'Religion', 'Science', 'Business', 'Self-Help', 'Travel', 'Sports', 'Humor', 'Graphic Novel',
  'Cooking', 'Health', 'Music', 'Art', 'History',
];
const BOOK_GENRE_CANON_MAP = new Map(BOOK_GENRE_CANON.map(g => [g.toLowerCase(), g]));

// Additive, not exclusive — checked against every raw genre string alongside
// (not instead of) BOOK_GENRE_RULES below, so a raw subject heading like
// "World War, 1939-1945" ends up contributing BOTH "War" (via the ordered
// rules) AND "World War II" (via this list), matching the site's convention
// that a broad genre and the more specific instance of it can coexist.
const SPECIFIC_WAR_RULES = [
  [/world war,?\s*1939-1945|world war ii\b|\bwwii\b/, 'World War II'],
  [/world war,?\s*1914-1918|world war i\b|\bwwi\b/, 'World War I'],
  [/vietnam/, 'Vietnam War'],
  [/revolutionary war/, 'Revolutionary War'],
  [/civil war/, 'Civil War'],
  [/korean war/, 'Korean War'],
  [/napoleonic/, 'Napoleonic Wars'],
  [/gulf war|desert storm/, 'Gulf War'],
  [/iraq war|war in iraq/, 'Iraq War'],
  [/afghan war|war in afghanistan/, 'War in Afghanistan'],
];

// Ordered specific-to-general keyword rules. First match wins, so subgenres
// (LitRPG, Progression Fantasy, Dark Fantasy...) are checked before the
// generic "Fantasy" catch-all, etc.
const BOOK_GENRE_RULES = [
  [/litrpg/, 'LitRPG'],
  [/progression fantasy/, 'Progression Fantasy'],
  [/romantasy/, 'Romantasy'],
  [/dark fantasy/, 'Dark Fantasy'],
  [/urban fantasy/, 'Urban Fantasy'],
  [/^epic$/, 'Epic Fantasy'], // bare "Epic" from split "Fantasy / Epic" style categories
  [/epic fantasy/, 'Epic Fantasy'],
  [/fantasy/, 'Fantasy'],
  [/space opera/, 'Space Opera'],
  [/cyberpunk/, 'Cyberpunk'],
  [/dystop|utopia/, 'Dystopian'],
  [/paranormal/, 'Paranormal'],
  [/science.?fiction|sci.?fi/, 'Science Fiction'],
  [/true crime/, 'True Crime'],
  [/mystery|detective/, 'Mystery'],
  [/thriller|suspense/, 'Thriller'],
  [/espionage|\bspies\b|\bspy\b/, 'Espionage'],
  [/crime/, 'Crime'],
  // Setting genres — same category names as SETTING_GENRE_VOCAB below (used
  // for TV), extended here to books since Open Library subject headings
  // ("Legal", "Police", "Schools, fiction"...) carry this signal directly,
  // unlike TMDB which needs the keyword-based detection SETTING_GENRE_VOCAB
  // does instead.
  [/legal|^law$/, 'Legal'],
  [/\bpolice\b/, 'Police'],
  [/medical|physicians|hospitals/, 'Medical'],
  [/courtroom|\btrial\b/, 'Courtroom'],
  [/\bschool/, 'Schools'],
  [/horror/, 'Horror'],
  [/romance/, 'Romance'],
  [/historical.*fiction|fiction.*historical/, 'Historical Fiction'],
  [/^historical"?$/, 'Historical Fiction'],
  [/world war|^war\b|war,/, 'War'],
  [/military/, 'Military'],
  [/western/, 'Western'],
  [/adventure/, 'Adventure'],
  [/^action$/, 'Action'],
  [/juvenile fiction|young adult/, 'Young Adult'],
  [/bildungsroman|coming.of.age/, 'Coming of Age'],
  [/^(juvenile|children)/, "Children's"],
  [/autobiography|memoir/, 'Memoir'],
  [/biography/, 'Biography'],
  [/poetry/, 'Poetry'],
  [/short stories/, 'Short Stories'],
  [/\bdrama\b|\bplays\b|theatre|theater/, 'Drama'],
  [/philosophy|ethics/, 'Philosophy'],
  [/psycholog/, 'Psychology'],
  [/politic/, 'Politics'],
  [/religio|christian|bible/, 'Religion'],
  [/fairy tale|mytholog|legend/, 'Mythology & Fairy Tales'],
  [/humorous|humor|comedy|satire|wit and humor/, 'Humor'],
  [/graphic novel|\bcomics\b/, 'Graphic Novel'],
  [/classic/, 'Classic Literature'],
  [/literary fiction/, 'Literary Fiction'],
  [/^fiction|, fiction$|fiction,/, 'Fiction'],
  [/^non.?fiction/, 'Nonfiction'],
  [/self.help/, 'Self-Help'],
  [/business/, 'Business'],
  [/travel/, 'Travel'],
  [/^science$/, 'Science'],
  [/sports/, 'Sports'],
  [/essays/, 'Essays'],
  [/cooking|recipe|cookbook/, 'Cooking'],
  [/\bhealth\b|fitness|diet|nutrition/, 'Health'],
  [/\bmusic\b|\brock\b/, 'Music'],
  [/\bart\b|photography|architecture/, 'Art'],
];

// Used by filterOpenLibraryGenres (mediaLookup.js) to prioritize genre-bearing
// subjects before that function's slice cap — Open Library returns subjects
// in arbitrary insertion order, not relevance order, so a real genre signal
// like "Juvenile fiction" can sit well past position 5 behind noise that
// isn't blocklisted but also isn't a genre ("Amistad", "Homeless persons",
// foreign-language subject duplicates like "Fluch"/"Familie"). Without this,
// the slice cap can starve out genuine signal before normalizeBookGenres
// above ever gets a chance to see it.
function looksLikeBookGenreSubject(raw) {
  const lower = (raw || '').trim().toLowerCase();
  if (!lower) return false;
  if (BOOK_GENRE_CANON_MAP.has(lower)) return true;
  if (BOOK_GENRE_RULES.some(([re]) => re.test(lower))) return true;
  if (SPECIFIC_WAR_RULES.some(([re]) => re.test(lower))) return true;
  return false;
}

function normalizeBookGenres(rawGenres) {
  if (!Array.isArray(rawGenres)) return [];
  const result = new Set();
  for (const raw of rawGenres) {
    const trimmed = (raw || '').trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    if (BOOK_GENRE_CANON_MAP.has(lower)) {
      result.add(BOOK_GENRE_CANON_MAP.get(lower));
    } else {
      const rule = BOOK_GENRE_RULES.find(([re]) => re.test(lower));
      if (rule) result.add(rule[1]);
      // No match — dropped. Non-genre subject headings ("Married people",
      // "Brothers and sisters", "open_syllabus_project", etc.) have no
      // canonical mapping and are deliberately discarded rather than kept.
    }
    // Specific-war sub-tagging runs independently of the block above, so
    // "World War, 1939-1945" contributes both "War" and "World War II".
    const warRule = SPECIFIC_WAR_RULES.find(([re]) => re.test(lower));
    if (warRule) { result.add('War'); result.add(warRule[1]); }
  }
  return [...result];
}

// ─── Setting genres (TV) ───────────────────────────────────────────────────
// Schools/Police/Legal/Courtroom/Medical — derived from TMDB per-show
// keyword data (see getTvKeywords in mediaLookup.js), matched by substring
// so compound keywords like "police corruption" still count as a Police
// signal. Deliberately excludes generic terms (bare "detective"/"fbi"/
// "sheriff"/"doctor") that fire on unrelated shows — see git history on
// this file and apply-setting-genres-tv.js for the false positives
// (Jessica Jones, The X-Files, Deadwood, Sherlock) that led to narrowing it.
const SETTING_GENRE_VOCAB = {
  Schools: ['school', 'elementary school', 'high school', 'middle school', 'boarding school', 'private school', 'elementary school teacher', 'high school teacher'],
  Police: ['police', 'police investigation', 'police procedural', 'homicide detective', 'nypd', 'lapd', 'female cop', 'male cop'],
  Legal: ['lawyer', 'law firm', 'legal drama', 'criminal law', 'corporate law', 'paralegal', 'attorney', 'district attorney', 'prosecutor'],
  Courtroom: ['courtroom drama', 'courtroom', 'trial', 'court case', 'jury'],
  Medical: ['medical', 'medicine', 'hospital', 'medical drama', 'emergency room'],
};

// Same idea as SETTING_GENRE_VOCAB but for movies/TV already tagged "War" —
// adds which specific war on top, mirroring the book genre cleanup's
// SPECIFIC_WAR_RULES (which uses Open Library subject headings; this uses
// TMDB keywords instead since that's the only per-title signal available
// for movies/TV). Used by apply-specific-war-genres.js.
const SPECIFIC_WAR_VOCAB = {
  'World War II': ['world war ii', 'wwii', 'nazi germany', 'holocaust', 'pearl harbor', 'normandy landings', 'd-day'],
  'World War I': ['world war i', 'wwi', 'trench warfare', 'western front'],
  'Vietnam War': ['vietnam war', 'viet cong', 'saigon'],
  'Korean War': ['korean war'],
  'Civil War': ['american civil war', 'confederacy', 'unionist'],
  'Revolutionary War': ['american revolution', 'american revolutionary war'],
  'Napoleonic Wars': ['napoleonic wars', 'napoleon bonaparte'],
  'Gulf War': ['gulf war', 'operation desert storm'],
  'Iraq War': ['iraq war', 'war in iraq'],
  'War in Afghanistan': ['war in afghanistan', 'afghanistan war'],
};

// Word-boundary substring match, not plain .includes() — confirmed live
// that plain substring matching false-positives here: "world war i" is a
// literal substring of "world war ii" (same characters up to the second
// "i"), so every WWII keyword match was also incorrectly firing "World War
// I". \b after a word-character term correctly requires a non-word-char
// (or end of string) boundary, so "world war i" no longer matches inside
// "world war ii" while still matching "world war i" and "world war i film".
function termMatches(term, keyword) {
  return new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(keyword);
}

function settingGenresFor(keywords, vocab = SETTING_GENRE_VOCAB) {
  const matched = [];
  for (const [genre, terms] of Object.entries(vocab)) {
    if (terms.some(t => keywords.some(k => termMatches(t, k)))) matched.push(genre);
  }
  return matched;
}

// Lowercased, punctuation-stripped title for punctuation-insensitive search —
// e.g. "L.A. Confidential" and "la confidential" both normalize to the same
// "la confidential", so searching either one matches the title regardless of
// how it's actually punctuated. Kept as its own stored/indexed column
// (MediaItem.normalizedTitle) rather than computed at query time, since an
// unindexed per-row string transform across the whole catalog doesn't scale.
function normalizeTitleForSearch(title) {
  return (title || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '') // strip punctuation, keep letters/digits/spaces (unicode-aware)
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Slugs ─────────────────────────────────────────────────────────────────
function slugify(title, year) {
  const base = title.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');
  return year ? `${base}-${year}` : base;
}

async function uniqueSlug(base) {
  let slug = base, i = 1;
  while (await prisma.mediaItem.findUnique({ where: { slug } })) slug = `${base}-${i++}`;
  return slug;
}

// ─── Person relations ────────────────────────────────────────────────────
// Shared upsert step behind connectPersons/connectCast below — every person
// name becomes a real Person row (matched/created by a slugified version of
// the name), in the SAME order the names array was given. Promise.all
// preserves input order in its results regardless of which upsert actually
// resolves first, which connectCast below depends on to capture billing
// order — don't swap this for sequential awaits assuming it'd be "more
// correct"; order preservation is exactly why Promise.all is used here.
async function upsertPersonsByName(names) {
  return Promise.all(names.map(name => {
    const personSlug = name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    return prisma.person.upsert({
      where: { slug: personSlug },
      update: { name },
      create: { name, slug: personSlug },
    });
  }));
}

// connectPersons builds the Prisma relation payload for directors/authors
// (cast should use connectCast below instead — see its comment for why).
// isUpdate=true  → uses {set:[...]} which replaces the full relation (correct for PATCH)
// isUpdate=false → uses {connect:[...]} which adds relations (correct for CREATE)
// Empty names + isUpdate → {set:[]} removes all; empty + create → undefined (skip field)
async function connectPersons(names, isUpdate = false) {
  if (!names?.length) {
    return isUpdate ? { set: [] } : undefined;
  }
  const persons = await upsertPersonsByName(names);
  const ids = persons.map(p => ({ id: p.id }));
  return isUpdate ? { set: ids } : { connect: ids };
}

// Cast specifically needs billing order preserved, which connectPersons
// alone can't provide — `cast` is an implicit many-to-many relation, so
// Prisma has no extra column to hang a per-relation order off of, and
// Postgres doesn't guarantee row order for a SELECT without ORDER BY. This
// returns BOTH the relation payload (spread as `cast` into the caller's
// data) and a parallel `castOrder` array of person ids in the order `names`
// was given — write both together so they never drift apart. Read sites
// (media.js's GET /:slug, prerender.js, admin.js) sort the fetched cast
// list by castOrder's index.
async function connectCast(names, isUpdate = false) {
  if (!names?.length) {
    return { cast: isUpdate ? { set: [] } : undefined, castOrder: [] };
  }
  const persons = await upsertPersonsByName(names);
  const ids = persons.map(p => p.id);
  return {
    cast: isUpdate ? { set: ids.map(id => ({ id })) } : { connect: ids.map(id => ({ id })) },
    castOrder: ids,
  };
}

// Sorts a fetched cast array into billing order using castOrder (an id
// array — see the MediaItem.castOrder schema comment). Falls back to
// alphabetical-by-name when castOrder is empty (any item added before this
// field existed) rather than leaving order at Postgres's undefined native
// SELECT order for an implicit many-to-many relation. Anyone in `cast` but
// missing from castOrder (e.g. a TV season's merged-in parent-only
// regulars, which live in the PARENT's own castOrder, not this row's) sorts
// after everyone ranked, alphabetically among themselves — never dropped.
function sortByCastOrder(cast, castOrder) {
  if (!cast?.length) return cast || [];
  if (!castOrder?.length) return [...cast].sort((a, b) => a.name.localeCompare(b.name));
  const rank = new Map(castOrder.map((id, i) => [id, i]));
  return [...cast].sort((a, b) => {
    const ra = rank.has(a.id) ? rank.get(a.id) : Infinity;
    const rb = rank.has(b.id) ? rank.get(b.id) : Infinity;
    return ra !== rb ? ra - rb : a.name.localeCompare(b.name);
  });
}

// Title normalization for BOOK duplicate matching — an exact (even
// case-insensitive) string match misses real near-duplicates: leading
// articles ("Blue Mage Raised by Dragons" vs "The Blue Mage Raised by
// Dragons"), spelled-out vs numeral volume numbers ("Volume One:
// 1920–1963" vs "Volume 1"), and parenthetical edition/tie-in noise. Both
// of these are confirmed-live misses, not hypothetical.
const NUMBER_WORDS = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10' };
function normalizeBookTitle(t) {
  let s = (t || '').toLowerCase();
  s = s.replace(/\s*\([^)]*\)\s*/g, ' ');   // strip parenthetical edition/series notes
  // NOTE: deliberately does NOT truncate at colon — "Mother of Learning:
  // Arc 1" vs "Arc 4" and "The Land: Founding" vs "Forging" showed live
  // that the text after a colon is often the part that distinguishes
  // different volumes in a series, not decorative subtitle fluff. Blindly
  // stripping it caused real false-positive matches between genuinely
  // different books. See bookTitlesMatch() for how the remaining
  // same-book-different-subtitle-completeness case (e.g. "Volume One:
  // 1920–1963" vs "Volume 1") is handled more conservatively instead.
  s = s.replace(/^(the|a|an)\s+/i, '');       // strip leading article
  s = s.replace(/[^a-z0-9\s]/g, ' ');
  s = s.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/g, w => NUMBER_WORDS[w]);
  return s.replace(/\s+/g, ' ').trim();
}

// Exact match after normalization ONLY — deliberately no prefix/fuzzy
// leniency. A prefix-match variant was tried and tried again (60% length
// floor, requiring a trailing space) and still produced two different
// false-positive patterns live: "Mother of Learning: Arc 1" vs "Arc 4"
// (colon+suffix distinguishes volumes) and "He Who Fights With Monsters"
// vs "...Monsters 2" (bare trailing number distinguishes volumes) both
// matched as "the same book" when they're sequential, genuinely different
// entries. Numbered-series naming is too common in this catalog (LitRPG/
// fantasy series) for prefix-matching to be safe. A same-book-different-
// subtitle-completeness case (e.g. "Volume One: 1920–1963" vs "Volume 1")
// will be missed by exact-match — that's an acceptable false negative
// (occasional uncaught duplicate, fixable later) vs. the false positive
// risk of deleting a real, different book.
function bookTitlesMatch(a, b) {
  const na = normalizeBookTitle(a), nb = normalizeBookTitle(b);
  return !!na && na === nb;
}

// ─── Duplicate detection ──────────────────────────────────────────────────
// Mirrors GET /api/admin/check-duplicate — checks by external ID first
// (most reliable), then falls back to a case-insensitive title match.
async function findDuplicate({ title, mediaType, tmdbId, igdbId, openLibraryId, releaseYear, authors }) {
  const idChecks = [];
  if (tmdbId) {
    const tmdbCheck = { tmdbId };
    if (mediaType === 'MOVIE')   tmdbCheck.mediaType = 'MOVIE';
    if (mediaType === 'TV_SHOW') tmdbCheck.mediaType = 'TV_SHOW';
    idChecks.push(tmdbCheck);
  }
  if (igdbId)        idChecks.push({ openCriticId: igdbId });
  if (openLibraryId) idChecks.push({ goodreadsId: openLibraryId });

  if (idChecks.length) {
    const idMatch = await prisma.mediaItem.findFirst({ where: { OR: idChecks } });
    if (idMatch) return idMatch;
  }

  if (title) {
    // BOOKS: an exact title+author match is virtually always the same work
    // in a different edition, not a genuine remake — and Google Books'
    // release-year data for self-published/indie titles is proven
    // unreliable (confirmed live: "House of Blades" resolved to 2026
    // instead of its real 2013, a 13-year gap that slipped past the ±2
    // year guard below and created a true duplicate). So for BOOK, match on
    // title+author with no year constraint at all, checked first.
    if (mediaType === 'BOOK' && authors?.length) {
      // Fetch every book by any of these authors, then compare normalized
      // titles in JS — Prisma/Postgres can't apply the article-stripping /
      // number-word / parenthetical normalization above inside a WHERE
      // clause, and an author's book count is small enough that this is
      // cheap.
      const byAuthor = await prisma.mediaItem.findMany({
        where: { mediaType: 'BOOK', authors: { some: { name: { in: authors, mode: 'insensitive' } } } },
      });
      const authorMatch = byAuthor.find(b => bookTitlesMatch(b.title, title));
      if (authorMatch) return authorMatch;
    }

    const titleMatch = await prisma.mediaItem.findFirst({
      where: {
        title: { equals: title.trim(), mode: 'insensitive' },
        mediaType,
        // Guard against an unrelated film/show that happens to share an exact
        // title from a different era (West Side Story 1961 vs. 2021, The
        // Color Purple 1985 vs. 2023, etc.) — a title-only match only counts
        // as the same work when release years are close. No year given (or
        // no releaseYear on the existing row) falls back to the old behavior.
        ...(releaseYear ? { OR: [{ releaseYear: null }, { releaseYear: { gte: releaseYear - 2, lte: releaseYear + 2 } }] } : {}),
      },
    });
    if (titleMatch) return titleMatch;
  }

  return null;
}

// A real series always shares at least one author across every book in it —
// even the Wheel of Time, which adds Brandon Sanderson as co-author for its
// last 3 books, still has Robert Jordan on all 14. So "same seriesName, zero
// shared authors" reliably means two DIFFERENT authors' series that just
// happen to have the same name (confirmed live: Brandon Mull's and Toby
// Neighbors' unrelated "Five Kingdoms" series) — not one continuous series.
// Warn-but-allow, not a hard block: same real-world resolution as the Five
// Kingdoms case itself (flagged, then a human decided how to proceed).
async function checkSeriesCollision(seriesName, authorNames) {
  if (!seriesName || !authorNames?.length) return null;

  const existing = await prisma.mediaItem.findMany({
    where: { mediaType: 'BOOK', seriesName: { equals: seriesName, mode: 'insensitive' } },
    select: { authors: { select: { name: true } } },
  });
  if (!existing.length) return null;

  const newNames = new Set(authorNames.map(n => n.toLowerCase()));
  const collidingAuthors = new Set();
  let anyOverlap = false;
  for (const item of existing) {
    const itemNames = item.authors.map(a => a.name);
    if (itemNames.some(n => newNames.has(n.toLowerCase()))) {
      anyOverlap = true;
    } else {
      itemNames.forEach(n => collidingAuthors.add(n));
    }
  }
  if (anyOverlap || !collidingAuthors.size) return null;

  return { seriesName, collidingAuthors: [...collidingAuthors] };
}

module.exports = {
  clusterBookSeries,
  pickSeriesRepresentative,
  normalizeTags,
  normalizeGenres,
  detectSportGenres,
  detectStreamingTags,
  detectDeckBuilderGenre,
  normalizeGameGenres,
  VIDEO_GAME_GENRE_CANON,
  normalizeBookGenres,
  looksLikeBookGenreSubject,
  BOOK_GENRE_CANON,
  settingGenresFor,
  SETTING_GENRE_VOCAB,
  SPECIFIC_WAR_VOCAB,
  normalizeTitleForSearch,
  slugify,
  uniqueSlug,
  connectPersons,
  connectCast,
  sortByCastOrder,
  findDuplicate,
  checkSeriesCollision,
  normalizeBookTitle,
  bookTitlesMatch,
};

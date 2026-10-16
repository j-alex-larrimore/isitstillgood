// Default usernames, derived from a display name.
//
//   "Annie Hooper"      -> AnnieH
//   "Mary Jane Watson"  -> MaryW      (first name, last initial)
//   "Madonna"           -> Madonna    (nothing to take an initial from)
//   "José Álvarez"      -> JoseA      (accents folded, not dropped)
//
// Used when someone registers without choosing one, and for Google
// sign-ups, which never ask. Both go through here so the site has one
// convention rather than two — Google accounts used to come out as
// "annie_hooper" while the form demanded a username up front.
//
// The result always satisfies the same rule the form does,
// /^[a-zA-Z0-9_]{3,30}$/, because it is written to the same column and
// read back by the same routes.
const prisma = require('./prisma');

const MIN = 3, MAX = 30;

// Fold accents to ASCII rather than discarding the letter: "José" should
// become "Jose", not "Jos".
function fold(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function baseFromName(displayName) {
  // Split on whitespace only, then strip punctuation inside each word.
  // Splitting on punctuation too would read "Anne-Marie O'Neill" as four
  // words and take the initial from "Neill", giving AnneN instead of
  // AnneMarieO — the hyphen is part of her first name and the apostrophe
  // part of her surname.
  const words = fold(displayName)
    .split(/\s+/)
    .map(w => w.replace(/[^a-zA-Z0-9]/g, ''))
    .filter(Boolean);
  if (!words.length) return '';
  // Capitalise the leading letter and the initial, and leave the rest as
  // typed: "annie hooper" should give AnnieH rather than annieh, but
  // lowercasing the remainder would turn McDonald into Mcdonald.
  const up = w => w.charAt(0).toUpperCase() + w.slice(1);
  const first = up(words[0]);
  // One word is a whole name on its own — Madonna, Prince, Cher.
  const initial = words.length > 1 ? words[words.length - 1][0].toUpperCase() : '';
  return (first + initial).slice(0, MAX);
}

// Last resorts, in order: the email's local part, then a plain word. Both
// still go through the collision loop below, so neither can collide.
function baseFromEmail(email) {
  return fold(String(email || '').split('@')[0]).replace(/[^a-zA-Z0-9]/g, '').slice(0, MAX);
}

function pad(base) {
  // "Jo L" gives "JoL" which is fine, but "Al" alone is two characters and
  // the column wants three. Padding with a zero keeps it readable and the
  // collision loop will still number it if that is taken too.
  let b = base;
  while (b.length < MIN) b += '0';
  return b;
}

/**
 * A username nobody holds yet. Numbered from 2 on collision, because the
 * first person to want it has the unnumbered one and the next is the
 * second of that name: AnnieH, AnnieH2, AnnieH3.
 */
async function generateUsername(displayName, email) {
  let base = baseFromName(displayName) || baseFromEmail(email) || 'user';
  base = pad(base);

  if (!await prisma.user.findUnique({ where: { username: base } })) return base;

  for (let n = 2; n < 10000; n++) {
    // Trim the base so the number always fits inside the 30-char limit.
    const suffix = String(n);
    const candidate = base.slice(0, MAX - suffix.length) + suffix;
    if (!await prisma.user.findUnique({ where: { username: candidate } })) return candidate;
  }
  // Astronomically unlikely, and better than looping forever.
  throw new Error('could not find a free username for ' + base);
}

module.exports = { generateUsername, baseFromName, baseFromEmail, pad };

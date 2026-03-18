// prisma/seed.js — Run with: npm run db:seed
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // ─── People ───────────────────────────────────────────────────────────────
  const coppola  = await upsertPerson({ name: 'Francis Ford Coppola', slug: 'francis-ford-coppola', birthYear: 1939 });
  const marlon   = await upsertPerson({ name: 'Marlon Brando',        slug: 'marlon-brando',        birthYear: 1924 });
  const alpacino = await upsertPerson({ name: 'Al Pacino',            slug: 'al-pacino',            birthYear: 1940 });
  const miyazaki = await upsertPerson({ name: 'Hayao Miyazaki',       slug: 'hayao-miyazaki',       birthYear: 1941 });
  const tartt    = await upsertPerson({ name: 'Donna Tartt',          slug: 'donna-tartt',          birthYear: 1963 });
  const teuber   = await upsertPerson({ name: 'Klaus Teuber',         slug: 'klaus-teuber',         birthYear: 1952 });
  console.log('  ✓ People');

  // ─── Media Items ──────────────────────────────────────────────────────────
  const godfather = await upsertMedia({
    mediaType: 'MOVIE', title: 'The Godfather', slug: 'the-godfather-1972', releaseYear: 1972,
    description: 'The aging patriarch of an organized crime dynasty transfers control of his clandestine empire to his reluctant son.',
    genres: ['Crime', 'Drama'], imdbId: 'tt0068646', imdbRating: 9.2, rtScore: 97,
    runtime: 175, mpaaRating: 'R', streamingOn: ['Paramount+'],
    directors: { connect: [{ id: coppola.id }] }, cast: { connect: [{ id: marlon.id }, { id: alpacino.id }] },
  });

  const mononoke = await upsertMedia({
    mediaType: 'MOVIE', title: 'Princess Mononoke', slug: 'princess-mononoke-1997', releaseYear: 1997,
    description: "On a journey to find the cure for a Tatarigami's curse, Ashitaka finds himself in the middle of a war between forest gods and a mining colony.",
    genres: ['Animation', 'Fantasy', 'Adventure'], imdbId: 'tt0119698', imdbRating: 8.4, rtScore: 94,
    runtime: 134, mpaaRating: 'PG-13', streamingOn: ['Max'],
    directors: { connect: [{ id: miyazaki.id }] },
  });

  const secretHistory = await upsertMedia({
    mediaType: 'BOOK', title: 'The Secret History', slug: 'the-secret-history-1992', releaseYear: 1992,
    description: 'A small group of classics students at a New England college become entangled in a murder mystery of their own making.',
    genres: ['Literary Fiction', 'Mystery', 'Thriller'], goodreadsRating: 4.15,
    pageCount: 524, publisher: 'Knopf', isbn: '978-1400031702',
    authors: { connect: [{ id: tartt.id }] },
  });

  const catan = await upsertMedia({
    mediaType: 'BOARD_GAME', title: 'Catan', slug: 'catan-1995', releaseYear: 1995,
    description: 'Players take on the roles of settlers, each attempting to build and develop holdings while trading and acquiring resources.',
    genres: ['Strategy', 'Trading', 'Family'], minPlayers: 3, maxPlayers: 4, playTimeMinutes: 90,
    designers: { connect: [{ id: teuber.id }] }, publishers: ['Kosmos', 'Mayfair Games'],
  });

  const theWire = await upsertMedia({
    mediaType: 'TV_SHOW', title: 'The Wire', slug: 'the-wire-2002', releaseYear: 2002,
    description: 'The Baltimore drug scene, as seen through the eyes of drug dealers and law enforcement.',
    genres: ['Crime', 'Drama', 'Thriller'], imdbId: 'tt0306414', imdbRating: 9.3, rtScore: 94,
    seasons: 5, episodes: 60, streamingOn: ['Max'],
  });
  console.log('  ✓ Media items');

  // ─── Users ────────────────────────────────────────────────────────────────
  const hash = await bcrypt.hash('password123', 12);
  const marco = await upsertUser({ email: 'marco@example.com', username: 'marcov', displayName: 'Marco V.', passwordHash: hash, bio: 'Cinema first. Everything else second.' });
  const priya = await upsertUser({ email: 'priya@example.com', username: 'priyak', displayName: 'Priya K.', passwordHash: hash, bio: 'Literary fiction aficionado & board game loser.' });
  const dan   = await upsertUser({ email: 'dan@example.com',   username: 'danc',   displayName: 'Dan C.',   passwordHash: hash, bio: 'BGG top 100 completionist. Currently: failing.' });
  const sasha = await upsertUser({ email: 'sasha@example.com', username: 'sashaw', displayName: 'Sasha W.', passwordHash: hash, bio: 'TV > movies. Fight me.' });
  const tom   = await upsertUser({ email: 'tom@example.com',   username: 'tomh',   displayName: 'Tom H.',   passwordHash: hash });
  console.log('  ✓ Users');

  // ─── Friendships ──────────────────────────────────────────────────────────
  for (const [a, b] of [[marco, priya],[marco, dan],[marco, sasha],[priya, dan],[sasha, tom]]) {
    await upsertFriendship(a.id, b.id);
  }
  console.log('  ✓ Friendships');

  // ─── Reviews ──────────────────────────────────────────────────────────────
  const reviews = [
    { userId: marco.id, mediaItemId: godfather.id,     rating: 10, verdict: 'TIMELESS',   reviewText: 'Rewatched for the fifth time. The scene with the oranges still hits different. Cinema, full stop.' },
    { userId: sasha.id, mediaItemId: godfather.id,     rating: 9,  verdict: 'TIMELESS',   reviewText: 'A perfect film. Nothing feels wasted.' },
    { userId: priya.id, mediaItemId: secretHistory.id, rating: 8,  verdict: 'STILL_GOOD', reviewText: 'The autumn aesthetics aged perfectly. Better appreciated now than at 19.', spoilerText: "The reveal of Bunny's death being planned all along makes the early chapters sing on a reread." },
    { userId: dan.id,   mediaItemId: catan.id,         rating: 6,  verdict: 'MIXED',      reviewText: 'Introduced three new people to it. Two loved it, one quit at turn 12. Classic Catan.' },
    { userId: marco.id, mediaItemId: catan.id,         rating: 7,  verdict: 'STILL_GOOD', reviewText: 'Gateway game that actually works. The trading mechanic is timeless.' },
    { userId: sasha.id, mediaItemId: theWire.id,       rating: 10, verdict: 'TIMELESS',   reviewText: 'Season 4 is still the greatest piece of American television. Omar coming.' },
    { userId: marco.id, mediaItemId: mononoke.id,      rating: 10, verdict: 'TIMELESS',   reviewText: "No heroes, no villains. Just people and nature grinding against each other. Miyazaki's masterpiece." },
    { userId: tom.id,   mediaItemId: secretHistory.id, rating: 7,  verdict: 'STILL_GOOD', reviewText: 'More readable than I remembered. The dark academia thing has left a mark on culture.' },
  ];
  for (const r of reviews) await upsertReview({ visibility: 'PUBLIC', isRevisit: false, ...r });
  console.log('  ✓ Reviews');

  console.log('\n✅ Seed complete!\nTest credentials: marco@example.com / password123');
}

async function upsertPerson(data) {
  return prisma.person.upsert({ where: { slug: data.slug }, update: {}, create: data });
}
async function upsertMedia({ directors, cast, authors, designers, publishers, platforms, streamingOn, ...data }) {
  return prisma.mediaItem.upsert({
    where: { slug: data.slug }, update: {},
    create: { ...data, publishers: publishers||[], platforms: platforms||[], streamingOn: streamingOn||[], directors, cast, authors, designers },
  });
}
async function upsertUser(data) {
  return prisma.user.upsert({
    where: { email: data.email }, update: {},
    create: { ...data, lists: { create: [{ title: 'Want to Watch / Read / Play', isPublic: true }, { title: 'All-Time Favorites', isPublic: true }] } },
  });
}
async function upsertFriendship(initiatorId, receiverId) {
  const existing = await prisma.friendship.findFirst({ where: { OR: [{ initiatorId, receiverId }, { initiatorId: receiverId, receiverId: initiatorId }] } });
  if (existing) return existing;
  return prisma.friendship.create({ data: { initiatorId, receiverId, status: 'ACCEPTED' } });
}
async function upsertReview(data) {
  return prisma.review.upsert({
    where: { userId_mediaItemId: { userId: data.userId, mediaItemId: data.mediaItemId } },
    update: {}, create: data,
  });
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());

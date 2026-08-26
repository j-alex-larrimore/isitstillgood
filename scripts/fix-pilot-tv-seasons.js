// One-off correction for the two pilot shows created by
// import-tv-show-with-seasons.js before the "season cast = guest stars
// only" fix: strips main-cast names out of each season's cast relation,
// and adds the School genre to Abbott Elementary.
require('dotenv').config();
const prisma = require('../src/lib/prisma');
const { connectCast } = require('../src/lib/mediaHelpers');

async function main() {
  for (const slug of ['only-murders-in-the-building-2021', 'abbott-elementary-2021']) {
    const item = await prisma.mediaItem.findUnique({
      where: { slug },
      include: { seasonEntries: { include: { cast: { select: { name: true } } } }, cast: { select: { name: true } } },
    });
    const mainCastNames = new Set(item.cast.map(c => c.name.toLowerCase()));

    for (const season of item.seasonEntries) {
      const guestCast = season.cast.map(c => c.name).filter(name => !mainCastNames.has(name.toLowerCase()));
      const castData = await connectCast(guestCast, true);
      await prisma.mediaItem.update({
        where: { id: season.id },
        data: { cast: castData.cast, castOrder: castData.castOrder },
      });
      console.log(`${item.title} S${season.seasonNumber}: cast -> [${guestCast.join(', ') || 'none'}]`);
    }
  }

  await prisma.mediaItem.update({
    where: { slug: 'abbott-elementary-2021' },
    data: { genres: { push: 'School' } },
  });
  console.log('Added School genre to Abbott Elementary.');

  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });

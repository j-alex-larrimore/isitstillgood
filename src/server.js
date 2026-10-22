// src/server.js
require('dotenv').config();
const app = require('./app');
// The same client the routes use (src/lib/prisma). This used to construct its
// own, which made both uses below misleading: the startup $connect() opened a
// pool nothing served requests from, and the shutdown $disconnect() drained
// that idle pool while leaving the real one open — so Railway's SIGTERM on
// redeploy never actually closed the connections in use.
const prisma = require('./lib/prisma');

const PORT = process.env.PORT || 3001;

/* Railway's private network (postgres.railway.internal) is IPv6 and finishes
   initialising a moment AFTER the container starts, so a connect on the first
   tick can fail with P1001 while the database is perfectly healthy. Without a
   retry that exits the process, Railway restarts it, and the restart races the
   same window — which is how a working configuration turns into a crash loop.
   US West has also had spells of transient private-network failures that
   resolve in seconds on their own.

   Roughly 31s of total patience across 8 attempts: long enough to outlast the
   network coming up or a brief blip, short enough that a genuinely wrong
   DATABASE_URL still fails the deploy rather than hanging it.

   Harmless on the public proxy, where the first attempt simply succeeds. */
async function connectWithRetry(attempts = 8, baseDelayMs = 500) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await prisma.$connect();
      return i;
    } catch (err) {
      if (i === attempts) throw err;
      const wait = Math.min(baseDelayMs * 2 ** (i - 1), 8000);
      console.warn(
        `⏳  Database unreachable (attempt ${i}/${attempts}: ${err.code || err.message}) — retrying in ${wait}ms`
      );
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

async function main() {
  try {
    const attempts = await connectWithRetry();
    // Says whether retries were needed. On the private network this line is
    // the signal to watch: a steady "after N attempts" means the race is real
    // and not just a one-off.
    console.log(attempts === 1
      ? '✅  Database connected'
      : `✅  Database connected (after ${attempts} attempts)`);

    app.listen(PORT, () => {
      console.log(`🚀  Server running on http://localhost:${PORT}`);
      console.log(`📄  Environment: ${process.env.NODE_ENV}`);
    });
  } catch (err) {
    console.error('❌  Failed to start server:', err);
    process.exit(1);
  }
}

main();

// Graceful shutdown
process.on('SIGINT',  async () => { await prisma.$disconnect(); process.exit(0); });
process.on('SIGTERM', async () => { await prisma.$disconnect(); process.exit(0); });

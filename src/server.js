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

async function main() {
  try {
    await prisma.$connect();
    console.log('✅  Database connected');

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

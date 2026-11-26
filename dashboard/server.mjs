// Excellent Mind — school dashboard server (Vercel + Neon Postgres or local Node.js).
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { getConfig, handleRequest } from './lib/handler.mjs';

export default function handler(req, res) {
  return handleRequest(req, res, { serveFiles: true });
}

if (!process.env.VERCEL) {
  const PORT = Number(process.env.PORT ?? 4000);
  const config = getConfig();
  const server = createServer((req, res) => handleRequest(req, res, { serveFiles: true }));

  server.listen(PORT, () => {
    const ips = Object.values(networkInterfaces())
      .flat()
      .filter((n) => n && n.family === 'IPv4' && !n.internal)
      .map((n) => n.address);
    console.log('\nExcellent Mind school dashboard is running.\n');
    console.log(`  Dashboard (this PC):   http://localhost:${PORT}`);
    ips.forEach((ip) => console.log(`  Tablets & other PCs:   http://${ip}:${PORT}`));
    console.log(`\n  School name:     ${config.schoolName}`);
    console.log(`  School key:      ${config.schoolKey}   (enter on each tablet: Settings > School dashboard)`);
    console.log(`  Admin password:  ${config.adminPassword}   (for the web dashboard)`);
    console.log(`  Database:        ${process.env.DATABASE_URL || process.env.POSTGRES_URL ? 'Neon Postgres (configured)' : 'DATABASE_URL not set'}\n`);
  });
}

// Excellent Mind — school dashboard server (Vercel Zero-Config Node.js + Neon Postgres).
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { neon } from '@neondatabase/serverless';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(here, 'public');
const MAX_BODY = 5 * 1024 * 1024;
const SESSION_MS = 12 * 3600 * 1000;
const BANDS = ['delta', 'theta', 'lowAlpha', 'highAlpha', 'lowBeta', 'highBeta', 'lowGamma', 'midGamma'];
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const str = (v, max = 120) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const int = (v) => (num(v) == null ? null : Math.round(v));
const bandsOf = (b) =>
  Array.isArray(b) && b.length === 8 && b.every((x) => num(x) != null)
    ? JSON.stringify(b.map(Number))
    : null;

/* ---------------- config ---------------- */

let cachedConfig = null;

function readable(n) {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(randomBytes(n), (b) => abc[b % abc.length]).join('');
}

function getConfig() {
  if (cachedConfig) return cachedConfig;

  const isVercel = Boolean(process.env.VERCEL);
  let fileCfg = null;

  if (!isVercel) {
    const dataDir = process.env.DATA_DIR ?? join(here, 'data');
    mkdirSync(dataDir, { recursive: true });
    const cfgPath = join(dataDir, 'config.json');
    fileCfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : null;
    if (!fileCfg) {
      fileCfg = {
        schoolName: 'My School',
        schoolKey: `EM-${readable(4)}-${readable(4)}`,
        adminPassword: readable(10),
      };
      writeFileSync(cfgPath, JSON.stringify(fileCfg, null, 2));
    }
  }

  const adminPassword = process.env.ADMIN_PASSWORD || process.env.ADMIN_PASS || fileCfg?.adminPassword || '';
  cachedConfig = {
    schoolName: process.env.SCHOOL_NAME || fileCfg?.schoolName || 'My School',
    schoolKey: process.env.SCHOOL_KEY || fileCfg?.schoolKey || '',
    adminPassword,
    sessionSecret: process.env.SESSION_SECRET || adminPassword,
  };
  return cachedConfig;
}

/* ---------------- Neon Postgres ---------------- */

let sqlClient = null;
let initPromise = null;

function getSql() {
  if (!sqlClient) {
    const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!url) {
      throw new Error('DATABASE_URL is not set. Connect Neon Postgres in your Vercel project Storage tab.');
    }
    sqlClient = neon(url);
  }
  return sqlClient;
}

async function ensureSchema() {
  const sql = getSql();
  if (!initPromise) {
    initPromise = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS devices (
          id TEXT PRIMARY KEY,
          name TEXT,
          last_sync BIGINT,
          first_seen BIGINT
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS children (
          id TEXT PRIMARY KEY,
          device_id TEXT,
          first_name TEXT,
          last_name TEXT,
          birthday TEXT,
          gender TEXT,
          student_id TEXT,
          class_name TEXT,
          updated_at BIGINT
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS activities (
          id TEXT PRIMARY KEY,
          child_id TEXT NOT NULL,
          at BIGINT,
          game TEXT,
          protocol TEXT,
          score INTEGER,
          avg INTEGER,
          att INTEGER,
          med INTEGER,
          pct_above INTEGER,
          stars INTEGER,
          duration_sec INTEGER,
          bands TEXT,
          received_at BIGINT
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS activities_child ON activities (child_id, at)
      `;
    })().catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  await initPromise;
  return sql;
}

async function syncData(body) {
  const sql = await ensureSchema();
  const now = Date.now();
  const device = body?.device ?? {};
  const deviceId = str(device.id, 80) || 'unknown';
  const deviceName = str(device.name, 80) || 'Tablet';

  const queries = [
    sql`
      INSERT INTO devices (id, name, last_sync, first_seen)
      VALUES (${deviceId}, ${deviceName}, ${now}, ${now})
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        last_sync = EXCLUDED.last_sync
    `,
  ];

  const activityQueryIndices = [];

  for (const c of Array.isArray(body?.children) ? body.children.slice(0, 500) : []) {
    const id = str(c.id, 80);
    if (!id) continue;
    queries.push(
      sql`
        INSERT INTO children (id, device_id, first_name, last_name, birthday, gender, student_id, class_name, updated_at)
        VALUES (${id}, ${deviceId}, ${str(c.firstName)}, ${str(c.lastName)}, ${str(c.birthday, 20)}, ${str(c.gender, 10)}, ${str(c.studentId, 40)}, ${str(c.className, 40)}, ${now})
        ON CONFLICT (id) DO UPDATE SET
          device_id = EXCLUDED.device_id,
          first_name = EXCLUDED.first_name,
          last_name = EXCLUDED.last_name,
          birthday = EXCLUDED.birthday,
          gender = EXCLUDED.gender,
          student_id = EXCLUDED.student_id,
          class_name = EXCLUDED.class_name,
          updated_at = EXCLUDED.updated_at
      `,
    );

    for (const a of Array.isArray(c.activities) ? c.activities.slice(0, 2000) : []) {
      const aid = str(a.id, 80);
      if (!aid) continue;
      activityQueryIndices.push(queries.length);
      queries.push(
        sql`
          INSERT INTO activities (id, child_id, at, game, protocol, score, avg, att, med, pct_above, stars, duration_sec, bands, received_at)
          VALUES (${aid}, ${id}, ${int(a.at)}, ${str(a.game, 30)}, ${str(a.protocol, 10)}, ${int(a.score)}, ${int(a.avg)}, ${int(a.att)}, ${int(a.med)}, ${int(a.pctAbove)}, ${int(a.stars)}, ${int(a.durationSec)}, ${bandsOf(a.bands)}, ${now})
          ON CONFLICT (id) DO NOTHING
          RETURNING id
        `,
      );
    }
  }

  const results = await sql.transaction(queries);
  let accepted = 0;
  for (const idx of activityQueryIndices) {
    if (results[idx]?.length) accepted += results[idx].length;
  }
  return accepted;
}

async function getAllData(schoolName) {
  const sql = await ensureSchema();
  const [devicesRaw, childrenRaw, activitiesRaw] = await Promise.all([
    sql`SELECT id, name, last_sync AS "lastSync", first_seen AS "firstSeen" FROM devices ORDER BY last_sync DESC`,
    sql`
      SELECT id, device_id AS "deviceId", first_name AS "firstName", last_name AS "lastName",
             birthday, gender, student_id AS "studentId", class_name AS "className",
             updated_at AS "updatedAt"
      FROM children
    `,
    sql`
      SELECT id, child_id AS "childId", at, game, protocol, score, avg, att, med,
             pct_above AS "pctAbove", stars, duration_sec AS "durationSec", bands
      FROM activities
      ORDER BY at
    `,
  ]);

  const toNum = (v) => (v == null ? null : Number(v));
  const devices = devicesRaw.map((d) => ({
    ...d,
    lastSync: toNum(d.lastSync),
    firstSeen: toNum(d.firstSeen),
  }));
  const children = childrenRaw.map((c) => ({
    ...c,
    updatedAt: toNum(c.updatedAt),
  }));
  const activities = activitiesRaw.map((a) => ({
    ...a,
    at: toNum(a.at),
    bands: a.bands ? JSON.parse(a.bands) : null,
  }));

  return { school: schoolName, devices, children, activities, now: Date.now() };
}

async function deleteChild(id) {
  const sql = await ensureSchema();
  await sql.transaction([
    sql`DELETE FROM activities WHERE child_id = ${id}`,
    sql`DELETE FROM children WHERE id = ${id}`,
  ]);
}

/* ---------------- auth & HTTP helpers ---------------- */

const same = (a, b) => {
  const x = createHash('sha256').update(String(a)).digest();
  const y = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(x, y);
};

function signSession(exp, secret) {
  const payload = String(exp);
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifySession(token, secret) {
  if (!token || !secret) return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const exp = Number(payload);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  return same(sig, expected);
}

const cookieOf = (req, name) =>
  (req.headers.cookie ?? '')
    .split(';')
    .map((c) => {
      const i = c.indexOf('=');
      return i === -1 ? [c.trim(), ''] : [c.slice(0, i).trim(), c.slice(i + 1).trim()];
    })
    .find(([k]) => k === name)?.[1];

const isHttps = (req) =>
  req.headers['x-forwarded-proto'] === 'https' || Boolean(process.env.VERCEL);

function sessionCookie(req, value, maxAgeSec) {
  const parts = [`em_session=${value}`, 'HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${maxAgeSec}`];
  if (isHttps(req)) parts.push('Secure');
  return parts.join('; ');
}

function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !(body instanceof Buffer);
  res.writeHead(status, {
    'content-type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(isObj ? JSON.stringify(body) : body);
}

function readJson(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return Promise.resolve(req.body);
  }
  if (typeof req.body === 'string') {
    try {
      return Promise.resolve(JSON.parse(req.body || '{}'));
    } catch {
      return Promise.reject(new Error('bad json'));
    }
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('too large'));
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('bad json'));
      }
    });
    req.on('error', reject);
  });
}

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

async function exportActivities(schoolName) {
  const { children, activities } = await getAllData(schoolName);
  const byId = Object.fromEntries(children.map((c) => [c.id, c]));
  return csv([
    ['child_id', 'student_id', 'first_name', 'last_name', 'class', 'date', 'game', 'protocol', 'score', 'avg_target', 'attention', 'pct_on_target', 'stars', 'duration_sec', ...BANDS.map((b) => `${b}_pct`)],
    ...activities.map((a) => {
      const c = byId[a.childId] ?? {};
      return [a.childId, c.studentId, c.firstName, c.lastName, c.className, new Date(a.at).toISOString(), a.game, a.protocol, a.score, a.avg, a.att, a.pctAbove, a.stars, a.durationSec, ...(a.bands ?? BANDS.map(() => ''))];
    }),
  ]);
}

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '') || 'index.html';
  const file = join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR) || !existsSync(file)) return send(res, 404, 'Not found');
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  res.end(readFileSync(file));
}

/* ---------------- server ---------------- */

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  const config = getConfig();

  const hasKey = () => Boolean(config.schoolKey) && same(req.headers['x-school-key'] ?? '', config.schoolKey);
  const isAdmin = () => verifySession(cookieOf(req, 'em_session'), config.sessionSecret);

  try {
    // Tablets
    if (pathname === '/api/ping' && req.method === 'GET') {
      if (!config.schoolKey) return send(res, 500, { error: 'SCHOOL_KEY environment variable is not set' });
      if (!hasKey()) return send(res, 401, { error: 'wrong school key' });
      return send(res, 200, { ok: true, school: config.schoolName });
    }
    if (pathname === '/api/sync' && req.method === 'POST') {
      if (!config.schoolKey) return send(res, 500, { error: 'SCHOOL_KEY environment variable is not set' });
      if (!hasKey()) return send(res, 401, { error: 'wrong school key' });
      const accepted = await syncData(await readJson(req));
      return send(res, 200, { ok: true, school: config.schoolName, accepted });
    }

    // Dashboard auth
    if (pathname === '/api/login' && req.method === 'POST') {
      if (!config.adminPassword) return send(res, 500, { error: 'ADMIN_PASSWORD environment variable is not set' });
      const { password } = await readJson(req);
      if (!same(password ?? '', config.adminPassword)) return send(res, 401, { error: 'Wrong password' });
      const token = signSession(Date.now() + SESSION_MS, config.sessionSecret);
      return send(res, 200, { ok: true, school: config.schoolName }, {
        'set-cookie': sessionCookie(req, token, SESSION_MS / 1000),
      });
    }
    if (pathname === '/api/logout' && req.method === 'POST') {
      return send(res, 200, { ok: true }, { 'set-cookie': sessionCookie(req, '', 0) });
    }

    // Protected dashboard API
    if (pathname.startsWith('/api/')) {
      if (!isAdmin()) return send(res, 401, { error: 'Sign in first' });
      if (pathname === '/api/data' && req.method === 'GET') {
        return send(res, 200, await getAllData(config.schoolName));
      }
      const del = pathname.match(/^\/api\/children\/([^/]+)$/);
      if (del && req.method === 'DELETE') {
        await deleteChild(decodeURIComponent(del[1]));
        return send(res, 200, { ok: true });
      }
      if (pathname === '/api/export/activities.csv' && req.method === 'GET') {
        return send(res, 200, await exportActivities(config.schoolName), {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="excellent-mind-activities.csv"',
        });
      }
      return send(res, 404, { error: 'Not found' });
    }

    if (req.method === 'GET') return serveStatic(req, res);
    send(res, 405, 'Method not allowed');
  } catch (e) {
    const msg = String(e?.message ?? e);
    const status = msg === 'bad json' || msg === 'too large' ? 400 : 500;
    send(res, status, { error: msg });
  }
});

if (!process.env.VERCEL) {
  const PORT = Number(process.env.PORT ?? 4000);
  const config = getConfig();
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

export default server;

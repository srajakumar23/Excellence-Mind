// Shared HTTP request handler for both Vercel serverless functions and local Node.js server.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deleteChild, getAllData, syncData } from './db.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(here, '..', 'public');
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

let cachedConfig = null;

function readable(n) {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(randomBytes(n), (b) => abc[b % abc.length]).join('');
}

export function getConfig() {
  if (cachedConfig) return cachedConfig;

  const isVercel = Boolean(process.env.VERCEL);
  let fileCfg = null;

  if (!isVercel) {
    const dataDir = process.env.DATA_DIR ?? join(here, '..', 'data');
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

  cachedConfig = {
    schoolName: process.env.SCHOOL_NAME || fileCfg?.schoolName || 'My School',
    schoolKey: process.env.SCHOOL_KEY || fileCfg?.schoolKey || '',
    adminPassword: process.env.ADMIN_PASSWORD || fileCfg?.adminPassword || '',
    sessionSecret:
      process.env.SESSION_SECRET ||
      process.env.ADMIN_PASSWORD ||
      fileCfg?.adminPassword ||
      '',
  };
  return cachedConfig;
}

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

export async function handleRequest(req, res, { serveFiles = true } = {}) {
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

    if (serveFiles && req.method === 'GET') return serveStatic(req, res);
    send(res, 405, 'Method not allowed');
  } catch (e) {
    const msg = String(e?.message ?? e);
    const status = msg === 'bad json' || msg === 'too large' ? 400 : 500;
    send(res, status, { error: msg });
  }
}

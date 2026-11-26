// Neon Postgres data layer for the Excellent Mind school dashboard.
import { neon } from '@neondatabase/serverless';

const str = (v, max = 120) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const int = (v) => (num(v) == null ? null : Math.round(v));
const bandsOf = (b) =>
  Array.isArray(b) && b.length === 8 && b.every((x) => num(x) != null)
    ? JSON.stringify(b.map(Number))
    : null;

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

export async function ensureSchema() {
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

export async function syncData(body) {
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

export async function getAllData(schoolName) {
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

export async function deleteChild(id) {
  const sql = await ensureSchema();
  await sql.transaction([
    sql`DELETE FROM activities WHERE child_id = ${id}`,
    sql`DELETE FROM children WHERE id = ${id}`,
  ]);
}

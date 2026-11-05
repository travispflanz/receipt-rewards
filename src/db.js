// D1 storage: runs (status, decisions log, result) and every survey page's raw HTML,
// so a finished page — and its validation code — is never lost even if parsing fails.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS runs (
     id TEXT PRIMARY KEY,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     brand TEXT,
     survey_code TEXT,
     notes TEXT,
     receipt_json TEXT,
     status TEXT NOT NULL,
     stage TEXT,
     pages_done INTEGER DEFAULT 0,
     validation_code TEXT,
     validation_text TEXT,
     error TEXT,
     log_json TEXT DEFAULT '[]',
     review INTEGER DEFAULT 0,
     pending_json TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS pages (
     run_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     url TEXT,
     status INTEGER,
     html TEXT,
     created_at TEXT NOT NULL,
     PRIMARY KEY (run_id, seq)
   )`,
  `CREATE INDEX IF NOT EXISTS runs_created ON runs (created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS settings (
     key TEXT PRIMARY KEY,
     value_json TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
];
// Columns added after the first release (ALTER TABLE has no IF NOT EXISTS in SQLite).
const MIGRATIONS = [`ALTER TABLE runs ADD COLUMN inputs_json TEXT`];

let ready = false;
export async function ensureSchema(db) {
  if (ready) return;
  await db.batch(SCHEMA.map((s) => db.prepare(s)));
  for (const m of MIGRATIONS) {
    try {
      await db.prepare(m).run();
    } catch (e) {
      if (!/duplicate column/i.test(String(e?.message || e))) throw e;
    }
  }
  ready = true;
}

const now = () => new Date().toISOString();

export async function createRun(db, r) {
  await ensureSchema(db);
  await db
    .prepare(
      `INSERT INTO runs (id, created_at, updated_at, brand, survey_code, notes, receipt_json, status, stage, review, inputs_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 'queued', ?, ?)`,
    )
    .bind(r.id, now(), now(), r.brand, r.surveyCode, r.notes || "", JSON.stringify(r.receipt || {}), r.review ? 1 : 0, JSON.stringify(r.inputs || {}))
    .run();
}

export async function updateRun(db, id, fields) {
  await ensureSchema(db);
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  await db
    .prepare(`UPDATE runs SET ${sets}, updated_at = ? WHERE id = ?`)
    .bind(...keys.map((k) => fields[k]), now(), id)
    .run();
}

export async function appendLog(db, id, entry, extra = {}) {
  await ensureSchema(db);
  const keys = Object.keys(extra);
  const sets = keys.map((k) => `, ${k} = ?`).join("");
  await db
    .prepare(`UPDATE runs SET log_json = json_insert(COALESCE(log_json,'[]'), '$[#]', json(?)), updated_at = ?${sets} WHERE id = ?`)
    .bind(JSON.stringify({ t: now(), ...entry }), now(), ...keys.map((k) => extra[k]), id)
    .run();
}

export async function savePage(db, runId, seq, { url, status, html }) {
  await ensureSchema(db);
  await db
    .prepare(`INSERT OR REPLACE INTO pages (run_id, seq, url, status, html, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(runId, seq, url || null, status || null, html || "", now())
    .run();
}

export async function getRun(db, id) {
  await ensureSchema(db);
  const row = await db.prepare(`SELECT * FROM runs WHERE id = ?`).bind(id).first();
  return row ? inflate(row) : null;
}

export async function listRuns(db, limit = 25) {
  await ensureSchema(db);
  const { results } = await db
    .prepare(
      `SELECT id, created_at, updated_at, brand, survey_code, status, stage, pages_done, validation_code, error FROM runs ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(limit)
    .all();
  return results;
}

export async function listPages(db, runId) {
  await ensureSchema(db);
  const { results } = await db.prepare(`SELECT seq, url, status, length(html) AS bytes, created_at FROM pages WHERE run_id = ? ORDER BY seq`).bind(runId).all();
  return results;
}

export async function getPage(db, runId, seq) {
  await ensureSchema(db);
  return db.prepare(`SELECT * FROM pages WHERE run_id = ? AND seq = ?`).bind(runId, seq).first();
}

export async function getSetting(db, key) {
  await ensureSchema(db);
  const row = await db.prepare(`SELECT value_json FROM settings WHERE key = ?`).bind(key).first();
  try {
    return row ? JSON.parse(row.value_json) : null;
  } catch {
    return null;
  }
}

export async function putSetting(db, key, value) {
  await ensureSchema(db);
  await db
    .prepare(`INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
    .bind(key, JSON.stringify(value ?? {}), now())
    .run();
}

function inflate(row) {
  const out = { ...row };
  try {
    out.log = JSON.parse(row.log_json || "[]");
  } catch {
    out.log = [];
  }
  try {
    out.receipt = JSON.parse(row.receipt_json || "{}");
  } catch {
    out.receipt = {};
  }
  try {
    out.pending = row.pending_json ? JSON.parse(row.pending_json) : null;
  } catch {
    out.pending = null;
  }
  try {
    out.inputs = row.inputs_json ? JSON.parse(row.inputs_json) : {};
  } catch {
    out.inputs = {};
  }
  delete out.inputs_json;
  delete out.log_json;
  delete out.receipt_json;
  delete out.pending_json;
  return out;
}

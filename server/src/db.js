import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const dbPath = process.env.DB_PATH || "./data/portal.db";
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  token_hash TEXT NOT NULL UNIQUE,
  token_hint TEXT NOT NULL,
  daily_limit INTEGER NOT NULL DEFAULT 50,
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  token_id INTEGER NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

-- Registro de ejecuciones: NUNCA guarda el token ni el contenido de entradas/respuestas.
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id INTEGER REFERENCES tokens(id) ON DELETE SET NULL,
  user_name TEXT NOT NULL,
  task TEXT NOT NULL,
  status TEXT NOT NULL,
  error_code TEXT,
  input_chars INTEGER NOT NULL DEFAULT 0,
  output_chars INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_runs_token_day ON runs(token_id, created_at);

-- Catálogo de skills sincronizado desde Git. Una skill nueva nace DESACTIVADA:
-- un administrador debe activarla (y, si trae scripts, permitirlos) antes de que se use.
CREATE TABLE IF NOT EXISTS skills (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 0,
  allow_scripts INTEGER NOT NULL DEFAULT 0,
  has_scripts INTEGER NOT NULL DEFAULT 0,
  present INTEGER NOT NULL DEFAULT 1,
  commit_sha TEXT,
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Archivos generados por skills; solo los puede descargar quien ejecutó la tarea.
CREATE TABLE IF NOT EXISTS run_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  token_id INTEGER REFERENCES tokens(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_files_run ON run_files(run_id);

CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

// Migración ligera: costo estimado por ejecución (solo skills lo informan).
if (!db.prepare("PRAGMA table_info(runs)").all().some((c) => c.name === "cost_usd")) {
  db.exec("ALTER TABLE runs ADD COLUMN cost_usd REAL");
}

export const kvGet = (k) => {
  const r = db.prepare("SELECT value FROM kv WHERE key = ?").get(k);
  return r ? JSON.parse(r.value) : null;
};
export const kvSet = (k, v) =>
  db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, JSON.stringify(v));

export const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

/** Genera un token interno. Solo se muestra una vez; en BD queda el hash. */
export function createToken({ name, role = "user", dailyLimit = 50, expiresInDays = null }) {
  const raw = "gbl_" + crypto.randomBytes(32).toString("base64url");
  const expires = expiresInDays
    ? new Date(Date.now() + expiresInDays * 864e5).toISOString()
    : null;
  const info = db
    .prepare(
      `INSERT INTO tokens (name, role, token_hash, token_hint, daily_limit, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(name, role, sha256(raw), raw.slice(-4), dailyLimit, expires);
  return { id: Number(info.lastInsertRowid), token: raw };
}

/** Devuelve el registro del token si es válido; si no, { error: code }. */
export function checkToken(raw) {
  if (typeof raw !== "string" || !raw.startsWith("gbl_") || raw.length > 200) {
    return { error: "invalid" };
  }
  const row = db.prepare("SELECT * FROM tokens WHERE token_hash = ?").get(sha256(raw.trim()));
  if (!row) return { error: "invalid" };
  if (row.revoked_at) return { error: "revoked" };
  if (row.expires_at && new Date(row.expires_at) < new Date()) return { error: "expired" };
  return { token: row };
}

export function usedToday(tokenId) {
  return db
    .prepare(
      `SELECT COUNT(*) AS n FROM runs
       WHERE token_id = ? AND status IN ('ok','cancelled') AND date(created_at) = date('now')`
    )
    .get(tokenId).n;
}

export function logRun(r) {
  db.prepare(
    `INSERT INTO runs (token_id, user_name, task, status, error_code, input_chars, output_chars, duration_ms, cost_usd)
     VALUES (@token_id, @user_name, @task, @status, @error_code, @input_chars, @output_chars, @duration_ms, @cost_usd)`
  ).run({
    token_id: r.token_id ?? null,
    user_name: r.user_name,
    task: r.task,
    status: r.status,
    error_code: r.error_code ?? null,
    input_chars: r.input_chars ?? 0,
    output_chars: r.output_chars ?? 0,
    duration_ms: r.duration_ms ?? 0,
    cost_usd: r.cost_usd ?? null,
  });
}

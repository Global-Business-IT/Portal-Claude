// Acceso a datos. Dos motores con la misma API asíncrona:
//  - Postgres (Supabase) cuando existe DATABASE_URL  → producción.
//  - SQLite (better-sqlite3) en caso contrario        → desarrollo y pruebas.
// Las consultas se escriben con "?" y funcionan en ambos motores. Las fechas se pasan como parámetros (nowStr()).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const usePg = Boolean(process.env.DATABASE_URL);
export const driver = usePg ? "postgres" : "sqlite";

/** "YYYY-MM-DD HH:MM:SS" en UTC: mismo formato que usaba datetime('now') y válido para Postgres. */
export const nowStr = (d = new Date()) => d.toISOString().slice(0, 19).replace("T", " ");
/** Convierte lo que devuelva cualquiera de los motores (Date o texto sin zona = UTC) en Date. */
export const toDate = (v) => (v instanceof Date ? v : new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(String(v)) ? v : String(v).replace(" ", "T") + "Z"));

if (!usePg && process.env.VERCEL) {
  throw new Error("Falta la variable DATABASE_URL en Vercel (Settings → Environment Variables). Sin ella no hay base de datos.");
}

let sqlite = null; // manejador de better-sqlite3 (solo con SQLite); las pruebas lo usan directamente
let pool = null;

if (usePg) {
  const pg = (await import("pg")).default;
  pg.types.setTypeParser(20, (v) => Number(v)); // bigint → número (ids, conteos, marcas de tiempo)
  pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.PG_POOL_MAX) || 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    // Supabase exige TLS. DATABASE_SSL=0 solo para una base local de pruebas.
    ssl: process.env.DATABASE_SSL === "0" ? false : { rejectUnauthorized: false },
  });
  pool.on("error", (e) => console.error("[db] error del pool:", e.message));
} else {
  const Database = (await import("better-sqlite3")).default;
  const dbPath = process.env.DB_PATH || "./data/portal.db";
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
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
  if (!sqlite.prepare("PRAGMA table_info(runs)").all().some((c) => c.name === "cost_usd")) {
    sqlite.exec("ALTER TABLE runs ADD COLUMN cost_usd REAL");
  }
}

/** Manejador crudo de SQLite (solo pruebas y desarrollo; null con Postgres). */
export const db = sqlite;

const pgSql = (sql) => {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
};

/** Varias filas. */
export async function all(sql, params = []) {
  if (usePg) return (await pool.query(pgSql(sql), params)).rows;
  return sqlite.prepare(sql).all(...params);
}
/** Una fila o undefined. */
export async function get(sql, params = []) {
  return (await all(sql, params))[0];
}
/** INSERT/UPDATE/DELETE → { changes }. */
export async function run(sql, params = []) {
  if (usePg) return { changes: (await pool.query(pgSql(sql), params)).rowCount };
  return { changes: sqlite.prepare(sql).run(...params).changes };
}
/** Varias sentencias [sql, params] en una sola transacción (todas o ninguna). */
export async function batch(stmts) {
  if (usePg) {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      for (const [sql, params = []] of stmts) await c.query(pgSql(sql), params);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      c.release();
    }
    return;
  }
  sqlite.transaction(() => {
    for (const [sql, params = []] of stmts) sqlite.prepare(sql).run(...params);
  })();
}
export async function closeDb() {
  if (pool) await pool.end();
  else sqlite?.close();
}

export const kvGet = async (k) => {
  const r = await get("SELECT value FROM kv WHERE key = ?", [k]);
  return r ? JSON.parse(r.value) : null;
};
export const kvSet = (k, v) =>
  run("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [k, JSON.stringify(v)]);

export const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

/** Genera un token interno. Solo se muestra una vez; en BD queda el hash. */
export async function createToken({ name, role = "user", dailyLimit = 50, expiresInDays = null }) {
  const raw = "gbl_" + crypto.randomBytes(32).toString("base64url");
  const expires = expiresInDays ? nowStr(new Date(Date.now() + expiresInDays * 864e5)) : null;
  const row = await get(
    `INSERT INTO tokens (name, role, token_hash, token_hint, daily_limit, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [name, role, sha256(raw), raw.slice(-4), dailyLimit, expires, nowStr()]
  );
  return { id: Number(row.id), token: raw };
}

/** Devuelve el registro del token si es válido; si no, { error: code }. */
export async function checkToken(raw) {
  if (typeof raw !== "string" || !raw.startsWith("gbl_") || raw.length > 200) {
    return { error: "invalid" };
  }
  const row = await get("SELECT * FROM tokens WHERE token_hash = ?", [sha256(raw.trim())]);
  if (!row) return { error: "invalid" };
  if (row.revoked_at) return { error: "revoked" };
  if (row.expires_at && toDate(row.expires_at) < new Date()) return { error: "expired" };
  return { token: row };
}

export async function usedToday(tokenId) {
  const start = nowStr().slice(0, 10) + " 00:00:00"; // inicio del día (UTC)
  const r = await get(
    `SELECT COUNT(*) AS n FROM runs WHERE token_id = ? AND status IN ('ok','cancelled') AND created_at >= ?`,
    [tokenId, start]
  );
  return Number(r.n);
}

export function logRun(r) {
  // Nunca debe tumbar una petición: el registro es auxiliar. Se puede esperar con await o ignorar.
  return run(
    `INSERT INTO runs (token_id, user_name, task, status, error_code, input_chars, output_chars, duration_ms, cost_usd, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [r.token_id ?? null, r.user_name, r.task, r.status, r.error_code ?? null, r.input_chars ?? 0, r.output_chars ?? 0, r.duration_ms ?? 0, r.cost_usd ?? null, nowStr()]
  ).catch((e) => console.error("[db] no se pudo registrar la ejecución:", e.message));
}

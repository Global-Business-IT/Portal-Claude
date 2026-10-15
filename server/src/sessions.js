import crypto from "node:crypto";
import { db, sha256 } from "./db.js";

const IDLE_MS = (Number(process.env.SESSION_IDLE_MINUTES) || 30) * 60_000;
const MAX_MS = (Number(process.env.SESSION_MAX_HOURS) || 12) * 3_600_000;
export const COOKIE = "gbl_sid";

export function createSession(tokenId) {
  const sid = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  db.prepare("INSERT INTO sessions (id_hash, token_id, created_at, last_seen) VALUES (?,?,?,?)").run(
    sha256(sid),
    tokenId,
    now,
    now
  );
  return sid;
}

export function destroySession(sid) {
  if (sid) db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(sha256(sid));
}

/** Middleware: exige sesión válida y token vigente (revocación inmediata). */
export function requireSession(req, res, next) {
  const sid = req.cookies?.[COOKIE];
  if (!sid) return res.status(401).json({ error: "no_session" });

  const row = db
    .prepare(
      `SELECT s.*, t.id AS tid, t.name, t.role, t.daily_limit, t.expires_at, t.revoked_at
       FROM sessions s JOIN tokens t ON t.id = s.token_id WHERE s.id_hash = ?`
    )
    .get(sha256(sid));
  if (!row) return res.status(401).json({ error: "no_session" });

  const now = Date.now();
  const dead =
    now - row.last_seen > IDLE_MS ||
    now - row.created_at > MAX_MS ||
    row.revoked_at ||
    (row.expires_at && new Date(row.expires_at) < new Date());
  if (dead) {
    destroySession(sid);
    return res.status(401).json({ error: row.revoked_at ? "revoked" : "session_expired" });
  }

  db.prepare("UPDATE sessions SET last_seen = ? WHERE id_hash = ?").run(now, sha256(sid));
  req.user = { id: row.tid, name: row.name, role: row.role, dailyLimit: row.daily_limit };
  req.sid = sid;
  next();
}

export const requireAdmin = (req, res, next) =>
  req.user?.role === "admin" ? next() : res.status(403).json({ error: "forbidden" });

export function purgeSessions() {
  db.prepare("DELETE FROM sessions WHERE last_seen < ? OR created_at < ?").run(
    Date.now() - IDLE_MS,
    Date.now() - MAX_MS
  );
}

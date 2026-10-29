import crypto from "node:crypto";
import { get, run, sha256, toDate, nowStr } from "./db.js";

const IDLE_MS = (Number(process.env.SESSION_IDLE_MINUTES) || 30) * 60_000;
const MAX_MS = (Number(process.env.SESSION_MAX_HOURS) || 12) * 3_600_000;
export const COOKIE = "gbl_sid";

export async function createSession(tokenId) {
  const sid = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  await run("INSERT INTO sessions (id_hash, token_id, created_at, last_seen) VALUES (?,?,?,?)", [sha256(sid), tokenId, now, now]);
  return sid;
}

export async function destroySession(sid) {
  if (sid) await run("DELETE FROM sessions WHERE id_hash = ?", [sha256(sid)]);
}

// Acceso abierto (OPEN_ACCESS=1): quien entra sin token usa el usuario compartido "Invitado", con límite diario propio.
// Es temporal y solo para pruebas internas: cualquiera con la dirección puede gastar de la clave de Anthropic.
const GUEST_NAME = "Invitado (acceso abierto)";
export const openAccess = () => /^(1|true|si|sí|yes)$/i.test(String(process.env.OPEN_ACCESS ?? "").trim());
async function guestUser() {
  const limit = Number(process.env.OPEN_ACCESS_DAILY_LIMIT) || 100;
  let t = await get("SELECT id, role, daily_limit, revoked_at FROM tokens WHERE name = ? AND token_hint = 'abierto'", [GUEST_NAME]);
  if (!t) {
    await run("INSERT INTO tokens (name, role, token_hash, token_hint, daily_limit, created_at) VALUES (?,?,?,?,?,?)", [
      GUEST_NAME, "user", sha256(crypto.randomBytes(32).toString("hex")), "abierto", limit, nowStr(),
    ]);
    t = await get("SELECT id, role, daily_limit, revoked_at FROM tokens WHERE name = ? AND token_hint = 'abierto'", [GUEST_NAME]);
  } else if (t.daily_limit !== limit) {
    await run("UPDATE tokens SET daily_limit = ? WHERE id = ?", [limit, t.id]);
  }
  if (t.revoked_at) return null;
  return { id: t.id, name: GUEST_NAME, role: "user", dailyLimit: limit, guest: true };
}
async function asGuest(req, res, next, error) {
  if (!openAccess()) return res.status(401).json({ error });
  const g = await guestUser();
  if (!g) return res.status(401).json({ error: "revoked" });
  req.user = g;
  next();
}

/** Middleware: exige sesión válida y token vigente (revocación inmediata). */
export async function requireSession(req, res, next) {
  const sid = req.cookies?.[COOKIE];
  if (!sid) return asGuest(req, res, next, "no_session");

  const row = await get(
    `SELECT s.created_at, s.last_seen, t.id AS tid, t.name, t.role, t.daily_limit, t.expires_at, t.revoked_at
     FROM sessions s JOIN tokens t ON t.id = s.token_id WHERE s.id_hash = ?`,
    [sha256(sid)]
  );
  if (!row) return asGuest(req, res, next, "no_session");

  const now = Date.now();
  const dead =
    now - row.last_seen > IDLE_MS ||
    now - row.created_at > MAX_MS ||
    row.revoked_at ||
    (row.expires_at && toDate(row.expires_at) < new Date());
  if (dead) {
    await destroySession(sid);
    if (openAccess() && !row.revoked_at) return asGuest(req, res, next, "session_expired");
    return res.status(401).json({ error: row.revoked_at ? "revoked" : "session_expired" });
  }

  await run("UPDATE sessions SET last_seen = ? WHERE id_hash = ?", [now, sha256(sid)]);
  req.user = { id: row.tid, name: row.name, role: row.role, dailyLimit: row.daily_limit };
  req.sid = sid;
  next();
}

/** El invitado (acceso abierto) puede ver las skills, pero ejecutarlas exige un token personal. */
export const requireToken = (req, res, next) =>
  req.user?.guest
    ? res.status(401).json({ error: "token_required", message: "Para ejecutar una skill necesitas un token de acceso. Solicítalo al administrador." })
    : next();

export const requireAdmin = (req, res, next) =>
  req.user?.role === "admin" ? next() : res.status(403).json({ error: "forbidden" });

export async function purgeSessions() {
  await run("DELETE FROM sessions WHERE last_seen < ? OR created_at < ?", [Date.now() - IDLE_MS, Date.now() - MAX_MS]).catch((e) =>
    console.error("[db] purgeSessions:", e.message)
  );
}

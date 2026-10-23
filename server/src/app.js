import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { all, get, run as dbRun, nowStr, toDate, checkToken, createToken, usedToday, logRun } from "./db.js";
import { COOKIE, createSession, destroySession, requireSession, requireAdmin } from "./sessions.js";
import { getTask, publicTasks } from "./tasks.js";
import { fileToBlock, MAX_FILE_BYTES, UserInputError } from "./files.js";
import { runStream, friendlyError, MODEL } from "./claude.js";
import { syncSkills, syncStatus, cfg as gitCfg, NAME_RE } from "./gitsync.js";
import { mdToDocx, mdToPdf } from "./convert.js";
import { runSkill, restrictedAllowed, SkillRunError, safeName, outputsRoot, MAX_INPUT_FILES, MAX_INPUT_FILE_BYTES } from "./skillrunner.js";

const MAX_INPUT_CHARS = 60_000;
const isProd = process.env.NODE_ENV === "production";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TOKEN_ERRORS = {
  invalid: "El token no es válido. Revisa que lo hayas copiado completo.",
  revoked: "Este token fue revocado. Solicita uno nuevo al administrador.",
  expired: "Este token expiró. Solicita uno nuevo al administrador.",
};

export function createApp() {
  const app = express();
  app.set("trust proxy", Number(process.env.TRUST_PROXY) || 0);
  app.disable("x-powered-by");

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
    })
  );

  // ---------- Aviso de GitHub (webhook) ----------
  // Va antes de express.json porque la firma se calcula sobre el cuerpo original.
  const webhookLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });
  app.post("/webhooks/github", webhookLimiter, express.raw({ type: "*/*", limit: "5mb" }), (req, res) => {
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) return res.status(503).json({ error: "webhook_disabled" });

    const sig = String(req.get("x-hub-signature-256") || "");
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const expected = "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: "bad_signature" });

    const event = req.get("x-github-event");
    if (event === "ping") return res.json({ ok: true, pong: true });
    if (event !== "push") return res.status(202).json({ ok: true, ignored: event });

    let payload;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      return res.status(400).json({ error: "bad_payload" });
    }
    if (payload.ref !== `refs/heads/${gitCfg().branch}`) return res.status(202).json({ ok: true, ignored: "otra rama" });

    syncSkills("aviso de GitHub").catch(() => {});
    res.status(202).json({ ok: true, syncing: true });
  });

  app.use(express.json({ limit: "100kb" }));
  app.use(cookieParser());

  // Defensa CSRF: cookie SameSite=Strict + cabecera personalizada obligatoria en escrituras.
  app.use("/api", (req, res, next) => {
    if (req.method !== "GET" && req.get("x-requested-with") !== "portal") {
      return res.status(403).json({ error: "csrf" });
    }
    next();
  });

  const loginLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: Number(process.env.LOGIN_ATTEMPTS) || 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "too_many", message: "Demasiados intentos. Espera unos minutos e inténtalo de nuevo." },
  });
  const runLimiter = rateLimit({
    windowMs: 60_000,
    limit: 20,
    keyGenerator: (req) => `u${req.user?.id}`,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { keyGeneratorIpFallback: false },
    message: { error: "too_many", message: "Vas muy rápido. Espera un minuto antes de ejecutar otra tarea." },
  });

  // ---------- Autenticación ----------
  app.post("/api/login", loginLimiter, async (req, res) => {
    const r = await checkToken(req.body?.token);
    if (r.error) return res.status(401).json({ error: r.error, message: TOKEN_ERRORS[r.error] });

    await dbRun("UPDATE tokens SET last_used_at = ? WHERE id = ?", [nowStr(), r.token.id]);
    const sid = await createSession(r.token.id);
    res.cookie(COOKIE, sid, {
      httpOnly: true,
      sameSite: "strict",
      secure: isProd,
      path: "/",
      maxAge: (Number(process.env.SESSION_MAX_HOURS) || 12) * 3_600_000,
    });
    res.json({ user: { name: r.token.name, role: r.token.role } });
  });

  app.post("/api/logout", async (req, res) => {
    await destroySession(req.cookies?.[COOKIE]);
    res.clearCookie(COOKIE, { path: "/" });
    res.json({ ok: true });
  });

  app.get("/api/me", requireSession, async (req, res) => {
    const used = await usedToday(req.user.id);
    res.json({
      user: { name: req.user.name, role: req.user.role },
      usage: { used, limit: req.user.dailyLimit },
    });
  });

  app.get("/api/tasks", requireSession, (_req, res) => res.json({ tasks: publicTasks() }));

  // ---------- Ejecución de tareas ----------
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES, files: 1 } });

  app.post("/api/run", requireSession, runLimiter, upload.single("file"), async (req, res) => {
    const started = Date.now();
    const base = { token_id: req.user.id, user_name: req.user.name };
    const reject = (status, error, message, task = "?") => {
      logRun({ ...base, task, status: "rejected", error_code: error });
      return res.status(status).json({ error, message });
    };

    const task = getTask(req.body?.task);
    if (!task) return reject(400, "bad_task", "Tarea desconocida.");

    // Campos: solo strings, con límites y validación de opciones.
    let raw = {};
    try {
      raw = JSON.parse(req.body.fields || "{}");
    } catch {
      return reject(400, "bad_fields", "Datos del formulario inválidos.", task.id);
    }
    const fields = {};
    for (const f of task.fields) {
      if (f.type === "file") continue;
      let v = raw[f.name];
      if (v == null || v === "") v = f.default ?? "";
      if (typeof v !== "string") return reject(400, "bad_fields", `Campo inválido: ${f.label}.`, task.id);
      v = v.trim();
      if (f.type === "select" && !f.options.some((o) => o.value === v))
        return reject(400, "bad_fields", `Opción inválida en "${f.label}".`, task.id);
      if (f.name !== "text" && v.length > 300)
        return reject(400, "bad_fields", `"${f.label}" es demasiado largo.`, task.id);
      fields[f.name] = v;
    }
    const text = fields.text || "";
    const file = req.file;

    if (text.length > MAX_INPUT_CHARS)
      return reject(413, "too_large", "El texto es demasiado largo (máximo 60.000 caracteres).", task.id);
    if (task.needs === "text" && !text) return reject(400, "missing", "Escribe el texto para esta tarea.", task.id);
    if (task.needs === "file" && (!file || !text))
      return reject(400, "missing", "Sube un archivo y escribe qué quieres saber o extraer.", task.id);
    if (task.needs === "textOrFile" && !text && !file)
      return reject(400, "missing", "Pega un texto o sube un archivo.", task.id);

    // Cuota diaria por token.
    if ((await usedToday(req.user.id)) >= req.user.dailyLimit)
      return reject(
        429,
        "quota",
        `Alcanzaste tu límite de ${req.user.dailyLimit} tareas por hoy. Se restablece mañana o pide ampliarlo al administrador.`,
        task.id
      );

    // Armar el mensaje para Claude.
    const content = [];
    let inputChars = text.length;
    try {
      if (file) {
        const { block, chars } = await fileToBlock(file);
        content.push(block);
        inputChars += chars;
      }
    } catch (e) {
      if (e instanceof UserInputError) return reject(400, "bad_file", e.userMessage, task.id);
      throw e;
    }
    const { system, instruction } = task.build(fields);
    if (task.id === "analyze") {
      content.push({ type: "text", text: text });
    } else {
      const material = text ? `<material>\n${text}\n</material>\n\n` : "";
      content.push({ type: "text", text: `${material}${instruction}` });
    }

    // Streaming SSE.
    res.status(200).set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);

    const ac = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) ac.abort();
    });

    let outChars = 0;
    try {
      outChars = await runStream({
        system,
        content,
        signal: ac.signal,
        onText: (t) => send({ t: "text", v: t }),
      });
      send({ t: "done" });
      logRun({ ...base, task: task.id, status: "ok", input_chars: inputChars, output_chars: outChars, duration_ms: Date.now() - started });
    } catch (err) {
      if (ac.signal.aborted) {
        logRun({ ...base, task: task.id, status: "cancelled", input_chars: inputChars, duration_ms: Date.now() - started });
      } else {
        const fe = friendlyError(err);
        console.error(`[run] task=${task.id} user=${req.user.id} code=${fe.code} status=${err?.status ?? "-"}`);
        send({ t: "error", code: fe.code, message: fe.message });
        logRun({ ...base, task: task.id, status: "error", error_code: fe.code, input_chars: inputChars, duration_ms: Date.now() - started });
      }
    } finally {
      res.end();
    }
  });

  // ---------- Skills de la empresa ----------
  app.get("/api/skills", requireSession, async (_req, res) => {
    const rows = await all("SELECT name, description FROM skills WHERE enabled = 1 AND present = 1 ORDER BY name");
    res.json({ skills: rows });
  });

  const uploadSkill = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_INPUT_FILE_BYTES, files: MAX_INPUT_FILES },
  });

  app.post("/api/skills/run", requireSession, runLimiter, uploadSkill.array("files", MAX_INPUT_FILES), async (req, res) => {
    const started = Date.now();
    const base = { token_id: req.user.id, user_name: req.user.name };
    const name = String(req.body?.skill ?? "");
    const reject = (status, error, message) => {
      logRun({ ...base, task: `skill:${name.slice(0, 64)}`, status: "rejected", error_code: error });
      return res.status(status).json({ error, message });
    };

    const skill = NAME_RE.test(name) ? await get("SELECT * FROM skills WHERE name = ? AND enabled = 1 AND present = 1", [name]) : null;
    if (!skill) return reject(404, "not_found", "Esta skill no está disponible.");

    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    const files = req.files || [];
    if (text.length > 20_000) return reject(413, "too_large", "El texto es demasiado largo (máximo 20.000 caracteres).");
    if (!text && !files.length) return reject(400, "missing", "Escribe qué necesitas o adjunta un archivo.");

    if ((await usedToday(req.user.id)) >= req.user.dailyLimit)
      return reject(429, "quota", `Alcanzaste tu límite de ${req.user.dailyLimit} tareas por hoy. Se restablece mañana o pide ampliarlo al administrador.`);

    res.status(200).set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);

    const ac = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) ac.abort();
    });

    const inputChars = text.length + files.reduce((n, f) => n + f.size, 0);
    try {
      const r = await runSkill({
        name,
        text,
        files,
        scriptsMode: Number(skill.allow_scripts) || 0,
        tokenId: req.user.id,
        signal: ac.signal,
        onText: (t) => send({ t: "text", v: t }),
        onStatus: (v) => send({ t: "status", v }),
      });
      if (r.outputs.length) {
        send({
          t: "files",
          files: r.outputs.map((f) => ({ name: f.name, size: f.size, url: `/api/runs/${r.runId}/files/${encodeURIComponent(f.name)}` })),
        });
      }
      send({ t: "done" });
      logRun({ ...base, task: `skill:${name}`, status: "ok", input_chars: inputChars, output_chars: r.chars, duration_ms: Date.now() - started, cost_usd: r.costUsd });
    } catch (err) {
      if (ac.signal.aborted && !(err instanceof SkillRunError)) {
        logRun({ ...base, task: `skill:${name}`, status: "cancelled", input_chars: inputChars, duration_ms: Date.now() - started });
      } else {
        const code = err instanceof SkillRunError ? err.code : "unknown";
        const message = err instanceof SkillRunError ? err.userMessage : "Ocurrió un error inesperado al ejecutar la skill. Inténtalo de nuevo.";
        console.error(`[skill] name=${name} user=${req.user.id} code=${code}`);
        send({ t: "error", code, message });
        logRun({ ...base, task: `skill:${name}`, status: "error", error_code: code, input_chars: inputChars, duration_ms: Date.now() - started, cost_usd: err.costUsd ?? null });
      }
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  });

  // Descarga de archivos generados: solo para quien ejecutó la tarea.
  app.get("/api/runs/:runId/files/:name", requireSession, async (req, res) => {
    const { runId, name } = req.params;
    if (!/^[a-f0-9]{24}$/.test(runId)) return res.status(404).json({ error: "not_found" });
    const row = await get("SELECT name FROM run_files WHERE run_id = ? AND name = ? AND token_id = ?", [runId, name, req.user.id]);
    if (!row) return res.status(404).json({ error: "not_found", message: "El archivo ya no está disponible (se eliminan a las 24 horas)." });
    const root = path.join(outputsRoot(), runId);
    const file = path.join(root, safeName(row.name));
    if (path.relative(root, file).startsWith("..") || !fs.existsSync(file)) {
      return res.status(404).json({ error: "not_found", message: "El archivo ya no está disponible (se eliminan a las 24 horas)." });
    }
    res.set("X-Content-Type-Options", "nosniff");
    // Los .md se pueden bajar también como Word o PDF (?format=docx|pdf).
    const fmt = String(req.query.format || "");
    if ((fmt === "docx" || fmt === "pdf") && /\.(md|markdown)$/i.test(row.name) && fs.statSync(file).size <= 2 * 1024 * 1024) {
      try {
        const md = fs.readFileSync(file, "utf8");
        const buf = fmt === "docx" ? await mdToDocx(md) : await mdToPdf(md);
        const base = row.name.replace(/\.(md|markdown)$/i, "");
        res.set("Content-Type", fmt === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "application/pdf");
        res.set("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(base + "." + fmt)}`);
        return res.send(buf);
      } catch (e) {
        console.error("[convert] error:", e.message);
        return res.status(500).json({ error: "convert_failed", message: "No se pudo convertir el archivo. Descárgalo en su formato original." });
      }
    }
    res.download(file, row.name);
  });

  // ---------- Administración ----------
  const admin = express.Router();
  admin.use(requireSession, requireAdmin);

  const tokenView = async (t) => ({
    id: t.id,
    name: t.name,
    role: t.role,
    hint: "…" + t.token_hint,
    dailyLimit: t.daily_limit,
    usedToday: await usedToday(t.id),
    expiresAt: t.expires_at,
    revokedAt: t.revoked_at,
    createdAt: t.created_at,
    lastUsedAt: t.last_used_at,
    status: t.revoked_at ? "revoked" : t.expires_at && toDate(t.expires_at) < new Date() ? "expired" : "active",
  });

  admin.get("/tokens", async (_req, res) => {
    const rows = await all("SELECT * FROM tokens ORDER BY id DESC");
    res.json({ tokens: await Promise.all(rows.map(tokenView)) });
  });

  const parseTokenInput = (b) => {
    const name = String(b?.name ?? "").trim();
    if (!name || name.length > 80) return { error: "Escribe un nombre (máx. 80 caracteres)." };
    const role = b?.role === "admin" ? "admin" : "user";
    const dailyLimit = Math.min(Math.max(parseInt(b?.dailyLimit ?? 50, 10) || 50, 1), 5000);
    const days = b?.expiresInDays ? Math.min(Math.max(parseInt(b.expiresInDays, 10) || 0, 1), 3650) : null;
    return { name, role, dailyLimit, expiresInDays: days };
  };

  admin.post("/tokens", async (req, res) => {
    const p = parseTokenInput(req.body);
    if (p.error) return res.status(400).json({ error: "bad_input", message: p.error });
    const { id, token } = await createToken(p);
    res.status(201).json({ id, token }); // único momento en que se ve el token completo
  });

  const kill = async (id) => {
    // Las sesiones se dejan: requireSession detecta revoked_at en la siguiente petición,
    // responde "revoked" (mensaje claro para el usuario) y entonces las elimina.
    await dbRun("UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [nowStr(), id]);
  };

  admin.post("/tokens/:id/revoke", async (req, res) => {
    const id = Number(req.params.id);
    const t = await get("SELECT * FROM tokens WHERE id = ?", [id]);
    if (!t) return res.status(404).json({ error: "not_found", message: "Token no encontrado." });
    if (id === req.user.id) return res.status(400).json({ error: "self", message: "No puedes revocar tu propio token." });
    await kill(id);
    res.json({ ok: true });
  });

  admin.post("/tokens/:id/renew", async (req, res) => {
    const id = Number(req.params.id);
    const t = await get("SELECT * FROM tokens WHERE id = ?", [id]);
    if (!t) return res.status(404).json({ error: "not_found", message: "Token no encontrado." });
    if (id === req.user.id) return res.status(400).json({ error: "self", message: "No puedes renovar tu propio token." });
    const days = t.expires_at ? Math.max(1, Math.round((toDate(t.expires_at) - toDate(t.created_at)) / 864e5)) : null;
    const fresh = await createToken({ name: t.name, role: t.role, dailyLimit: t.daily_limit, expiresInDays: days });
    await kill(id);
    res.status(201).json({ id: fresh.id, token: fresh.token });
  });

  admin.patch("/tokens/:id", async (req, res) => {
    const id = Number(req.params.id);
    const limit = Math.min(Math.max(parseInt(req.body?.dailyLimit, 10) || 0, 1), 5000);
    if (!req.body?.dailyLimit) return res.status(400).json({ error: "bad_input", message: "Indica el nuevo límite diario." });
    const r = await dbRun("UPDATE tokens SET daily_limit = ? WHERE id = ?", [limit, id]);
    if (!r.changes) return res.status(404).json({ error: "not_found", message: "Token no encontrado." });
    res.json({ ok: true });
  });

  const skillView = (r) => ({
    name: r.name,
    description: r.description,
    enabled: Boolean(r.enabled),
    allowScripts: Boolean(r.allow_scripts),
    scriptsMode: Number(r.allow_scripts) || 0,
    hasScripts: Boolean(r.has_scripts),
    present: Boolean(r.present),
    commit: r.commit_sha,
    firstSeen: r.first_seen,
    updatedAt: r.updated_at,
  });

  admin.get("/skills", async (_req, res) => {
    const rows = await all("SELECT * FROM skills ORDER BY present DESC, name");
    res.json({ skills: rows.map(skillView), sync: await syncStatus(), restrictedAvailable: restrictedAllowed() });
  });

  admin.patch("/skills/:name", async (req, res) => {
    const row = NAME_RE.test(req.params.name) ? await get("SELECT * FROM skills WHERE name = ?", [req.params.name]) : null;
    if (!row) return res.status(404).json({ error: "not_found", message: "Skill no encontrada." });
    const enabled = typeof req.body?.enabled === "boolean" ? Number(req.body.enabled) : row.enabled;
    let allow = typeof req.body?.allowScripts === "boolean" ? Number(req.body.allowScripts) : row.allow_scripts;
    if (req.body?.scriptsMode !== undefined) {
      const m = Number(req.body.scriptsMode);
      if (![0, 1, 2].includes(m)) return res.status(400).json({ error: "invalid", message: "Modo de scripts no válido." });
      if (m === 2 && !restrictedAllowed()) return res.status(400).json({ error: "not_allowed", message: "El modo restringido no está habilitado en este servidor (SKILLS_ALLOW_RESTRICTED=1)." });
      allow = m;
    }
    if (enabled && !row.present) return res.status(400).json({ error: "gone", message: "Esa skill ya no está en el repositorio." });
    await dbRun("UPDATE skills SET enabled = ?, allow_scripts = ? WHERE name = ?", [enabled, allow, row.name]);
    res.json({ ok: true });
  });

  admin.post("/skills/sync", async (_req, res) => {
    const st = await syncSkills("manual");
    res.json({ sync: st });
  });

  admin.get("/runs", async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const rows = await all(
      `SELECT id, user_name, task, status, error_code, input_chars, output_chars, duration_ms, cost_usd, created_at
       FROM runs ORDER BY id DESC LIMIT ?`,
      [limit]
    );
    res.json({ runs: rows });
  });

  app.use("/api/admin", admin);

  app.get("/api/health", (_req, res) => res.json({ ok: true, model: MODEL }));
  app.use("/api", (_req, res) => res.status(404).json({ error: "not_found" }));

  // ---------- Frontend compilado ----------
  const dist = path.resolve(__dirname, "../../web/dist");
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
  }

  // ---------- Errores ----------
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof multer.MulterError) {
      const msg =
        err.code === "LIMIT_FILE_SIZE"
          ? `El archivo supera el máximo de ${MAX_FILE_BYTES / 1024 / 1024} MB.`
          : "No se pudo procesar el archivo.";
      return res.status(413).json({ error: "bad_file", message: msg });
    }
    if (err?.type === "entity.too.large") return res.status(413).json({ error: "too_large", message: "La solicitud es demasiado grande." });
    console.error("[error]", err?.message);
    if (res.headersSent) return res.end();
    res.status(500).json({ error: "server", message: "Error interno del servidor." });
  });

  return app;
}

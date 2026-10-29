import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import * as tar from "tar";
import { Readable } from "node:stream";
import { once } from "node:events";
import { batch, kvGet, kvSet, nowStr } from "./db.js";

const exec = promisify(execFile);

export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SCRIPT_EXT = new Set([".py", ".js", ".mjs", ".cjs", ".ts", ".sh", ".bash", ".ps1", ".bat", ".cmd", ".rb", ".pl", ".php"]);
const MAX_SKILL_MD = 200 * 1024;

export const cfg = () => ({
  url: process.env.SKILLS_REPO_URL || "",
  branch: process.env.SKILLS_REPO_BRANCH || "main",
  token: process.env.SKILLS_REPO_TOKEN || "",
  dir: path.resolve(process.env.SKILLS_DIR || (process.env.VERCEL ? "/tmp/skills-repo" : "./data/skills-repo")),
  sub: process.env.SKILLS_SUBDIR || ".claude/skills",
  allowLocal: process.env.SKILLS_ALLOW_LOCAL === "1", // solo para pruebas
});

/** "api" = descarga el repo con la API de GitHub (sin git; para Vercel). "git" = clon/fetch con git. */
export const fetchMode = () => {
  const m = (process.env.SKILLS_FETCH || "").toLowerCase();
  if (m === "api" || m === "git") return m;
  return process.env.VERCEL ? "api" : "git";
};

export const skillsRoot = () => {
  const c = cfg();
  return path.join(c.dir, c.sub);
};

export const isConfigured = () => Boolean(cfg().url);

function validateUrl(url, allowLocal) {
  if (/^https:\/\/[^\s@]+$/.test(url)) return true; // sin credenciales embebidas
  if (allowLocal && (path.isAbsolute(url) || url.startsWith("file://"))) return true;
  return false;
}

/** El token viaja por variables de entorno de git: no queda en .git/config ni en la lista de procesos. */
function gitEnv(c) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME || process.env.USERPROFILE || "",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: c.allowLocal ? "https:file" : "https",
    LANG: "C",
  };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot; // Windows
  if (c.token && c.url.startsWith("https://")) {
    const b64 = Buffer.from(`x-access-token:${c.token}`).toString("base64");
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.extraheader";
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${b64}`;
  }
  return env;
}

async function git(args, c, cwd) {
  try {
    const { stdout } = await exec("git", args, { cwd, env: gitEnv(c), timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
    return stdout.trim();
  } catch (e) {
    let msg = String(e.stderr || e.message || e).trim().split("\n").slice(-3).join(" ");
    if (c.token) msg = msg.split(c.token).join("***");
    throw new Error(msg || "falló git");
  }
}

// ---------- Descarga por la API de GitHub ----------

const MAX_TARBALL_BYTES = 100 * 1024 * 1024;

function parseGithub(url) {
  const m = String(url).match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  if (!m) throw new Error("En modo API, SKILLS_REPO_URL debe ser https://github.com/<organización>/<repositorio>.");
  return { owner: m[1], repo: m[2] };
}

const ghHeaders = (c, accept = "application/vnd.github+json") => ({
  Accept: accept,
  "User-Agent": "portal-claude",
  "X-GitHub-Api-Version": "2022-11-28",
  ...(c.token ? { Authorization: `Bearer ${c.token}` } : {}),
});

async function ghFetch(url, c, accept) {
  const r = await fetch(url, { headers: ghHeaders(c, accept), signal: AbortSignal.timeout(60_000) });
  if (!r.ok) {
    const hint = r.status === 404 || r.status === 401 ? " (revisa SKILLS_REPO_URL, la rama y el permiso del token)" : "";
    throw new Error(`GitHub respondió ${r.status}${hint}`);
  }
  return r;
}

export const localSha = (dir = cfg().dir) => {
  try {
    return fs.readFileSync(path.join(dir, ".sha"), "utf8").trim();
  } catch {
    return "";
  }
};

/** Descarga la rama y deja en c.dir solo c.sub (sin enlaces). Devuelve el sha completo del commit. */
async function fetchViaApi(c) {
  const { owner, repo } = parseGithub(c.url);
  const api = `https://api.github.com/repos/${owner}/${repo}`;
  const sha = (await (await ghFetch(`${api}/commits/${encodeURIComponent(c.branch)}`, c, "application/vnd.github.sha")).text()).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("GitHub devolvió un commit no válido.");
  if (localSha(c.dir) === sha && fs.existsSync(path.join(c.dir, c.sub))) return sha; // ya está al día

  const r = await ghFetch(`${api}/tarball/${sha}`, c);
  const len = Number(r.headers.get("content-length") || 0);
  if (len > MAX_TARBALL_BYTES) throw new Error("El repositorio de skills es demasiado grande.");

  const tmp = `${c.dir}.tmp-${process.pid}-${Date.now()}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  try {
    let bytes = 0;
    const prefix = c.sub.replace(/^\/+|\/+$/g, "");
    const unpack = tar.x({
      cwd: tmp,
      strip: 1,
      // Solo la carpeta de skills; sin enlaces simbólicos ni duros.
      filter: (p, entry) => {
        const rel = p.split("/").slice(1).join("/");
        const t = entry?.type;
        if (t === "SymbolicLink" || t === "Link") return false;
        return rel === prefix || rel.startsWith(prefix + "/") || prefix.startsWith(rel + "/") || rel === "";
      },
    });
    // "close" (no "finish"): tar escribe los archivos de forma asíncrona y hay que esperar a que terminen.
    const closed = new Promise((res, rej) => {
      unpack.on("close", res);
      unpack.on("error", rej);
    });
    // tar 7 usa minipass (no streams de Node): se escribe a mano respetando la contrapresión.
    for await (const chunk of Readable.fromWeb(r.body)) {
      bytes += chunk.length;
      if (bytes > MAX_TARBALL_BYTES) throw new Error("El repositorio de skills es demasiado grande.");
      if (!unpack.write(chunk)) await once(unpack, "drain");
    }
    unpack.end();
    await closed;
    fs.mkdirSync(path.join(tmp, prefix), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".sha"), sha);
    fs.rmSync(c.dir, { recursive: true, force: true });
    fs.renameSync(tmp, c.dir);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  return sha;
}

// ---------- Lectura del catálogo ----------

function parseFrontmatter(text) {
  const m = text.replace(/^﻿/, "").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  try {
    const fm = YAML.parse(m[1]);
    return fm && typeof fm === "object" ? fm : null;
  } catch {
    return null;
  }
}

function listFilesNoSymlinks(dir, depth = 0, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth < 6) listFilesNoSymlinks(p, depth + 1, acc);
    else if (e.isFile()) acc.push(p);
  }
  return acc;
}

/** Lee las skills válidas de la carpeta; lo inválido se reporta como advertencia, no rompe la sincronización. */
export function scanSkills(root) {
  const skills = [];
  const warnings = [];
  if (!fs.existsSync(root)) return { skills, warnings: [`No existe la carpeta ${path.basename(path.dirname(root))}/${path.basename(root)} en el repositorio.`] };

  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    if (e.isSymbolicLink()) {
      warnings.push(`${e.name}: se ignoró (enlace simbólico).`);
      continue;
    }
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    const md = path.join(dir, "SKILL.md");
    if (!fs.existsSync(md) || !fs.lstatSync(md).isFile()) {
      warnings.push(`${e.name}: no tiene SKILL.md.`);
      continue;
    }
    if (!NAME_RE.test(e.name)) {
      warnings.push(`${e.name}: el nombre de carpeta solo puede tener minúsculas, números y guiones (máx. 64).`);
      continue;
    }
    if (fs.statSync(md).size > MAX_SKILL_MD) {
      warnings.push(`${e.name}: SKILL.md es demasiado grande.`);
      continue;
    }
    const text = fs.readFileSync(md, "utf8");
    const fm = parseFrontmatter(text);
    if (!fm) {
      warnings.push(`${e.name}: SKILL.md no tiene encabezado YAML válido (--- ... ---).`);
      continue;
    }
    if (fm.name && fm.name !== e.name) {
      warnings.push(`${e.name}: el campo name ("${fm.name}") debe coincidir con la carpeta.`);
      continue;
    }
    const description = String(fm.description ?? "").trim();
    if (!description) {
      warnings.push(`${e.name}: falta description.`);
      continue;
    }
    const files = listFilesNoSymlinks(dir);
    const allowed = String(fm["allowed-tools"] ?? "");
    const hasScripts = files.some((f) => SCRIPT_EXT.has(path.extname(f).toLowerCase())) || /\bBash\b/i.test(allowed);
    skills.push({ name: e.name, description: description.slice(0, 1024), hasScripts });
  }
  return { skills, warnings };
}

async function applyCatalog(found, sha) {
  const now = nowStr();
  const stmts = [["UPDATE skills SET present = 0"]];
  for (const sk of found) {
    stmts.push([
      `INSERT INTO skills (name, description, has_scripts, present, commit_sha, first_seen, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET description = excluded.description, has_scripts = excluded.has_scripts,
         present = 1, commit_sha = excluded.commit_sha, updated_at = excluded.updated_at`,
      [sk.name, sk.description, sk.hasScripts ? 1 : 0, sha, now, now],
    ]);
  }
  await batch(stmts);
}

// ---------- Sincronización ----------

let running = null;
let queued = false;

export const syncStatus = async () =>
  (await kvGet("sync_status")) || { configured: isConfigured(), ok: null, at: null, sha: null, reason: null, count: 0, warnings: [], error: null };

async function doSync(reason) {
  const c = cfg();
  const base = { configured: true, at: new Date().toISOString(), reason };
  if (!c.url) {
    const st = { configured: false, ok: null, at: null, sha: null, reason, count: 0, warnings: [], error: "Falta SKILLS_REPO_URL en .env" };
    await kvSet("sync_status", st);
    return st;
  }
  if (!validateUrl(c.url, c.allowLocal)) {
    const st = { ...base, ok: false, sha: null, count: 0, warnings: [], error: "SKILLS_REPO_URL debe ser una URL https:// sin usuario ni contraseña (el token va en SKILLS_REPO_TOKEN)." };
    await kvSet("sync_status", st);
    return st;
  }
  try {
    fs.mkdirSync(path.dirname(c.dir), { recursive: true });
    let sha;
    if (fetchMode() === "api") {
      sha = (await fetchViaApi(c)).slice(0, 12);
    } else {
      if (!fs.existsSync(path.join(c.dir, ".git"))) {
        fs.rmSync(c.dir, { recursive: true, force: true });
        await git(["clone", "--depth", "1", "--branch", c.branch, "--single-branch", c.url, c.dir], c, path.dirname(c.dir));
      } else {
        await git(["fetch", "--depth", "1", "origin", c.branch], c, c.dir);
        await git(["reset", "--hard", "FETCH_HEAD"], c, c.dir);
        await git(["clean", "-fdx"], c, c.dir);
      }
      sha = (await git(["rev-parse", "HEAD"], c, c.dir)).slice(0, 12);
    }
    const { skills, warnings } = scanSkills(skillsRoot());
    await applyCatalog(skills, sha);
    const st = { ...base, ok: true, sha, count: skills.length, warnings, error: null };
    await kvSet("sync_status", st);
    return st;
  } catch (e) {
    // Si falla, se conserva la última copia buena: las skills ya instaladas siguen funcionando.
    const prev = await kvGet("sync_status");
    const st = { ...base, ok: false, sha: prev?.sha ?? null, count: prev?.count ?? 0, warnings: prev?.warnings ?? [], error: e.message };
    await kvSet("sync_status", st);
    console.error("[sync] error:", e.message);
    return st;
  }
}

/** Una sola sincronización a la vez; si llegan avisos mientras corre, se hace una más al terminar. */
export function syncSkills(reason = "manual") {
  if (running) {
    queued = true;
    return running;
  }
  running = doSync(reason).finally(async () => {
    running = null;
    if (queued) {
      queued = false;
      syncSkills("en cola");
    }
  });
  return running;
}

/**
 * Garantiza que la copia local de las skills exista y esté al día antes de ejecutar una.
 * En Vercel cada instancia tiene su propio /tmp (vacío en frío) y el aviso de GitHub puede caer en otra
 * instancia, así que se compara con el commit registrado en la base de datos.
 */
export async function ensureSkills() {
  if (!isConfigured()) return;
  const c = cfg();
  if (fetchMode() === "api") {
    const st = await syncStatus();
    const have = localSha(c.dir);
    if (!have || !fs.existsSync(skillsRoot()) || (st.sha && !have.startsWith(st.sha))) await syncSkills("actualización local");
  } else if (!fs.existsSync(skillsRoot())) {
    await syncSkills("arranque en frío");
  }
}

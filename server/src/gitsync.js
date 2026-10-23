import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { batch, kvGet, kvSet, nowStr } from "./db.js";

const exec = promisify(execFile);

export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SCRIPT_EXT = new Set([".py", ".js", ".mjs", ".cjs", ".ts", ".sh", ".bash", ".ps1", ".bat", ".cmd", ".rb", ".pl", ".php"]);
const MAX_SKILL_MD = 200 * 1024;

export const cfg = () => ({
  url: process.env.SKILLS_REPO_URL || "",
  branch: process.env.SKILLS_REPO_BRANCH || "main",
  token: process.env.SKILLS_REPO_TOKEN || "",
  dir: path.resolve(process.env.SKILLS_DIR || "./data/skills-repo"),
  sub: process.env.SKILLS_SUBDIR || ".claude/skills",
  allowLocal: process.env.SKILLS_ALLOW_LOCAL === "1", // solo para pruebas
});

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
    if (!fs.existsSync(path.join(c.dir, ".git"))) {
      fs.rmSync(c.dir, { recursive: true, force: true });
      await git(["clone", "--depth", "1", "--branch", c.branch, "--single-branch", c.url, c.dir], c, path.dirname(c.dir));
    } else {
      await git(["fetch", "--depth", "1", "origin", c.branch], c, c.dir);
      await git(["reset", "--hard", "FETCH_HEAD"], c, c.dir);
      await git(["clean", "-fdx"], c, c.dir);
    }
    const sha = (await git(["rev-parse", "HEAD"], c, c.dir)).slice(0, 12);
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

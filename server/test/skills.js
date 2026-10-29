// Pruebas de skills: sincronización con Git, webhook, catálogo, ejecución aislada y permisos.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import * as tm from "../src/tomarkdown.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "portal-skills-"));
const remote = path.join(tmp, "remote");
const SECRET = "secreto-de-prueba";
Object.assign(process.env, {
  DB_PATH: path.join(tmp, "t.db"),
  CLAUDE_MOCK: "1",
  LOGIN_ATTEMPTS: "1000",
  SKILLS_REPO_URL: "file://" + remote,
  SKILLS_ALLOW_LOCAL: "1",
  SKILLS_DIR: path.join(tmp, "skills-repo"),
  WORK_DIR: path.join(tmp, "work"),
  OUTPUTS_DIR: path.join(tmp, "outputs"),
  GITHUB_WEBHOOK_SECRET: SECRET,
  SECRET_AJENO: "no-debe-filtrarse",
  ANTHROPIC_API_KEY: "sk-ant-prueba",
});

const git = (args, cwd = remote) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" }).toString().trim();
const put = (rel, content) => {
  const f = path.join(remote, ".claude/skills", rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
};
const skillMd = (name, desc = "Resume reuniones", extra = "") => `---\nname: ${name}\ndescription: ${desc}\n${extra}---\n\n# ${name}\nInstrucciones.\n`;
const commit = (msg) => {
  git(["add", "-A"]);
  git(["commit", "-qm", msg]);
};

fs.mkdirSync(remote, { recursive: true });
git(["init", "-q", "-b", "main"]);
put("resumen-reunion/SKILL.md", skillMd("resumen-reunion"));
put("contrato-nda/SKILL.md", skillMd("contrato-nda", "Revisa NDAs"));
put("contrato-nda/scripts/chequeo.py", "print('hola')\n");
put("Mala_Skill/SKILL.md", skillMd("Mala_Skill"));
put("sin-md/otro.txt", "x");
put("nombre-distinto/SKILL.md", skillMd("otro-nombre"));
put("sin-desc/SKILL.md", "---\nname: sin-desc\n---\ncuerpo");
commit("inicial");

const { createApp } = await import("../src/app.js");
const dbm = await import("../src/db.js");
const git_ = await import("../src/gitsync.js");
const runner = await import("../src/skillrunner.js");

const server = createApp().listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

const H = { "x-requested-with": "portal" };
async function call(method, url, { cookie, json, form, headers = {}, raw } = {}) {
  const h = { ...H, ...headers };
  let body;
  if (cookie) h.cookie = cookie;
  if (json) { h["content-type"] = "application/json"; body = JSON.stringify(json); }
  if (form) body = form;
  if (raw !== undefined) body = raw;
  return fetch(base + url, { method, headers: h, body });
}
async function login(token) {
  const res = await call("POST", "/api/login", { json: { token } });
  return res.headers.get("set-cookie").split(";")[0];
}
async function runSkill(cookie, skill, text, files = []) {
  const form = new FormData();
  form.set("skill", skill);
  if (text !== undefined) form.set("text", text);
  for (const f of files) form.append("files", new Blob([f.data]), f.name);
  const res = await call("POST", "/api/skills/run", { cookie, form });
  if ((res.headers.get("content-type") || "").includes("text/event-stream")) {
    const raw = await res.text();
    const events = raw.split("\n\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
    return { status: 200, events, text: events.filter((e) => e.t === "text").map((e) => e.v).join("") };
  }
  return { status: res.status, body: await res.json() };
}
const waitFor = async (fn, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); }
  return null;
};

const admin = await dbm.createToken({ name: "Admin", role: "admin" });
const ana = await dbm.createToken({ name: "Ana", dailyLimit: 100 });
const luis = await dbm.createToken({ name: "Luis", dailyLimit: 100 });
let A, U, L;

test("1. sincroniza desde Git y arma el catálogo; lo inválido solo da advertencias", async () => {
  const st = await git_.syncSkills("prueba");
  assert.equal(st.ok, true, st.error);
  assert.equal(st.count, 2);
  assert.match(st.sha, /^[0-9a-f]{12}$/);
  const w = st.warnings.join(" | ");
  for (const frag of ["Mala_Skill", "sin-md", "nombre-distinto", "sin-desc"]) assert.ok(w.includes(frag), frag);
  A = await login(admin.token); U = await login(ana.token); L = await login(luis.token);
});

test("2. las skills nuevas nacen DESACTIVADAS y los scripts se detectan", async () => {
  const user = await (await call("GET", "/api/skills", { cookie: U })).json();
  assert.deepEqual(user.skills, []);
  const adm = await (await call("GET", "/api/admin/skills", { cookie: A })).json();
  const nda = adm.skills.find((s) => s.name === "contrato-nda");
  const res = adm.skills.find((s) => s.name === "resumen-reunion");
  assert.equal(nda.hasScripts, true); assert.equal(res.hasScripts, false);
  assert.equal(nda.enabled, false); assert.equal(nda.allowScripts, false);
  assert.equal(adm.sync.ok, true);
});

test("3. ejecutar una skill desactivada o inexistente se rechaza", async () => {
  assert.equal((await runSkill(U, "resumen-reunion", "hola")).status, 404);
  assert.equal((await runSkill(U, "no-existe", "hola")).status, 404);
  assert.equal((await runSkill(U, "../../etc", "hola")).status, 404);
  assert.equal((await call("GET", "/api/admin/skills", { cookie: U })).status, 403);
  assert.equal((await call("PATCH", "/api/admin/skills/resumen-reunion", { cookie: U, json: { enabled: true } })).status, 403);
});

test("4. el admin activa una skill y los usuarios la ven", async () => {
  const r = await call("PATCH", "/api/admin/skills/resumen-reunion", { cookie: A, json: { enabled: true } });
  assert.equal(r.status, 200);
  const user = await (await call("GET", "/api/skills", { cookie: U })).json();
  assert.deepEqual(user.skills.map((s) => s.name), ["resumen-reunion"]);
  assert.equal((await call("GET", "/api/skills")).status, 401);
});

test("5. ejecutar skill: texto, estado, archivos de salida y descarga solo del dueño", async () => {
  const r = await runSkill(U, "resumen-reunion", "Resume esto", [{ name: "acta.txt", data: "Acta de la reunión" }]);
  assert.equal(r.status, 200);
  assert.equal(r.events.at(-1).t, "done");
  assert.match(r.text, /Skill simulada: resumen-reunion/);
  assert.match(r.text, /Leí acta\.txt \(permitido\)/);
  assert.ok(r.events.some((e) => e.t === "status"));
  const files = r.events.find((e) => e.t === "files").files;
  assert.equal(files[0].name, "resultado.txt");

  const dl = await call("GET", files[0].url, { cookie: U });
  assert.equal(dl.status, 200);
  assert.match(await dl.text(), /Resultado simulado/);
  assert.equal((await call("GET", files[0].url, { cookie: L })).status, 404, "otro usuario no descarga");
  assert.equal((await call("GET", files[0].url)).status, 401);
  assert.equal((await call("GET", "/api/runs/zzzz/files/x", { cookie: U })).status, 404);
  assert.equal((await call("GET", files[0].url.replace("resultado.txt", "..%2F..%2Ft.db"), { cookie: U })).status, 404);
  // la carpeta de trabajo se limpia
  await waitFor(() => fs.readdirSync(process.env.WORK_DIR).length === 0);
  assert.equal(fs.readdirSync(process.env.WORK_DIR).length, 0);
});

test("6. validaciones de la ejecución", async () => {
  assert.equal((await runSkill(U, "resumen-reunion", "")).status, 400);
  assert.equal((await runSkill(U, "resumen-reunion", "x".repeat(20_001))).status, 413);
  const big = await runSkill(U, "resumen-reunion", "x", [{ name: "g.bin", data: Buffer.alloc(11 * 1024 * 1024) }]);
  assert.ok([413, 500].includes(big.status));
});

test("7. aislamiento: solo la skill elegida, entorno mínimo, sin Bash por defecto", async () => {
  await dbm.run("UPDATE skills SET enabled = 1 WHERE name = 'contrato-nda'");
  let seen;
  runner.setQueryImpl(async function* ({ prompt, options }) {
    seen = { prompt, options, skills: fs.readdirSync(path.join(options.cwd, ".claude/skills")), inputs: fs.readdirSync(path.join(options.cwd, "inputs")) };
    yield { type: "result", subtype: "success", is_error: false, result: "", total_cost_usd: 0.01, num_turns: 1 };
  });
  await runSkill(U, "resumen-reunion", "hola", [{ name: "../../evil.txt", data: "x" }]);
  assert.deepEqual(seen.skills, ["resumen-reunion"], "las otras skills no son alcanzables");
  assert.deepEqual(seen.inputs, ["evil.txt"], "el nombre del archivo se sanea");
  assert.ok(seen.prompt.startsWith("/resumen-reunion hola"));
  assert.ok(!seen.options.tools.includes("Bash"));
  assert.ok(seen.options.disallowedTools.includes("WebFetch"));
  assert.equal(seen.options.sandbox, undefined);
  assert.equal(seen.options.env.SECRET_AJENO, undefined, "no hereda variables ajenas");
  assert.equal(seen.options.env.ANTHROPIC_API_KEY, "sk-ant-prueba");
  assert.equal(seen.options.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, "1");
  assert.ok(seen.options.env.HOME.startsWith(process.env.WORK_DIR));
  assert.deepEqual(seen.options.settingSources, ["project"]);
  assert.equal(seen.options.maxTurns, 25); assert.equal(seen.options.maxBudgetUsd, 1);

  // con scripts permitidos por el admin: Bash + sandbox obligatorio
  await call("PATCH", "/api/admin/skills/contrato-nda", { cookie: A, json: { allowScripts: true } });
  await runSkill(U, "contrato-nda", "revisa");
  assert.ok(seen.options.tools.includes("Bash"));
  assert.equal(seen.options.sandbox.enabled, true);
  assert.equal(seen.options.sandbox.failIfUnavailable, true);
  assert.equal(seen.options.sandbox.allowUnsandboxedCommands, false);
  assert.deepEqual(seen.options.sandbox.network.allowedDomains, []);
  assert.deepEqual(seen.skills, ["contrato-nda"]);
  runner.setQueryImpl(null);
});

test("8. confinamiento de herramientas (leer/escribir/Glob/Bash/enlaces simbólicos)", async () => {
  const dir = fs.mkdtempSync(path.join(tmp, "run-"));
  for (const d of ["inputs", "outputs", "tmp"]) fs.mkdirSync(path.join(dir, d));
  fs.writeFileSync(path.join(dir, "inputs/a.txt"), "x");
  fs.symlinkSync("/etc", path.join(dir, "inputs/escape"));
  const can = runner.makeCanUseTool({ runDir: dir, allowScripts: false });
  const verdict = async (t, i) => (await can(t, i)).behavior;

  assert.equal(await verdict("Read", { file_path: path.join(dir, "inputs/a.txt") }), "allow");
  assert.equal(await verdict("Read", { file_path: "inputs/a.txt" }), "allow");
  assert.equal(await verdict("Read", { file_path: "/etc/passwd" }), "deny");
  assert.equal(await verdict("Read", { file_path: "../../etc/passwd" }), "deny");
  assert.equal(await verdict("Read", { file_path: path.join(process.env.DB_PATH) }), "deny", "no puede leer la base de datos");
  assert.equal(await verdict("Read", { file_path: path.join(dir, "inputs/escape/passwd") }), "deny", "enlace simbólico que apunta fuera");
  assert.equal(await verdict("Write", { file_path: path.join(dir, "outputs/r.txt") }), "allow");
  assert.equal(await verdict("Write", { file_path: "outputs/sub/r.txt" }), "allow");
  assert.equal(await verdict("Write", { file_path: path.join(dir, "inputs/a.txt") }), "deny");
  assert.equal(await verdict("Edit", { file_path: path.join(dir, ".claude/skills/x/SKILL.md") }), "deny");
  assert.equal(await verdict("Write", { file_path: "/tmp/fuera.txt" }), "deny");
  assert.equal(await verdict("Glob", { pattern: "*.txt" }), "allow");
  assert.equal(await verdict("Glob", { pattern: "/etc/*" }), "deny");
  assert.equal(await verdict("Glob", { pattern: "../*" }), "deny");
  assert.equal(await verdict("Grep", { pattern: "x", path: "/etc" }), "deny");
  assert.equal(await verdict("Grep", { pattern: "x" }), "allow");
  assert.equal(await verdict("Bash", { command: "ls" }), "deny");
  assert.equal(await verdict("WebFetch", { url: "https://x" }), "deny");
  assert.equal(await verdict("Skill", { skill: "a" }), "allow");
  const withScripts = runner.makeCanUseTool({ runDir: dir, allowScripts: true });
  assert.equal((await withScripts("Bash", { command: "ls" })).behavior, "allow");
});

test("9. dentro de la ejecución, un intento de leer fuera de la carpeta se bloquea", async () => {
  process.env.CLAUDE_MOCK_PROBE = "1";
  const r = await runSkill(U, "resumen-reunion", "hola");
  delete process.env.CLAUDE_MOCK_PROBE;
  assert.match(r.text, /fuera de la carpeta: deny/);
});

test("10. errores del agente se muestran con mensajes claros", async () => {
  for (const [mode, re, code] of [["max_turns", /demasiados pasos/, "too_long"], ["rate_limit", /muchas solicitudes/, "rate_limit"]]) {
    process.env.CLAUDE_MOCK_ERROR = mode;
    const r = await runSkill(U, "resumen-reunion", "hola");
    const err = r.events.find((e) => e.t === "error");
    assert.ok(err, mode); assert.equal(err.code, code); assert.match(err.message, re);
  }
  delete process.env.CLAUDE_MOCK_ERROR;
  process.env.SKILL_MAX_CONCURRENT = "0";
  const busy = await runSkill(U, "resumen-reunion", "hola");
  assert.equal(busy.events.find((e) => e.t === "error").code, "busy");
  delete process.env.SKILL_MAX_CONCURRENT;
});

test("11. webhook de GitHub: firma, rama, ping y sincronización automática", async () => {
  const send = (event, payload, secret = SECRET) => {
    const body = JSON.stringify(payload);
    const sig = "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
    return call("POST", "/webhooks/github", { raw: body, headers: { "content-type": "application/json", "x-github-event": event, "x-hub-signature-256": sig } });
  };
  assert.equal((await send("ping", { zen: "x" })).status, 200);
  assert.equal((await send("push", { ref: "refs/heads/main" }, "otro-secreto")).status, 401);
  assert.equal((await call("POST", "/webhooks/github", { raw: "{}", headers: { "x-github-event": "push" } })).status, 401, "sin firma");
  assert.equal((await send("push", { ref: "refs/heads/otra" })).status, 202);

  put("nueva-skill/SKILL.md", skillMd("nueva-skill", "Skill agregada después"));
  commit("agrega nueva-skill");
  const before = (await git_.syncStatus()).sha;
  assert.equal((await send("push", { ref: "refs/heads/main" })).status, 202);
  const ok = await waitFor(async () => { const st = await git_.syncStatus(); return st.sha !== before && st; });
  assert.ok(ok, "sincronizó tras el aviso");
  const adm = await (await call("GET", "/api/admin/skills", { cookie: A })).json();
  const n = adm.skills.find((s) => s.name === "nueva-skill");
  assert.ok(n); assert.equal(n.enabled, false, "la nueva skill espera aprobación del admin");
  assert.equal((await runSkill(U, "nueva-skill", "hola")).status, 404);
  assert.equal(ok.reason, "aviso de GitHub");
});

test("12. webhook sin secreto configurado queda apagado", async () => {
  const saved = process.env.GITHUB_WEBHOOK_SECRET;
  delete process.env.GITHUB_WEBHOOK_SECRET;
  assert.equal((await call("POST", "/webhooks/github", { raw: "{}", headers: { "x-github-event": "push" } })).status, 503);
  process.env.GITHUB_WEBHOOK_SECRET = saved;
});

test("13. si se borra o se rompe una skill en Git, el portal lo refleja", async () => {
  fs.rmSync(path.join(remote, ".claude/skills/resumen-reunion"), { recursive: true });
  commit("borra resumen");
  await git_.syncSkills("prueba");
  const user = await (await call("GET", "/api/skills", { cookie: U })).json();
  assert.ok(!user.skills.some((s) => s.name === "resumen-reunion"));
  assert.equal((await runSkill(U, "resumen-reunion", "hola")).status, 404);
  const adm = await (await call("GET", "/api/admin/skills", { cookie: A })).json();
  assert.equal(adm.skills.find((s) => s.name === "resumen-reunion").present, false);
  assert.equal((await call("PATCH", "/api/admin/skills/resumen-reunion", { cookie: A, json: { enabled: true } })).status, 400);
  // si vuelve, conserva su activación previa
  put("resumen-reunion/SKILL.md", skillMd("resumen-reunion", "Versión nueva"));
  commit("restaura");
  await git_.syncSkills("prueba");
  const back = (await (await call("GET", "/api/admin/skills", { cookie: A })).json()).skills.find((s) => s.name === "resumen-reunion");
  assert.equal(back.present, true); assert.equal(back.description, "Versión nueva"); assert.equal(back.enabled, true);
});

test("14. si GitHub no responde, se conserva la última copia buena", async () => {
  const moved = remote + "-caido";
  fs.renameSync(remote, moved);
  const st = await git_.syncSkills("prueba");
  assert.equal(st.ok, false); assert.ok(st.error);
  assert.ok(st.count >= 2, "conserva el conteo anterior");
  const user = await (await call("GET", "/api/skills", { cookie: U })).json();
  assert.ok(user.skills.length >= 1, "las skills instaladas siguen funcionando");
  assert.equal((await runSkill(U, "resumen-reunion", "hola")).events.at(-1).t, "done");
  fs.renameSync(moved, remote);
  assert.equal((await git_.syncSkills("prueba")).ok, true);
});

test("15. URL del repositorio con credenciales o protocolo no permitido se rechaza", async () => {
  const saved = process.env.SKILLS_REPO_URL;
  for (const bad of ["https://usuario:clave@github.com/x/y.git", "ext::sh -c id", "http://github.com/x/y.git"]) {
    process.env.SKILLS_REPO_URL = bad;
    const st = await git_.syncSkills("prueba");
    assert.equal(st.ok, false, bad);
    assert.match(st.error, /https/);
  }
  process.env.SKILLS_REPO_URL = saved;
});

test("16. el registro guarda skill, usuario y costo, sin contenido; los archivos vencen a las 24 h", async () => {
  const rows = await dbm.all("SELECT * FROM runs WHERE task LIKE 'skill:%'");
  assert.ok(rows.length > 3);
  const dump = JSON.stringify(rows);
  assert.ok(!dump.includes("Resume esto") && !dump.includes("Acta de la reunión") && !dump.includes(ana.token));
  const ok = rows.find((r) => r.status === "ok" && r.cost_usd);
  assert.equal(ok.user_name, "Ana"); assert.equal(ok.task, "skill:resumen-reunion");

  const stale = await dbm.get("SELECT run_id FROM run_files LIMIT 1");
  assert.ok(fs.existsSync(path.join(process.env.OUTPUTS_DIR, stale.run_id)));
  await dbm.run("UPDATE run_files SET created_at = ?", [Date.now() - 25 * 3600_000]);
  await runner.purgeOutputs();
  assert.ok(!fs.existsSync(path.join(process.env.OUTPUTS_DIR, stale.run_id)));
  assert.equal((await dbm.get("SELECT COUNT(*) AS n FROM run_files")).n, 0);
});

test("17. el token de GitHub no queda en .git/config ni en los mensajes", async () => {
  process.env.SKILLS_REPO_TOKEN = "ghp_SECRETO_DE_PRUEBA";
  await git_.syncSkills("prueba");
  const cfgText = fs.readFileSync(path.join(process.env.SKILLS_DIR, ".git/config"), "utf8");
  assert.ok(!cfgText.includes("ghp_SECRETO_DE_PRUEBA"));
  assert.ok(!JSON.stringify(await git_.syncStatus()).includes("ghp_SECRETO_DE_PRUEBA"));
  delete process.env.SKILLS_REPO_TOKEN;
});

test("18. adjuntos se convierten a Markdown (con el original) y los fallos no rompen la ejecución", async () => {
  let seen;
  runner.setQueryImpl(async function* ({ prompt, options }) {
    const dir = path.join(options.cwd, "inputs");
    seen = { prompt, inputs: fs.readdirSync(dir).sort(), md: fs.existsSync(path.join(dir, "informe.pdf.md")) ? fs.readFileSync(path.join(dir, "informe.pdf.md"), "utf8") : null };
    yield { type: "result", subtype: "success", is_error: false, result: "", total_cost_usd: 0.01, num_turns: 1 };
  });
  // conversor simulado
  tm.setConverterImpl(async (file) => (file.endsWith("informe.pdf") ? { ok: true, md: "# Informe\n\nTexto extraído del PDF de prueba, suficiente." } : file.endsWith("scan.pdf") ? { ok: true, md: "  " } : { ok: false, reason: "error" }));
  const r = await runSkill(U, "resumen-reunion", "resume", [
    { name: "informe.pdf", data: "%PDF-1.4 x" },
    { name: "scan.pdf", data: "%PDF-1.4 y" },
    { name: "roto.docx", data: "no es un docx" },
    { name: "notas.txt", data: "texto plano" },
  ]);
  assert.equal(r.status, 200);
  assert.ok(!r.events.some((e) => e.t === "error"), "un fallo de conversión no rompe la tarea");
  assert.deepEqual(seen.inputs, ["informe.pdf", "informe.pdf.md", "notas.txt", "roto.docx", "scan.pdf"]);
  assert.match(seen.md, /Texto extraído/);
  assert.match(seen.prompt, /informe\.pdf → versión en texto: informe\.pdf\.md/);
  assert.match(seen.prompt, /scan\.pdf: no se pudo extraer texto/);
  assert.ok(r.events.some((e) => e.t === "status" && /Preparando informe\.pdf/.test(e.v)));

  // sin MarkItDown instalado: se entregan los originales y se sigue
  tm.setConverterImpl(async () => ({ ok: false, reason: "no_instalado" }));
  await runSkill(U, "resumen-reunion", "resume", [{ name: "informe.pdf", data: "%PDF-1.4 x" }]);
  assert.deepEqual(seen.inputs, ["informe.pdf"]);
  assert.doesNotMatch(seen.prompt, /Conversión a texto/);

  // apagado por configuración
  tm.setConverterImpl(async () => { throw new Error("no debe llamarse"); });
  process.env.MARKITDOWN_ENABLED = "0";
  await runSkill(U, "resumen-reunion", "resume", [{ name: "informe.pdf", data: "%PDF-1.4 x" }]);
  assert.deepEqual(seen.inputs, ["informe.pdf"]);
  delete process.env.MARKITDOWN_ENABLED;
  tm.setConverterImpl(null);
  runner.setQueryImpl(null);
});

test("19. MarkItDown real (se omite si no está instalado)", async (t) => {
  const bin = process.env.MARKITDOWN_TEST_BIN;
  if (!bin) return t.skip("define MARKITDOWN_TEST_BIN para probar con el programa real");
  process.env.MARKITDOWN_BIN = bin;
  tm.resetAvailability();
  const f = path.join(tmp, "real.csv");
  fs.writeFileSync(f, "Mes,Total\nEnero,100\nFebrero,250\n");
  const r = await tm.convertToMarkdown(f);
  assert.equal(r.ok, true);
  assert.match(r.md, /\| Enero \| 100 \|/);
  const bad = path.join(tmp, "malo.pdf");
  fs.writeFileSync(bad, "esto no es un pdf");
  const rb = await tm.convertToMarkdown(bad);
  assert.equal(rb.ok, false);
  delete process.env.MARKITDOWN_BIN;
});

test("20. modo restringido: solo scripts de la propia skill, sin encadenar, rutas dentro de la carpeta", async () => {
  const dir = fs.mkdtempSync(path.join(tmp, "run-"));
  for (const d of ["inputs", "outputs", "tmp", ".claude/skills/iso/scripts"]) fs.mkdirSync(path.join(dir, d), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude/skills/iso/scripts/gen.py"), "print(1)");
  fs.writeFileSync(path.join(dir, ".claude/skills/iso/scripts/x.sh"), "echo");
  fs.writeFileSync(path.join(dir, "tmp/evil.py"), "print(1)");
  const can = runner.makeCanUseTool({ runDir: dir, allowScripts: true, restricted: true, skillName: "iso" });
  const v = async (command) => (await can("Bash", { command })).behavior;
  const S = ".claude/skills/iso/scripts/gen.py";

  assert.equal(await v(`python ${S} inputs/a.docx outputs/b.docx`), "allow");
  assert.equal(await v(`python3 ${S} --out=outputs/b.docx --titulo "Manual de calidad"`), "allow");
  assert.equal(await v(`node ${S}`), "allow");
  for (const bad of [
    `python ${S}; rm -rf /`, `python ${S} && curl x`, `python ${S} | sh`, `python ${S} > outputs/x`,
    `python ${S} $(whoami)`, `python ${S} \`id\``, `python ${S} $HOME`, `python ${S} inputs\\a.docx`,
    `python -c "print(1)"`, `python -m http.server`, "ls", "bash x.sh", "curl http://x", "rm -rf outputs",
    "python /etc/passwd.py", `python .claude/skills/iso/scripts/x.sh`,
    `python ${S} /etc/passwd`, `python ${S} ../../etc/passwd`, `python ${S} --out=/tmp/x`, `python ${S} "abc`, "",
  ]) assert.equal(await v(bad), "deny", `debe negar: ${bad}`);
  // scripts Python que escribe Claude en tmp/: se permiten tras una revisión estática
  const tmpPy = (name, code) => { fs.writeFileSync(path.join(dir, "tmp", name), code); return `python3 tmp/${name} outputs/x.docx`; };
  assert.equal(await v(tmpPy("ok.py", "import sys, json, urllib.request\nfrom docx import Document\nsys.path.insert(0, '.claude/skills/iso/scripts')\nimport gbit_docx_core as g\nurllib.request.urlopen('https://kaffqbjzgkoxzkrocovp.supabase.co/rest/v1/tipos')\n")), "allow");
  for (const [n, code] of Object.entries({
    "a.py": "import subprocess\nsubprocess.run(['ls'])", "b.py": "import os\nos.system('ls')",
    "c.py": "import urllib.request\nurllib.request.urlopen('https://evil.example.com/x')", "d.py": "eval('1')",
    "e.py": "import shutil\nshutil.rmtree('outputs')", "f.py": "import socket", "g.py": "x = __import__('os')",
    "h.py": "from docx import Document\nimport ctypes", "i.py": "print(getattr(object, 'x'))",
  })) assert.equal(await v(tmpPy(n, code)), "deny", `debe negar script ${n}`);
  assert.equal(await v("python3 tmp/noexiste.py"), "deny");
  assert.equal(await v("node tmp/ok.py"), "deny", "node no puede ejecutar scripts de tmp/");
  // lo demás sigue confinado igual
  assert.equal((await can("Read", { file_path: "/etc/passwd" })).behavior, "deny");
  // sin permiso de scripts, ni siquiera el script de la skill
  const off = runner.makeCanUseTool({ runDir: dir, allowScripts: false, restricted: true, skillName: "iso" });
  assert.equal((await off("Bash", { command: `python ${S}` })).behavior, "deny");
});

test("21. modo restringido: Bash habilitado y sin opciones de sandbox", async () => {
  let seen;
  runner.setQueryImpl(async function* ({ options }) {
    seen = { options };
    yield { type: "result", subtype: "success", is_error: false, result: "", total_cost_usd: 0, num_turns: 1 };
  });
  process.env.SKILLS_ALLOW_RESTRICTED = "1";
  const r = await call("PATCH", "/api/admin/skills/contrato-nda", { cookie: A, json: { scriptsMode: 2 } });
  assert.equal(r.status, 200);
  await runner.runSkill({ name: "contrato-nda", text: "revisa", scriptsMode: 2 });
  assert.ok(seen.options.tools.includes("Bash"));
  assert.equal(seen.options.sandbox, undefined, "sin sandbox en modo restringido");
  // si el servidor no lo permite, se degrada a bloqueado
  process.env.SKILLS_ALLOW_RESTRICTED = "0";
  const r2 = await call("PATCH", "/api/admin/skills/contrato-nda", { cookie: A, json: { scriptsMode: 2 } });
  assert.equal(r2.status, 400);
  seen = undefined;
  await runner.runSkill({ name: "contrato-nda", text: "revisa", scriptsMode: 2 });
  assert.ok(!seen.options.tools.includes("Bash"));
  delete process.env.SKILLS_ALLOW_RESTRICTED;
  runner.setQueryImpl(null);
});

// ---------- Vercel: skills por API de GitHub, Storage de Supabase y cron ----------

const realFetch = globalThis.fetch;
const withFetch = async (handler, fn) => {
  globalThis.fetch = (url, init) => handler(String(url), init) ?? realFetch(url, init);
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
};
const savedEnv = {};
const setEnv = (o) => Object.entries(o).forEach(([k, v]) => { if (!(k in savedEnv)) savedEnv[k] = process.env[k]; v === undefined ? delete process.env[k] : (process.env[k] = v); });
const restoreEnv = () => { for (const [k, v] of Object.entries(savedEnv)) v === undefined ? delete process.env[k] : (process.env[k] = v); for (const k of Object.keys(savedEnv)) delete savedEnv[k]; };

test("22. skills por la API de GitHub (sin git): solo la carpeta de skills, sin enlaces, y sin descargar si no hay cambios", async () => {
  const tar = await import("tar");
  const src = path.join(tmp, "tarsrc");
  const top = path.join(src, "acme-skills-abc123");
  fs.mkdirSync(path.join(top, ".claude/skills/skill-api"), { recursive: true });
  fs.writeFileSync(path.join(top, ".claude/skills/skill-api/SKILL.md"), skillMd("skill-api", "Viene por API"));
  fs.writeFileSync(path.join(top, "README.md"), "no debe copiarse");
  fs.mkdirSync(path.join(top, "otra"), { recursive: true });
  fs.writeFileSync(path.join(top, "otra/x.txt"), "tampoco");
  fs.symlinkSync("/etc/passwd", path.join(top, ".claude/skills/skill-api/enlace"));
  const tgz = path.join(tmp, "repo.tgz");
  await tar.c({ gzip: true, file: tgz, cwd: src }, ["acme-skills-abc123"]);
  const bytes = fs.readFileSync(tgz);
  const SHA = "a".repeat(40);
  const calls = [];
  setEnv({ SKILLS_FETCH: "api", SKILLS_REPO_URL: "https://github.com/acme/skills", SKILLS_REPO_TOKEN: "ghp_secreto", SKILLS_DIR: path.join(tmp, "skills-api"), SKILLS_ALLOW_LOCAL: "0" });
  try {
    await withFetch((url, init) => {
      if (!url.startsWith("https://api.github.com/")) return undefined;
      calls.push(url);
      assert.equal(init.headers.Authorization, "Bearer ghp_secreto");
      if (url.endsWith("/commits/main")) return new Response(SHA);
      if (url.endsWith(`/tarball/${SHA}`)) return new Response(bytes);
      return new Response("no", { status: 404 });
    }, async () => {
      const st = await git_.syncSkills("prueba-api");
      assert.equal(st.ok, true, st.error);
      assert.equal(st.sha, SHA.slice(0, 12));
      const root = git_.skillsRoot();
      assert.ok(fs.existsSync(path.join(root, "skill-api/SKILL.md")));
      assert.ok(!fs.existsSync(path.join(root, "skill-api/enlace")), "sin enlaces simbólicos");
      assert.ok(!fs.existsSync(path.join(process.env.SKILLS_DIR, "README.md")) && !fs.existsSync(path.join(process.env.SKILLS_DIR, "otra")));
      assert.ok(await dbm.get("SELECT 1 AS x FROM skills WHERE name = 'skill-api' AND present = 1"));
      const n = calls.length;
      await git_.syncSkills("prueba-api");
      assert.equal(calls.filter((c) => c.includes("/tarball/")).length, 1, "mismo commit: no vuelve a descargar");
      assert.ok(calls.length > n, "pero sí consulta el commit");
      // arranque en frío: carpeta vacía → ensureSkills la reconstruye
      fs.rmSync(process.env.SKILLS_DIR, { recursive: true, force: true });
      await git_.ensureSkills();
      assert.ok(fs.existsSync(path.join(git_.skillsRoot(), "skill-api/SKILL.md")));
    });
    // URL que no es de GitHub en modo API: error claro, sin filtrar el token
    setEnv({ SKILLS_REPO_URL: "https://gitlab.com/a/b" });
    const bad = await git_.syncSkills("prueba-api");
    assert.equal(bad.ok, false);
    assert.ok(!JSON.stringify(bad).includes("ghp_secreto"));
  } finally {
    restoreEnv();
  }
});

test("23. Supabase Storage: guarda, firma la descarga y borra; la descarga redirige a la URL firmada", async () => {
  const st = await import("../src/storage.js");
  const f = path.join(tmp, "salida.docx");
  fs.writeFileSync(f, "contenido");
  const log = [];
  setEnv({ STORAGE: "supabase", SUPABASE_URL: "https://sb.test", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_x" });
  try {
    await withFetch((url, init) => {
      if (!url.startsWith("https://sb.test/")) return undefined;
      log.push([init?.method || "GET", url]);
      assert.equal(init.headers.Authorization, "Bearer sb_secret_x");
      if (init.method === "POST" && url.includes("/object/sign/")) return Response.json({ signedURL: "/object/sign/portal-files/outputs/r1/a%20b.docx?token=T" });
      if (init.method === "POST") return Response.json({ Key: "ok" });
      if (init.method === "DELETE") return Response.json([]);
      return new Response("x");
    }, async () => {
      await st.saveOutput("r1", "a b.docx", f);
      const t = await st.downloadTarget("r1", "a b.docx");
      assert.equal(t.url, "https://sb.test/storage/v1/object/sign/portal-files/outputs/r1/a%20b.docx?token=T&download=a%20b.docx");
      await st.removeRun("r1", ["a b.docx"]);
    });
    assert.equal(log[0][1], "https://sb.test/storage/v1/object/portal-files/outputs/r1/a%20b.docx");
    assert.deepEqual(log.map((l) => l[0]), ["POST", "POST", "DELETE"]);
    // sin credenciales: error claro
    setEnv({ SUPABASE_SERVICE_ROLE_KEY: "" });
    await assert.rejects(() => st.saveOutput("r1", "x", f), /SUPABASE_SERVICE_ROLE_KEY/);
  } finally {
    restoreEnv();
  }
});

test("24. cron de mantenimiento: exige CRON_SECRET; limpia y sincroniza", async () => {
  setEnv({ CRON_SECRET: "cron-largo-de-prueba" });
  try {
    assert.equal((await call("GET", "/api/cron/maintenance", {})).status, 401);
    const r = await call("GET", "/api/cron/maintenance", { headers: { authorization: "Bearer mal" } });
    assert.equal(r.status, 401);
    const ok = await call("GET", "/api/cron/maintenance", { headers: { authorization: "Bearer cron-largo-de-prueba" } });
    assert.equal(ok.status, 200);
    const j = await ok.json();
    assert.equal(j.ok, true); assert.equal(j.outputs, "ok"); assert.equal(j.sessions, "ok");
  } finally {
    restoreEnv();
  }
  assert.equal((await call("GET", "/api/cron/maintenance", { headers: { authorization: "Bearer cron-largo-de-prueba" } })).status, 401, "sin CRON_SECRET queda cerrado");
});

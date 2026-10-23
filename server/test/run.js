// Pruebas de aceptación del backend (usa modo simulado de Claude; no gasta API).
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "portal-"));
process.env.DB_PATH = path.join(tmp, "t.db");
process.env.CLAUDE_MOCK = "1";
process.env.LOGIN_ATTEMPTS = "1000";

const { createApp } = await import("../src/app.js");
const dbm = await import("../src/db.js");
const claude = await import("../src/claude.js");

const server = createApp().listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

const H = { "x-requested-with": "portal" };

async function call(method, url, { cookie, json, form } = {}) {
  const headers = { ...H };
  let body;
  if (cookie) headers.cookie = cookie;
  if (json) { headers["content-type"] = "application/json"; body = JSON.stringify(json); }
  if (form) body = form;
  const res = await fetch(base + url, { method, headers, body });
  return res;
}
async function login(token) {
  const res = await call("POST", "/api/login", { json: { token } });
  const sc = res.headers.get("set-cookie");
  return { res, cookie: sc ? sc.split(";")[0] : null, sc, body: await res.json() };
}
async function run(cookie, task, fields = {}, file) {
  const form = new FormData();
  form.set("task", task);
  form.set("fields", JSON.stringify(fields));
  if (file) form.set("file", new Blob([file.data], { type: file.type }), file.name);
  const res = await call("POST", "/api/run", { cookie, form });
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("text/event-stream")) {
    const raw = await res.text();
    const events = raw.split("\n\n").filter(Boolean).map((l) => JSON.parse(l.replace(/^data: /, "")));
    return { status: res.status, events, text: events.filter((e) => e.t === "text").map((e) => e.v).join("") };
  }
  return { status: res.status, body: await res.json() };
}

const user = await dbm.createToken({ name: "Ana Prueba", dailyLimit: 5 });
const admin = await dbm.createToken({ name: "Admin", role: "admin" });

test("1-2. login: token inválido, válido, revocado y expirado", async () => {
  let r = await login("gbl_nope");
  assert.equal(r.res.status, 401); assert.equal(r.body.error, "invalid"); assert.match(r.body.message, /no es válido/);
  r = await login("basura");
  assert.equal(r.res.status, 401);

  r = await login(user.token);
  assert.equal(r.res.status, 200); assert.equal(r.body.user.name, "Ana Prueba");

  const rev = await dbm.createToken({ name: "Rev" });
  await dbm.run("UPDATE tokens SET revoked_at = ? WHERE id = ?", [dbm.nowStr(), rev.id]);
  r = await login(rev.token); assert.equal(r.body.error, "revoked");

  const exp = await dbm.createToken({ name: "Exp", expiresInDays: 1 });
  await dbm.run("UPDATE tokens SET expires_at = ? WHERE id = ?", [dbm.nowStr(new Date(Date.now() - 864e5)), exp.id]);
  r = await login(exp.token); assert.equal(r.body.error, "expired");
});

test("2. sin sesión no hay acceso a nada", async () => {
  for (const [m, u] of [["GET", "/api/tasks"], ["GET", "/api/me"], ["POST", "/api/run"], ["GET", "/api/admin/tokens"]])
    assert.equal((await call(m, u)).status, 401, u);
});

test("3. el token nunca se expone: cookie HttpOnly/SameSite y respuestas sin token", async () => {
  const { sc, cookie, body } = await login(user.token);
  assert.match(sc, /HttpOnly/i); assert.match(sc, /SameSite=Strict/i);
  assert.ok(!cookie.includes(user.token));
  assert.ok(!JSON.stringify(body).includes(user.token));
  const me = await (await call("GET", "/api/me", { cookie })).text();
  assert.ok(!me.includes(user.token));
  // En BD solo hay hash
  const rows = JSON.stringify(await dbm.all("SELECT * FROM tokens"));
  assert.ok(!rows.includes(user.token));
});

test("CSRF: escritura sin cabecera es rechazada", async () => {
  const res = await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: user.token }) });
  assert.equal(res.status, 403);
});

test("3. sesión inactiva expira y cerrar sesión la invalida", async () => {
  const { cookie } = await login(user.token);
  assert.equal((await call("GET", "/api/tasks", { cookie })).status, 200);
  await dbm.run("UPDATE sessions SET last_seen = last_seen - 31*60*1000");
  const r = await call("GET", "/api/tasks", { cookie });
  assert.equal(r.status, 401); assert.equal((await r.json()).error, "session_expired");

  const l2 = await login(user.token);
  await call("POST", "/api/logout", { cookie: l2.cookie });
  assert.equal((await call("GET", "/api/me", { cookie: l2.cookie })).status, 401);
});

test("4. catálogo de 4 tareas", async () => {
  const { cookie } = await login(user.token);
  const { tasks } = await (await call("GET", "/api/tasks", { cookie })).json();
  assert.deepEqual(tasks.map((t) => t.id), ["summarize", "email", "analyze", "translate"]);
});

test("5. ejecutar tareas devuelve streaming y termina con done", async () => {
  const { cookie } = await login(user.token);
  const r = await run(cookie, "translate", { text: "Hola equipo", target: "inglés" });
  assert.equal(r.status, 200);
  assert.ok(r.events.length >= 3);
  assert.equal(r.events.at(-1).t, "done");
  assert.match(r.text, /Respuesta simulada/);
  const e = await run(cookie, "email", { text: "Reunión mañana", tone: "formal", recipient: "Luis" });
  assert.equal(e.events.at(-1).t, "done");
});

test("validaciones de formulario", async () => {
  const { cookie } = await login(user.token);
  assert.equal((await run(cookie, "nada", {})).status, 400);
  assert.equal((await run(cookie, "email", { text: "", tone: "formal" })).status, 400);
  assert.equal((await run(cookie, "email", { text: "x", tone: "inventado" })).status, 400);
  assert.equal((await run(cookie, "summarize", {})).status, 400);
  assert.equal((await run(cookie, "analyze", { text: "¿total?" })).status, 400); // falta archivo
  assert.equal((await run(cookie, "translate", { text: "a".repeat(60_001), target: "inglés" })).status, 413);
});

test("archivos: CSV ok, formato no soportado, PDF falso, xlsx roto", async () => {
  const { cookie } = await login(user.token);
  const ok = await run(cookie, "analyze", { text: "¿Cuál es el total?" }, { name: "v.csv", type: "text/csv", data: "a,b\n1,2\n3,4" });
  assert.equal(ok.events.at(-1).t, "done");
  assert.equal((await run(cookie, "analyze", { text: "?" }, { name: "x.exe", type: "application/octet-stream", data: "MZ" })).status, 400);
  assert.equal((await run(cookie, "analyze", { text: "?" }, { name: "x.pdf", type: "application/pdf", data: "no soy pdf" })).status, 400);
  assert.equal((await run(cookie, "analyze", { text: "?" }, { name: "x.xlsx", type: "application/octet-stream", data: "roto" })).status, 400);
  const big = await run(cookie, "analyze", { text: "?" }, { name: "g.csv", type: "text/csv", data: Buffer.alloc(11 * 1024 * 1024, "a") });
  assert.equal(big.status, 413);
});

test("7. errores de Claude se traducen a mensajes claros", async () => {
  const { cookie } = await login(user.token);
  for (const [code, re] of [["rate_limit", /muchas solicitudes/], ["no_credit", /saldo/], ["network", /conectar/], ["overloaded", /saturado/]]) {
    process.env.CLAUDE_MOCK_ERROR = code;
    claude.setClient(null);
    const r = await run(cookie, "translate", { text: "hola", target: "inglés" });
    const err = r.events.find((e) => e.t === "error");
    assert.ok(err, code); assert.equal(err.code, code); assert.match(err.message, re);
    assert.ok(!/stack|at |node_modules/.test(err.message));
  }
  delete process.env.CLAUDE_MOCK_ERROR; claude.setClient(null);
});

test("8. registro de ejecuciones: usuario, tarea, fecha; sin token ni contenido", async () => {
  const rows = await dbm.all("SELECT * FROM runs");
  assert.ok(rows.length > 5);
  const dump = JSON.stringify(rows);
  assert.ok(!dump.includes(user.token) && !dump.includes("Hola equipo") && !dump.includes("Reunión mañana"));
  const ok = rows.find((r) => r.status === "ok");
  assert.equal(ok.user_name, "Ana Prueba"); assert.ok(ok.task && ok.created_at);
  assert.ok(rows.some((r) => r.status === "error" && r.error_code === "rate_limit"));
});

test("límite diario por token", async () => {
  const t = await dbm.createToken({ name: "Poco", dailyLimit: 2 });
  const { cookie } = await login(t.token);
  for (let i = 0; i < 2; i++) assert.equal((await run(cookie, "translate", { text: "x", target: "inglés" })).events.at(-1).t, "done");
  const r = await run(cookie, "translate", { text: "x", target: "inglés" });
  assert.equal(r.status, 429); assert.equal(r.body.error, "quota"); assert.match(r.body.message, /límite de 2/);
  const me = await (await call("GET", "/api/me", { cookie })).json();
  assert.deepEqual(me.usage, { used: 2, limit: 2 });
});

test("9. admin: crear, listar, ampliar límite, renovar y revocar con efecto inmediato", async () => {
  const a = await login(admin.token);
  const u = await login(user.token);
  assert.equal((await call("GET", "/api/admin/tokens", { cookie: u.cookie })).status, 403);
  assert.equal((await call("GET", "/api/admin/runs", { cookie: u.cookie })).status, 403);

  const created = await (await call("POST", "/api/admin/tokens", { cookie: a.cookie, json: { name: "Nuevo", dailyLimit: 10, expiresInDays: 30 } })).json();
  assert.match(created.token, /^gbl_/);
  const list = await (await call("GET", "/api/admin/tokens", { cookie: a.cookie })).json();
  const row = list.tokens.find((t) => t.id === created.id);
  assert.equal(row.status, "active"); assert.equal(row.dailyLimit, 10);
  assert.ok(!JSON.stringify(list).includes(created.token)); // la lista nunca trae el token completo

  assert.equal((await call("PATCH", `/api/admin/tokens/${created.id}`, { cookie: a.cookie, json: { dailyLimit: 99 } })).status, 200);

  const n = await login(created.token);
  assert.equal((await call("GET", "/api/me", { cookie: n.cookie })).status, 200);

  const renewed = await (await call("POST", `/api/admin/tokens/${created.id}/renew`, { cookie: a.cookie })).json();
  assert.notEqual(renewed.token, created.token);
  const dead = await call("GET", "/api/me", { cookie: n.cookie });
  assert.equal(dead.status, 401, "la sesión del token viejo cae al instante");
  assert.equal((await dead.json()).error, "revoked", "y el usuario ve que fue revocado, no 'sesión expirada'");
  assert.equal((await login(created.token)).body.error, "revoked");
  assert.equal((await login(renewed.token)).res.status, 200);

  assert.equal((await call("POST", `/api/admin/tokens/${admin.id}/revoke`, { cookie: a.cookie })).status, 400); // no auto-revocarse
  const runs = await (await call("GET", "/api/admin/runs", { cookie: a.cookie })).json();
  assert.ok(runs.runs.length > 0 && !("token" in runs.runs[0]));
});

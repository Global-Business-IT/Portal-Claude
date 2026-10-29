// PRUEBA DE VIABILIDAD (se borra después): ¿corre el Claude Agent SDK dentro de una función de Vercel?
//   GET /api/spike?mode=info   → diagnóstico (sin llamar a Anthropic, sin costo)
//   GET /api/spike?mode=query  → una consulta mínima al SDK ("responde OK")
//   GET /api/spike?mode=write  → el agente crea un archivo con la herramienta Write (prueba subprocesos y /tmp)
// Todas exigen la cabecera  x-spike-key  igual a la variable SPIKE_KEY (para que nadie gaste tu clave).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

const BIN = path.join(process.cwd(), "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude");

function info() {
  const out = { node: process.version, platform: process.platform, arch: process.arch, cwd: process.cwd(), tmp: os.tmpdir() };
  try {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "probe-"));
    fs.writeFileSync(path.join(d, "x.txt"), "ok");
    out.tmpWritable = fs.readFileSync(path.join(d, "x.txt"), "utf8") === "ok";
  } catch (e) {
    out.tmpWritable = false;
    out.tmpError = String(e.message);
  }
  try {
    const st = fs.statSync(BIN);
    out.binary = { path: BIN, exists: true, mb: Math.round(st.size / 1e6), executable: Boolean(st.mode & 0o111) };
  } catch (e) {
    out.binary = { path: BIN, exists: false, error: String(e.message) };
  }
  out.env = { ANTHROPIC_API_KEY: Boolean(process.env.ANTHROPIC_API_KEY), SPIKE_KEY: Boolean(process.env.SPIKE_KEY) };
  return out;
}

export default async function handler(req, res) {
  const key = process.env.SPIKE_KEY;
  if (!key || req.headers["x-spike-key"] !== key) return res.status(401).json({ error: "no autorizado" });

  const mode = String(req.query?.mode || "info");
  const out = info();
  out.mode = mode;
  if (mode === "info") return res.status(200).json(out);

  const started = Date.now();
  const stderr = [];
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "spike-"));
  fs.mkdirSync(path.join(work, "outputs"));
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 100_000);
  try {
    const writeMode = mode === "write";
    const options = {
      cwd: work,
      abortController: ac,
      ...(out.binary.exists ? { pathToClaudeCodeExecutable: BIN } : {}),
      tools: writeMode ? ["Write"] : [],
      permissionMode: "default",
      canUseTool: async (_t, input) => ({ behavior: "allow", updatedInput: input }),
      maxTurns: 3,
      maxBudgetUsd: 0.2,
      persistSession: false,
      settingSources: [],
      env: {
        PATH: process.env.PATH,
        HOME: work,
        TMPDIR: work,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        DISABLE_TELEMETRY: "1",
        DISABLE_AUTOUPDATER: "1",
      },
      stderr: (s) => stderr.push(String(s)),
      ...(process.env.SKILL_MODEL ? { model: process.env.SKILL_MODEL } : {}),
    };
    const prompt = writeMode ? "Crea el archivo outputs/hola.txt con el texto: hola desde vercel. Luego responde solo: LISTO" : "Responde solo con la palabra: OK";
    let result = null;
    for await (const msg of query({ prompt, options })) {
      if (msg.type === "result") result = { subtype: msg.subtype, text: msg.result, costUsd: msg.total_cost_usd, turns: msg.num_turns };
    }
    out.result = result;
    if (writeMode) {
      const f = path.join(work, "outputs", "hola.txt");
      out.fileCreated = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : false;
    }
    out.ok = Boolean(result && result.subtype === "success");
  } catch (e) {
    out.ok = false;
    out.error = String(e?.message || e).slice(0, 800);
  } finally {
    clearTimeout(timer);
    out.ms = Date.now() - started;
    out.stderrTail = stderr.join("").slice(-1500);
    fs.rm(work, { recursive: true, force: true }, () => {});
  }
  res.status(200).json(out);
}

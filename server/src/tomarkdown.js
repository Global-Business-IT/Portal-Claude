// Convierte los archivos que adjunta el usuario a Markdown usando MarkItDown (Microsoft, Python).
// Se ejecuta como proceso aparte, con entorno mínimo (sin la API key) y tiempo máximo.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONVERTIBLE = new Set([".pdf", ".docx", ".pptx", ".xlsx", ".xls", ".csv", ".html", ".htm", ".xml", ".json", ".epub"]);
const MIN_TEXT_CHARS = 20; // por debajo se considera que el archivo no tenía texto (p. ej. PDF escaneado)

const cfg = () => ({
  bin: process.env.MARKITDOWN_BIN || "markitdown",
  timeoutMs: (Number(process.env.MARKITDOWN_TIMEOUT_SEC) || 60) * 1000,
  maxChars: Number(process.env.MARKITDOWN_MAX_CHARS) || 400_000,
  enabled: process.env.MARKITDOWN_ENABLED !== "0",
});

let unavailable = false; // si el programa no está instalado, se avisa una vez y se sigue con los originales
let impl = null; // para pruebas

export function setConverterImpl(fn) {
  impl = fn;
  unavailable = false;
}
export const resetAvailability = () => { unavailable = false; };
export const canConvert = (name) => CONVERTIBLE.has(path.extname(name).toLowerCase());

function runMarkItDown(file) {
  const c = cfg();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mid-"));
  const out = path.join(tmp, "out.md");
  const env = { PATH: process.env.PATH, LANG: "C.UTF-8", PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", TMPDIR: tmp, TEMP: tmp, TMP: tmp, HOME: tmp, USERPROFILE: tmp };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot; // Windows
  return new Promise((resolve) => {
    execFile(c.bin, [file, "-o", out], { env, cwd: tmp, timeout: c.timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true }, (err) => {
      let result;
      if (err) {
        result = { ok: false, reason: err.code === "ENOENT" ? "no_instalado" : err.killed ? "tiempo" : "error" };
      } else {
        try {
          result = { ok: true, md: fs.readFileSync(out, "utf8") };
        } catch {
          result = { ok: false, reason: "error" };
        }
      }
      fs.rmSync(tmp, { recursive: true, force: true });
      resolve(result);
    });
  });
}

/** Devuelve { ok:true, md } o { ok:false, reason } (no_instalado | tiempo | error | sin_texto | no_aplica). Nunca lanza. */
export async function convertToMarkdown(file) {
  const c = cfg();
  if (!c.enabled || unavailable) return { ok: false, reason: "no_aplica" };
  if (!canConvert(file)) return { ok: false, reason: "no_aplica" };
  let r;
  try {
    r = await (impl ? impl(file) : runMarkItDown(file));
  } catch {
    r = { ok: false, reason: "error" };
  }
  if (!r.ok) {
    if (r.reason === "no_instalado") {
      unavailable = true;
      console.warn("ℹ  MarkItDown no está instalado: los archivos se entregan a las skills sin convertir. (pip install 'markitdown[all]')");
    }
    return r;
  }
  const md = String(r.md || "").replace(/\r\n/g, "\n").trim();
  if (md.length < MIN_TEXT_CHARS) return { ok: false, reason: "sin_texto" };
  return { ok: true, md: md.length > c.maxChars ? md.slice(0, c.maxChars) + "\n\n[… texto recortado por tamaño …]" : md };
}

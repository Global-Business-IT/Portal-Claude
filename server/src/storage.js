// Archivos generados por las skills. Dos almacenes con la misma API:
//  - local    : carpeta OUTPUTS_DIR (desarrollo, contenedor con volumen).
//  - supabase : bucket privado de Supabase Storage (Vercel: el disco se borra entre ejecuciones).
// Por defecto: supabase si corre en Vercel o STORAGE=supabase; local en cualquier otro caso.
import fs from "node:fs";
import path from "node:path";

export const serverless = Boolean(process.env.VERCEL);
export const storageKind = () => {
  const k = (process.env.STORAGE || "").toLowerCase();
  if (k === "supabase" || k === "local") return k;
  return serverless ? "supabase" : "local";
};

export const outputsRoot = () => path.resolve(process.env.OUTPUTS_DIR || (serverless ? "/tmp/outputs" : "./data/outputs"));
const bucket = () => process.env.STORAGE_BUCKET || "portal-files";

function sb() {
  const base = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!base || !key) throw new Error("Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY para usar Supabase Storage.");
  return { base: `${base}/storage/v1`, headers: { Authorization: `Bearer ${key}`, apikey: key } };
}

const objPath = (runId, name) => `outputs/${runId}/${name}`;
const enc = (p) => p.split("/").map(encodeURIComponent).join("/");

async function sbFetch(url, init, okStatuses = [200]) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  if (!okStatuses.includes(r.status)) {
    const t = (await r.text().catch(() => "")).slice(0, 200);
    throw new Error(`Storage ${r.status}: ${t}`);
  }
  return r;
}

/** Guarda un archivo ya generado (ruta local) bajo runId/name. */
export async function saveOutput(runId, name, filePath) {
  if (storageKind() === "local") {
    const dest = path.join(outputsRoot(), runId);
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(filePath, path.join(dest, name));
    return;
  }
  const { base, headers } = sb();
  await sbFetch(
    `${base}/object/${bucket()}/${enc(objPath(runId, name))}`,
    { method: "POST", headers: { ...headers, "Content-Type": "application/octet-stream", "x-upsert": "true" }, body: fs.readFileSync(filePath) },
    [200, 201]
  );
}

/** Contenido completo (Buffer) o null si no existe. */
export async function readOutput(runId, name) {
  if (storageKind() === "local") {
    const root = path.join(outputsRoot(), runId);
    const file = path.join(root, name);
    if (path.relative(root, file).startsWith("..") || !fs.existsSync(file)) return null;
    return fs.readFileSync(file);
  }
  const { base, headers } = sb();
  const r = await fetch(`${base}/object/${bucket()}/${enc(objPath(runId, name))}`, { headers, signal: AbortSignal.timeout(30_000) });
  if (r.status === 404 || r.status === 400) return null;
  if (!r.ok) throw new Error(`Storage ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

/**
 * Para descargas directas: en local devuelve { path } (res.download); en Supabase devuelve { url } con
 * una URL firmada de corta vida (así el archivo no pasa por la función y no pesa el límite de 4,5 MB).
 */
export async function downloadTarget(runId, name) {
  if (storageKind() === "local") {
    const root = path.join(outputsRoot(), runId);
    const file = path.join(root, name);
    if (path.relative(root, file).startsWith("..") || !fs.existsSync(file)) return null;
    return { path: file };
  }
  const { base, headers } = sb();
  const r = await fetch(`${base}/object/sign/${bucket()}/${enc(objPath(runId, name))}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: 120 }),
    signal: AbortSignal.timeout(15_000),
  });
  if (r.status === 404 || r.status === 400) return null;
  if (!r.ok) throw new Error(`Storage ${r.status}`);
  const { signedURL } = await r.json();
  if (!signedURL) return null;
  return { url: `${base}${signedURL}${signedURL.includes("?") ? "&" : "?"}download=${encodeURIComponent(name)}` };
}

/** Borra los archivos de una ejecución. `names` = archivos registrados en run_files. */
export async function removeRun(runId, names = []) {
  if (storageKind() === "local") {
    fs.rmSync(path.join(outputsRoot(), runId), { recursive: true, force: true });
    return;
  }
  if (!names.length) return;
  const { base, headers } = sb();
  await sbFetch(
    `${base}/object/${bucket()}`,
    { method: "DELETE", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ prefixes: names.map((n) => objPath(runId, n)) }) },
    [200]
  );
}

const HEADERS = { "X-Requested-With": "portal" };

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || "Error de comunicación con el servidor.");
    this.status = status;
    this.code = body?.error;
  }
}

async function parse(res) {
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* sin cuerpo JSON */
  }
  if (!res.ok) throw new ApiError(res.status, body);
  return body;
}

export async function api(method, url, json) {
  const opts = { method, headers: { ...HEADERS }, credentials: "same-origin" };
  if (json !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(json);
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    throw new ApiError(0, { message: "No hay conexión con el servidor. Revisa tu red e inténtalo de nuevo." });
  }
  return parse(res);
}

/** Ejecuta una tarea y entrega el texto a medida que llega (SSE sobre fetch). */
export async function streamRun(form, { onText, onStatus, onFiles, signal, url = "/api/run" }) {
  let res;
  try {
    res = await fetch(url, { method: "POST", headers: { ...HEADERS }, body: form, credentials: "same-origin", signal });
  } catch (e) {
    if (e.name === "AbortError") throw e;
    throw new ApiError(0, { message: "No hay conexión con el servidor. Revisa tu red e inténtalo de nuevo." });
  }
  if (!(res.headers.get("content-type") || "").includes("text/event-stream")) return parse(res);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (!raw.startsWith("data: ")) continue; // comentarios (": ping") y líneas vacías
      const line = raw.slice(6);
      const ev = JSON.parse(line);
      if (ev.t === "text") onText(ev.v);
      else if (ev.t === "status") onStatus?.(ev.v);
      else if (ev.t === "files") onFiles?.(ev.files);
      else if (ev.t === "error") throw new ApiError(200, { error: ev.code, message: ev.message });
      else if (ev.t === "done") return;
    }
  }
}

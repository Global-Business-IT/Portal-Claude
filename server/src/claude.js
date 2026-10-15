import Anthropic from "@anthropic-ai/sdk";

export const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-5";
const MAX_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS) || 4096;

let client = null;
export function getClient() {
  if (client) return client;
  if (process.env.CLAUDE_MOCK === "1") {
    client = mockClient();
  } else {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw Object.assign(new Error("missing_api_key"), { code: "config" });
    }
    // La API key de la empresa vive solo en el servidor.
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 120_000 });
  }
  return client;
}
export const setClient = (c) => (client = c); // para pruebas

/** Traduce errores de la API a mensajes comprensibles (sin filtrar detalles internos). */
export function friendlyError(err) {
  const status = err?.status;
  const msg = String(err?.message || "").toLowerCase();
  if (err?.code === "config" || status === 401 || status === 403)
    return { code: "config", message: "El portal no está configurado correctamente con Claude. Avisa al administrador." };
  if (status === 402 || msg.includes("credit balance"))
    return { code: "no_credit", message: "La cuenta de la empresa no tiene saldo disponible en Claude. Avisa al administrador." };
  if (status === 429)
    return { code: "rate_limit", message: "Claude está recibiendo muchas solicitudes. Espera un momento e inténtalo de nuevo." };
  if (status === 413 || (status === 400 && msg.includes("too long")))
    return { code: "too_large", message: "El material es demasiado grande. Prueba con un archivo o texto más corto." };
  if (status === 529 || (status >= 500 && status < 600))
    return { code: "overloaded", message: "Claude está saturado en este momento. Inténtalo de nuevo en un minuto." };
  if (err?.name?.includes("Connection") || err?.name?.includes("Timeout") || err?.code === "ECONNRESET")
    return { code: "network", message: "No se pudo conectar con Claude. Revisa la conexión e inténtalo de nuevo." };
  return { code: "unknown", message: "Ocurrió un error inesperado al ejecutar la tarea. Inténtalo de nuevo." };
}

/**
 * Ejecuta una tarea en streaming. onText recibe cada fragmento.
 * signal permite cancelar si el usuario cierra la pestaña.
 */
export async function runStream({ system, content, onText, signal }) {
  const stream = getClient().messages.stream(
    { model: MODEL, max_tokens: MAX_TOKENS, system, messages: [{ role: "user", content }] },
    { signal }
  );
  let total = 0;
  stream.on("text", (t) => {
    total += t.length;
    onText(t);
  });
  await stream.finalMessage();
  return total;
}

// ---- Modo simulado (CLAUDE_MOCK=1): permite probar el portal sin gastar ni tener API key ----
function mockClient() {
  return {
    messages: {
      stream(params) {
        const handlers = [];
        const fail = process.env.CLAUDE_MOCK_ERROR; // rate_limit | no_credit | network
        const last = params.messages[0].content;
        const preview = (Array.isArray(last) ? last.map((b) => b.text || "[documento]").join(" ") : last)
          .replace(/\s+/g, " ")
          .slice(0, 80);
        const chunks = [`[Respuesta simulada] `, `Recibí tu solicitud: "${preview}..." `, `(modelo ${params.model}).`];
        return {
          on(evt, fn) {
            if (evt === "text") handlers.push(fn);
          },
          async finalMessage() {
            if (fail) {
              const e = new Error(fail);
              e.status = { rate_limit: 429, no_credit: 402, overloaded: 529 }[fail];
              if (fail === "network") e.name = "APIConnectionError";
              throw e;
            }
            for (const c of chunks) {
              await new Promise((r) => setTimeout(r, 40));
              handlers.forEach((h) => h(c));
            }
            return {};
          },
        };
      },
    },
  };
}

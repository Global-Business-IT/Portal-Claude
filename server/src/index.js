import "dotenv/config";
import { createApp } from "./app.js";
import { purgeSessions } from "./sessions.js";
import { MODEL } from "./claude.js";
import { syncSkills, isConfigured } from "./gitsync.js";
import { purgeOutputs } from "./skillrunner.js";

const port = Number(process.env.PORT) || 3000;

if (process.env.CLAUDE_MOCK !== "1" && !process.env.ANTHROPIC_API_KEY) {
  console.warn("⚠  Falta ANTHROPIC_API_KEY en .env: las tareas fallarán hasta configurarla (o usa CLAUDE_MOCK=1 para probar).");
}

setInterval(purgeSessions, 10 * 60_000).unref();
setInterval(purgeOutputs, 30 * 60_000).unref();
purgeOutputs();

// Skills desde GitHub: al arrancar y luego cada SYNC_INTERVAL_MIN minutos (respaldo del webhook).
if (isConfigured()) {
  syncSkills("arranque").then((st) => console.log(st.ok ? `Skills sincronizadas: ${st.count} (commit ${st.sha})` : `⚠  No se pudo sincronizar skills: ${st.error}`));
  const every = Math.max(Number(process.env.SYNC_INTERVAL_MIN) || 10, 1);
  setInterval(() => syncSkills("periódica"), every * 60_000).unref();
} else {
  console.warn("⚠  SKILLS_REPO_URL no está configurado: el portal no ofrecerá skills de la empresa.");
}
if (!process.env.GITHUB_WEBHOOK_SECRET) console.warn("ℹ  GITHUB_WEBHOOK_SECRET vacío: el aviso automático de GitHub está desactivado (queda la sincronización periódica).");

createApp().listen(port, () => {
  console.log(`Portal Claude escuchando en http://localhost:${port}  (modelo: ${MODEL}${process.env.CLAUDE_MOCK === "1" ? ", MODO SIMULADO" : ""})`);
});

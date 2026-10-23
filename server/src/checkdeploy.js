// Verificación del entorno de despliegue: ejecútalo dentro del contenedor con  npm run check-deploy
// No muestra secretos: solo dice si cada variable está definida.
import "dotenv/config";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

let fails = 0;
const ok = (msg) => console.log(`  ✔ ${msg}`);
const bad = (msg) => (fails++, console.log(`  ✖ ${msg}`));
const warn = (msg) => console.log(`  ⚠ ${msg}`);
const run = (bin, args) => execFileSync(bin, args, { stdio: "pipe", timeout: 30000 }).toString().trim();

console.log("Variables de entorno");
for (const k of ["ANTHROPIC_API_KEY", "SKILLS_REPO_URL", "SKILLS_REPO_TOKEN"]) (process.env[k] ? ok : bad)(`${k} ${process.env[k] ? "definida" : "VACÍA"}`);
for (const k of ["GITHUB_WEBHOOK_SECRET"]) (process.env[k] ? ok : warn)(`${k} ${process.env[k] ? "definida" : "vacía (sin aviso automático de GitHub)"}`);
if (process.env.CLAUDE_MOCK === "1") warn("CLAUDE_MOCK=1: respuestas simuladas, quítalo en producción");
if (process.env.NODE_ENV !== "production") warn("NODE_ENV no es production: la cookie no se marca Secure");
if (!Number(process.env.TRUST_PROXY)) warn("TRUST_PROXY=0: si hay un balanceador/proxy delante, pon 1");
if (process.platform !== "win32" && process.env.SKILLS_ALLOW_RESTRICTED === "1") warn("SKILLS_ALLOW_RESTRICTED=1: en Linux usa el modo Aislados (sandbox), no el restringido");
ok(`SKILL_SANDBOX_DOMAINS = ${process.env.SKILL_SANDBOX_DOMAINS || "(vacío: scripts sin red)"}`);

console.log("Datos");
const dataDir = path.dirname(path.resolve(process.env.DB_PATH || "./data/portal.db"));
try {
  fs.mkdirSync(dataDir, { recursive: true });
  const probe = path.join(dataDir, `.probe-${process.pid}`);
  fs.writeFileSync(probe, "x");
  fs.unlinkSync(probe);
  ok(`${dataDir} escribible (debe ser un volumen persistente)`);
} catch (e) {
  bad(`${dataDir} no es escribible: ${e.code || e.message}`);
}

console.log("Programas");
const check = (label, bin, args, required = true) => {
  try {
    ok(`${label}: ${run(bin, args).split("\n")[0]}`);
  } catch {
    (required ? bad : warn)(`${label}: no disponible`);
  }
};
check("git", "git", ["--version"]);
check("python", "python", ["-c", "import docx, openpyxl, PIL, requests, lxml; print('python-docx, openpyxl, pillow, requests, lxml OK')"]);
check("MarkItDown", process.env.MARKITDOWN_BIN || "markitdown", ["--version"], false);

console.log("Sandbox (modo Aislados)");
if (process.platform !== "linux") {
  warn("solo se comprueba en Linux");
} else {
  check("socat", "socat", ["-V"]);
  try {
    run("bwrap", ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--unshare-all", "--die-with-parent", "true"]);
    ok("bubblewrap crea namespaces y monta /proc");
  } catch {
    try {
      run("bwrap", ["--ro-bind", "/", "/", "--dev", "/dev", "--unshare-all", "--die-with-parent", "true"]);
      (process.env.SKILL_SANDBOX_WEAKER_NESTED === "1" ? ok : bad)(
        "bubblewrap funciona pero sin /proc propio: requiere SKILL_SANDBOX_WEAKER_NESTED=1" +
          (process.env.SKILL_SANDBOX_WEAKER_NESTED === "1" ? " (ya activado)" : ""),
      );
    } catch (e) {
      bad(`bubblewrap no puede crear namespaces (${String(e.stderr || e.message).trim().split("\n").pop()}). Ver docker-compose.yml`);
    }
  }
}

console.log(fails ? `\n${fails} problema(s) por resolver.` : "\nTodo listo.");
process.exit(fails ? 1 : 0);

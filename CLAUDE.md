# Portal Claude — contexto del proyecto

Portal web (Node.js/Express + React/Vite) para que personas **sin cuenta de Claude** usen Claude mediante tokens internos (`gbl_…`) y, sobre todo, las **skills de la empresa**. Empresa: Gbit_AI / Global Business IT. Idioma de trabajo con la usuaria (Alexa Margarita): español.

## Cómo funciona

- **Acceso:** tokens internos con hash SHA-256 en la base de datos, sesiones por cookie, cabecera CSRF `X-Requested-With: portal`, límites diarios y rate limits. Roles `user` y `admin`. No hay registro público: el primer admin se crea por consola (`npm run create-token -- --name "Nombre" --role admin`).
- **Clave de Anthropic:** una sola, de la empresa, SOLO en el servidor (`server/.env`). Nunca se sube a Git ni llega al navegador.
- **Skills:** viven en el repo privado `Global-Business-IT/skills-empresa-portal` (rama `main`, carpeta `.claude/skills/`). El servidor las sincroniza con git (token de solo lectura por `GIT_CONFIG` extraheader), por webhook de GitHub (HMAC) y periódicamente. **Toda skill nueva nace desactivada**; un admin la activa en Administración → Skills.
- **Ejecución (`server/src/skillrunner.js`):** Claude Agent SDK, una carpeta aislada por ejecución `data/work/<runId>/{inputs,outputs,tmp,home,.claude/skills/<skill>}`. Herramientas con lista blanca y `canUseTool` que confina lectura/escritura a esa carpeta. Streaming por SSE (eventos `text`, `status`, `files`, `done`, `error`; latido `: ping`).
- **Adjuntos:** se convierten a Markdown con MarkItDown (`server/src/tomarkdown.js`), conservando el original. Si MarkItDown no está instalado, se usan los originales.
- **Salidas:** los `.md` se pueden descargar como Word o PDF (`server/src/convert.js`: marked → docx / pdfkit). En pantalla se muestran con `web/src/Markdown.jsx` (sin `innerHTML`).
- **Base de datos:** SQLite (`better-sqlite3`, `server/src/db.js`): tokens, sesiones, runs (sin contenido), skills.

## Scripts de las skills: tres modos (`skills.allow_scripts`)

0. **Bloqueados** (por defecto).
1. **Aislados (sandbox):** Bash dentro del sandbox del SDK (bubblewrap/seatbelt). Solo Linux/macOS/Docker. **Es el modo recomendado en producción.**
2. **Restringidos (sin aislamiento):** para Windows, donde el sandbox no existe. Permite `python|node <script de la skill>` y scripts Python que Claude escriba en `./tmp/`, tras una revisión estática (AST) en `checkRestrictedCommand` / `PY_GUARD`: lista de módulos permitidos, sin subprocess/os.system/borrados/eval/exec, y solo URLs a hosts permitidos (`SKILL_SCRIPT_HOSTS`, por defecto el Supabase de GBIT). Un solo comando, sin `; && |` ni redirecciones. Es una barrera de mejor esfuerzo, NO un aislamiento. Se activa por defecto solo en Windows (`SKILLS_ALLOW_RESTRICTED`).

La skill `gbit-doc-iso9001` necesita scripts: `gbit_docx_core.py` es una librería que Claude importa desde un script propio en `tmp/` (por eso el modo restringido debe permitir scripts de `tmp/`). Requiere `python-docx`, `openpyxl`, `pillow`, `requests`, `lxml` en el Python del servidor y consulta Supabase de GBIT (solo lectura, con la clave pública que trae la propia skill; no usar `curl`, los scripts usan `urllib`/`requests`). Si Supabase falla, la skill debe usar marcadores en vez de inventar datos. El portal registra en consola cada comando rechazado: `[skill:<nombre>] comando rechazado: … → motivo`.

## Estructura

- `server/src/`: `app.js` (rutas), `skillrunner.js`, `gitsync.js`, `db.js`, `convert.js`, `tomarkdown.js`, `claude.js`, `sessions.js`, `files.js`, `tasks.js`, `cli.js`, `index.js`.
- `server/test/`: `run.js` y `skills.js` (`npm test`, 21 pruebas en skills; la 8 falla en Windows sin modo desarrollador porque no puede crear enlaces simbólicos).
- `server/src/checkdeploy.js`: `npm run check-deploy` verifica el entorno dentro del contenedor (variables, volumen, git, Python, MarkItDown, bubblewrap).
- `web/src/`: `Portal.jsx`, `Admin.jsx`, `Login.jsx`, `Markdown.jsx`, `api.js`.
- `skills-empresa/`: plantilla/copia local del repo de skills. `Dockerfile`, `docker-compose.yml`, `server/.env.example`, `README.md`.

## Reglas de trabajo

- No pegar ni commitear `.env`, tokens `gbl_…`, ni `server/data/` (ya están en `.gitignore`). Si se sube un secreto por error, revocarlo; borrarlo no basta.
- Los cambios de seguridad (confinamiento, modos de scripts) llevan prueba en `server/test/skills.js`.
- No usar `pkill` con patrones amplios; para liberar un puerto: `kill $(lsof -ti :PUERTO)`.
- Probar con `CLAUDE_MOCK=1` para no gastar API.

## Plan de despliegue acordado (Vercel + Supabase + contenedor)

Vercel no puede ejecutar el backend tal cual (funciones de corta duración, sin disco persistente, el SDK lanza subprocesos y escribe carpetas de trabajo, SSE de minutos). Reparto acordado:

1. **Backend en un contenedor Linux** (Railway, Render, Fly.io, Azure Container Apps o servidor de la empresa) usando el `Dockerfile` existente (node 22, git, python3, bubblewrap, socat, MarkItDown). Ahí funciona el **modo 1 (sandbox)**; ya no se depende del modo restringido de Windows. Requiere volumen persistente para `data/` mientras la base siga siendo SQLite, y `TRUST_PROXY=1` detrás del balanceador.
2. **Frontend en Vercel** (`web/`, estático). Decidir cómo habla con el backend: (a) llamadas directas al dominio del backend con CORS + cookies `SameSite=None; Secure`, o (b) rewrites de Vercel a `/api/*` (ojo: SSE largo puede cortarse por el proxy). La opción más simple y robusta es servir el frontend desde el mismo contenedor y omitir Vercel; confirmar con la usuaria.
3. **Supabase (Postgres) como base de datos** en lugar de SQLite: requiere migrar `db.js` (hoy API síncrona de better-sqlite3 usada en `app.js`) a un cliente async (`pg`), con las mismas tablas (`tokens`, `sessions`, `runs`, `skills`). Fase aparte; mientras tanto SQLite sobre volumen persistente con una sola instancia es válido. Ojo: Supabase ya se usa en modo solo lectura por la skill ISO (proyecto `kaffqbjzgkoxzkrocovp`); NO mezclar esas tablas con las del portal ni escribir en ese proyecto; crear un proyecto/esquema propio para el portal.

### Pasos sugeridos

1. Crear repo privado en la organización y subir el código (verificar que no vayan `.env` ni `data/`).
2. Desplegar el contenedor con variables de entorno (clave Anthropic, repo de skills, token de solo lectura, webhook secret) y volumen; crear el primer admin por consola del contenedor.
3. En producción, poner las skills con scripts en modo **Aislados (sandbox)**; comprobar `gbit-doc-iso9001` (requiere red hacia Supabase: el sandbox bloquea red por defecto, define `SKILL_SANDBOX_DOMAINS=kaffqbjzgkoxzkrocovp.supabase.co` en el entorno del servidor; por defecto está vacío = sin red). Si `check-deploy` dice que bubblewrap no puede montar `/proc`, usar `SKILL_SANDBOX_WEAKER_NESTED=1` (activa `enableWeakerNestedSandbox` del SDK).
4. Frontend: decidir (a)/(b) o servirlo desde el backend.
5. Migrar a Supabase Postgres (opcional, fase 2).

## Pendiente / sin probar

- Ejecución real con clave de Anthropic en Windows y en contenedor (hasta ahora solo pruebas con simulación).
- `gbit-doc-iso9001` end-to-end: documento con logo/razón social reales (requiere indicar empresa, tipo, área, proyecto y "elaborado por" en la consulta).
- Docker build y sandbox dentro del contenedor (imagen preparada; falta construirla y correr `npm run check-deploy` en la plataforma elegida).
- Validar y activar el resto de skills del repo.

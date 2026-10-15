# Portal Claude · Global

Portal web donde cada colaborador entra con un **token interno** y ejecuta tareas con Claude
(resumir, redactar correos, analizar archivos, traducir). La API key de Anthropic de la empresa
vive solo en el servidor; los usuarios nunca la ven.

## Arquitectura

```
Navegador (React)  ──cookie HttpOnly──▶  Servidor Express  ──API key empresa──▶  Claude
                                              │
                                          SQLite: tokens (solo hash), sesiones, registro de uso
```

- El usuario pega su token `gbl_…` → el servidor lo valida, crea una sesión y entrega una cookie
  `HttpOnly` + `SameSite=Strict`. El token no se guarda en el navegador.
- En la base de datos solo se guarda el **hash SHA-256** del token (más sus últimos 4 caracteres).
- Revocar un token cierra sus sesiones al instante.
- El registro de uso guarda usuario, tarea, estado y duración. **No guarda tokens ni contenido.**

## Puesta en marcha

Requiere Node 20+.

```bash
npm run install:all
cp server/.env.example server/.env      # y completa ANTHROPIC_API_KEY
npm run build                           # compila el frontend
npm run create-token -- --name "Tu Nombre" --role admin   # primer administrador
npm start                               # http://localhost:3000
```

Desde el panel **Administración** el admin crea, renueva, revoca tokens y ajusta límites diarios.

Para probar sin API key: `CLAUDE_MOCK=1 npm start` (respuestas simuladas).

Desarrollo con recarga: `npm run dev:server` y `npm run dev:web` (http://localhost:5173).

## Pruebas

`npm test` ejecuta 30 pruebas (13 de portal + 17 de skills/GitHub: sincronización, webhook, aislamiento, errores) (login, expiración, revocación, cuota,
archivos, errores de Claude, registro sin datos sensibles, permisos de admin).

## Skills de la empresa desde GitHub

Las skills viven en un repositorio de GitHub (plantilla lista en `skills-empresa/`). El portal las
descarga y las ejecuta en el servidor con el Claude Agent SDK; los usuarios sin cuenta Claude las usan con su token.

**1. Crear el repositorio** (en Windows, PowerShell):

```powershell
cd skills-empresa
git init -b main
git add .
git commit -m "Skills iniciales"
# crea antes un repo vacío en GitHub (privado) y copia su URL
git remote add origin https://github.com/TU-ORG/skills-empresa.git
git push -u origin main
```

Luego sigue `skills-empresa/README.md` (protección de `main`, CODEOWNERS, webhook).

**2. Configurar el portal** (`server/.env`): `SKILLS_REPO_URL`, `SKILLS_REPO_TOKEN` (PAT de solo lectura),
`GITHUB_WEBHOOK_SECRET`. Webhook en GitHub: `https://<tu-portal>/webhooks/github`, JSON, evento *push*.
Si el aviso falla, el portal sincroniza solo cada `SYNC_INTERVAL_MIN` minutos.

**3. Activar:** toda skill nueva queda **desactivada**. Un admin la activa en *Administración → Skills*.
Si trae scripts, además debe permitirlos (por defecto bloqueados; se ejecutan con sandbox, sin red).

**Cómo se aísla cada ejecución:** carpeta temporal propia con solo la skill elegida y los archivos del usuario;
lectura solo dentro de esa carpeta, escritura solo en `outputs/` y `tmp/`; sin web ni subagentes; tope de turnos,
costo (USD) y tiempo; resultados descargables solo por quien los generó y se borran a las 24 h.

**Adjuntos en Markdown:** cuando un usuario adjunta PDF, Word, Excel, PowerPoint, CSV, HTML, JSON o XML, el portal los convierte con
[MarkItDown](https://github.com/microsoft/markitdown) y entrega a la skill el original **y** su versión `.md` en `./inputs`
(p. ej. `informe.pdf` e `informe.pdf.md`). Si un PDF no tiene texto (escaneado), se avisa a la skill para que use el original.
Instalación local: `pip install "markitdown[pdf,docx,pptx,xlsx,xls]"` (Python 3.10+). Sin MarkItDown el portal sigue funcionando con los originales.

**Docker:** `docker compose up --build` (usa `server/.env`; los datos quedan en el volumen `portal-data`).
Para scripts con sandbox en Docker puede hacer falta permitir user namespaces en el host; si no está disponible,
la ejecución falla de forma segura en lugar de correr sin aislamiento.

## Agregar una tarea

Edita `server/src/tasks.js` y añade un objeto a `TASKS` (campos + `build`). El formulario del
frontend se genera solo.

## Seguridad: puntos a cuidar al desplegar

- Sirve siempre por **HTTPS** (la cookie se marca `Secure` con `NODE_ENV=production`).
- Si va detrás de un proxy, configura `TRUST_PROXY=1` para que los límites por IP funcionen.
- El primer admin se crea por consola; no existe registro público.
- Límites incluidos: 10 intentos de login / 15 min por IP, 20 tareas / min por usuario,
  cuota diaria por token, archivos de hasta 10 MB, texto de hasta 60.000 caracteres.
- Haz copia de seguridad de `server/data/portal.db`.

## Scripts de las skills: modos

En Administración → Skills, cada skill con scripts tiene tres modos:

- **Bloqueados** (por defecto).
- **Aislados (sandbox)**: Linux/macOS/Docker; el comando corre en un entorno aislado.
- **Restringidos (sin aislamiento)**: para servidores Windows sin sandbox. Solo se permite
  `python|node <script de la propia skill> [argumentos]`; sin `;`, `&&`, `|`, redirecciones,
  variables ni `python -c`; las rutas de los argumentos deben estar dentro de la carpeta de la ejecución.
  Aun así, los scripts corren con los permisos del usuario del servidor: revísalos en el repositorio.

Requisitos en Windows: Git for Windows (Git Bash, que usa el SDK para Bash), Python en el PATH y las
librerías que use la skill (`pip install python-docx ...`). Variables: `SKILLS_ALLOW_RESTRICTED`, `SKILL_SCRIPT_INTERPRETERS`.

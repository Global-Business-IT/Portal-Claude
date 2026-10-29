# Despliegue en Vercel

El proyecto ya trae `vercel.json` y `api/index.js` (toda la API corre como una función de Vercel; el frontend sale de `web/dist`).

## Variables de entorno (Vercel → Settings → Environment Variables, entorno Production)

| Variable | Valor |
|---|---|
| `ANTHROPIC_API_KEY` | clave de la empresa |
| `SUPABASE_URL` | URL del proyecto Supabase del portal |
| `SUPABASE_SERVICE_ROLE_KEY` | clave secreta de Supabase (solo servidor) |
| `DATABASE_URL` | URI del "Transaction pooler" |
| `PG_POOL_MAX` | `1` |
| `SKILLS_REPO_URL` | `https://github.com/Global-Business-IT/skills-empresa-portal` |
| `SKILLS_REPO_TOKEN` | token de GitHub de solo lectura |
| `GITHUB_WEBHOOK_SECRET` | texto largo aleatorio (opcional; también hay sincronización diaria) |
| `CRON_SECRET` | texto largo aleatorio (Vercel lo usa para el mantenimiento diario) |
| `VERCEL_SUPPORT_LARGE_FUNCTIONS` | `1` |

## Qué cambia respecto a local
- Skills: se descargan con la API de GitHub (no hay `git`); cada instancia comprueba el commit registrado en la base de datos.
- Archivos generados: Supabase Storage (bucket privado `portal-files`), descarga con URL firmada de 2 minutos.
- Subidas: máximo 4 MB en total (límite de Vercel).
- Mantenimiento: cron diario `/api/cron/maintenance` (borra archivos de más de 24 h, sesiones vencidas y sincroniza skills).
- Scripts de skills (modo Bloqueados): en Vercel no hay Python con `python-docx`; las skills con scripts (p. ej. `gbit-doc-iso9001`) quedan pendientes de Vercel Sandbox.
- Webhook de GitHub: `https://TU-DOMINIO/webhooks/github`.

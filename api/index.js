// Punto de entrada de Vercel: toda la API (/api/*) la atiende la aplicación Express.
// vercel.json reescribe /api/* hacia esta función. En local se usa server/src/index.js.
import { createApp } from "../server/src/app.js";

export default createApp();

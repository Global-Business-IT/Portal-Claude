import "dotenv/config";
import { createToken, closeDb } from "./db.js";

// Uso: npm run create-token -- --name "Ana Pérez" [--role admin] [--limit 50] [--days 90]
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1]]);
    return acc;
  }, [])
);

if (!args.name) {
  console.error('Uso: npm run create-token -- --name "Nombre" [--role admin|user] [--limit 50] [--days 90]');
  process.exit(1);
}
if (args.role && !["user", "admin"].includes(args.role)) {
  console.error("--role debe ser user o admin");
  process.exit(1);
}

const { id, token } = await createToken({
  name: args.name,
  role: args.role || "user",
  dailyLimit: Number(args.limit) || 50,
  expiresInDays: args.days ? Number(args.days) : null,
});

console.log(`\nToken #${id} creado para "${args.name}" (${args.role || "user"}).`);
console.log("Cópialo ahora; no se vuelve a mostrar:\n");
console.log("  " + token + "\n");
await closeDb();

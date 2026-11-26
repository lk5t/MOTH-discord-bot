import { closeDb, waitForDatabase } from "./client.js";
import { runMigrations } from "./migrate.js";

await waitForDatabase();
await runMigrations();
console.log("[moth] migrations applied");
await closeDb();

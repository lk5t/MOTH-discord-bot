import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getDb, getPool } from "./client.js";

export const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

/** Applies pending migrations. Guarded by an advisory lock so concurrent services don't race. */
export async function runMigrations(folder = migrationsFolder): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("select pg_advisory_lock(727274)");
    await migrate(getDb(), { migrationsFolder: folder });
  } finally {
    await client.query("select pg_advisory_unlock(727274)").catch(() => undefined);
    client.release();
  }
}

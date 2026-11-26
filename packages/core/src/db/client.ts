import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type Database = NodePgDatabase<typeof schema>;

let pool: pg.Pool | null = null;
let db: Database | null = null;

export function getPool(url = process.env.DATABASE_URL): pg.Pool {
  if (!pool) {
    if (!url) throw new Error("DATABASE_URL is not set");
    pool = new pg.Pool({
      connectionString: url,
      max: Number(process.env.DATABASE_POOL_SIZE ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    // Never crash the process on idle-client errors (e.g. Postgres restart); the pool reconnects.
    pool.on("error", (err) => console.error("[moth:db] idle client error", err.message));
  }
  return pool;
}

export function getDb(): Database {
  if (!db) db = drizzle(getPool(), { schema });
  return db;
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = null;
  db = null;
}

/** Waits for Postgres to accept connections (used at service start-up). */
export async function waitForDatabase(retries = 30, delayMs = 2000): Promise<void> {
  for (let i = 1; i <= retries; i++) {
    try {
      await getPool().query("select 1");
      return;
    } catch (err) {
      if (i === retries) throw err;
      console.warn(`[moth:db] database not ready (${(err as Error).message}); retry ${i}/${retries}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

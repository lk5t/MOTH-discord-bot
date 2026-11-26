import { sql } from "drizzle-orm";
import { getDb } from "./db/client.js";
import { serviceHeartbeats } from "./db/schema.js";

/** Periodic service heartbeat written to Postgres — shown on the dashboard System page. */
export function startHeartbeat(service: string, details: () => Record<string, unknown>, intervalMs = 15_000): () => void {
  const startedAt = new Date();
  const beat = async () => {
    try {
      const d = details();
      await getDb().insert(serviceHeartbeats).values({ service, status: "up", details: d, startedAt, beatAt: new Date() })
        .onConflictDoUpdate({ target: serviceHeartbeats.service, set: { status: "up", details: d, startedAt, beatAt: sql`now()` } });
    } catch { /* database temporarily unavailable — next beat retries */ }
  };
  void beat();
  const t = setInterval(beat, intervalMs);
  t.unref();
  return () => clearInterval(t);
}

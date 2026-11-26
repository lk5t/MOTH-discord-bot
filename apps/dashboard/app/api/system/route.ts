import { sql } from "drizzle-orm";
import { z } from "zod";
import { aiProviders, encryptSecret, getDb, getPool, guilds, serviceHeartbeats } from "@moth/core";
import { ApiError, body, checkOrigin, handleError, json } from "@/lib/api";
import { getSession } from "@/lib/session";
import { isPlatformOwner } from "@/lib/access";
import { bot } from "@/lib/bot";
import { eq, isNull } from "drizzle-orm";

export const dynamic = "force-dynamic";

async function owner(req: Request) {
  checkOrigin(req);
  const s = await getSession();
  if (!s) throw new ApiError(401, "Not signed in");
  if (!isPlatformOwner(s.userId)) throw new ApiError(403, "Only MOTH instance owners (MOTH_OWNER_IDS) can view the System page");
  return s;
}

export async function GET(req: Request) {
  try {
    await owner(req);
    const db = getDb();
    const t0 = Date.now();
    const [beats, botHealth, [dbInfo], [counts], tables, providers] = await Promise.all([
      db.select().from(serviceHeartbeats),
      bot("/health").catch((e: Error) => ({ status: "down", error: e.message })),
      getPool().query("select version() as version, pg_database_size(current_database()) as size, (select count(*) from pg_stat_activity where datname = current_database()) as connections").then((r) => r.rows),
      db.select({ total: sql<number>`count(*)`, active: sql<number>`count(*) filter (where active)` }).from(guilds),
      getPool().query("select relname as table, n_live_tup as rows, pg_total_relation_size(relid) as bytes from pg_stat_user_tables order by pg_total_relation_size(relid) desc limit 15").then((r) => r.rows),
      db.select().from(aiProviders).where(isNull(aiProviders.guildId)),
    ]);
    return json({
      dashboard: { status: "up", uptimeSeconds: Math.round(process.uptime()), memoryMb: Math.round(process.memoryUsage().rss / 1048576), node: process.version, version: process.env.MOTH_VERSION ?? "dev" },
      bot: botHealth, heartbeats: beats, database: { latencyMs: Date.now() - t0, ...dbInfo, tables }, guilds: counts,
      providers: providers.map((p) => ({ ...p, apiKeyEnc: undefined, hasKey: !!p.apiKeyEnc })),
    });
  } catch (err) { return handleError(err); }
}

/** Instance-wide default AI provider (used by guilds without their own). */
export async function POST(req: Request) {
  try {
    await owner(req);
    const b = await body(req, z.object({ action: z.enum(["provider.upsert", "provider.delete"]), id: z.string().uuid().optional(), name: z.string().max(60).optional(), kind: z.enum(["openai", "anthropic", "ollama", "openai-compatible"]).optional(), baseUrl: z.string().url().nullable().optional(), model: z.string().max(120).optional(), apiKey: z.string().max(400).optional() }));
    const db = getDb();
    if (b.action === "provider.delete" && b.id) { await db.delete(aiProviders).where(eq(aiProviders.id, b.id)); return json({ ok: true }); }
    if (!b.kind || !b.model) throw new ApiError(400, "kind and model are required");
    await db.update(aiProviders).set({ isDefault: false }).where(isNull(aiProviders.guildId));
    const values = { guildId: null, name: b.name ?? "Instance default", kind: b.kind, baseUrl: b.baseUrl ?? null, model: b.model, isDefault: true, ...(b.apiKey ? { apiKeyEnc: encryptSecret(b.apiKey) } : {}) };
    if (b.id) await db.update(aiProviders).set(values).where(eq(aiProviders.id, b.id));
    else await db.insert(aiProviders).values(values);
    return json({ ok: true });
  } catch (err) { return handleError(err); }
}

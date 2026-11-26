import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { aiProviders, aiUsage } from "../db/schema.js";
import { decryptSecret } from "../crypto.js";
import { AIClient, type AIProviderKind } from "./provider.js";

/**
 * Resolves the AI client for a guild: guild-selected provider → guild default →
 * instance-wide default (DB) → environment variables. Returns null if none.
 */
export async function resolveAIClient(guildId: string | null, providerId?: string | null): Promise<AIClient | null> {
  const db = getDb();
  let row: typeof aiProviders.$inferSelect | undefined;
  if (providerId) {
    [row] = await db.select().from(aiProviders).where(eq(aiProviders.id, providerId)).limit(1);
    if (row && row.guildId && row.guildId !== guildId) row = undefined; // never cross guild boundaries
  }
  if (!row && guildId) [row] = await db.select().from(aiProviders).where(and(eq(aiProviders.guildId, guildId), eq(aiProviders.isDefault, true))).limit(1);
  if (!row) [row] = await db.select().from(aiProviders).where(and(isNull(aiProviders.guildId), eq(aiProviders.isDefault, true))).limit(1);
  if (row) {
    return new AIClient({
      kind: row.kind, model: row.model, baseUrl: row.baseUrl, temperature: row.temperature,
      apiKey: row.apiKeyEnc ? decryptSecret(row.apiKeyEnc) : null,
    });
  }
  const kind = process.env.AI_PROVIDER as AIProviderKind | "none" | undefined;
  if (kind && kind !== "none" && process.env.AI_MODEL) {
    return new AIClient({ kind, model: process.env.AI_MODEL, baseUrl: process.env.AI_BASE_URL, apiKey: process.env.AI_API_KEY });
  }
  return null;
}

export async function recordAIUsage(entry: { guildId: string | null; userId?: string | null; feature: string; providerKind?: string; inputTokens: number; outputTokens: number }) {
  await getDb().insert(aiUsage).values({ ...entry, userId: entry.userId ?? null }).catch(() => undefined);
}

export async function aiRequestsToday(guildId: string, userId: string): Promise<number> {
  const since = new Date(); since.setUTCHours(0, 0, 0, 0);
  const [{ n }] = await getDb().select({ n: sql<number>`count(*)` }).from(aiUsage).where(and(eq(aiUsage.guildId, guildId), eq(aiUsage.userId, userId), gte(aiUsage.createdAt, since)));
  return Number(n);
}

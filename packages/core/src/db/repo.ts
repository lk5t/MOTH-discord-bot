import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "./client.js";
import { changeLog, guildSettings, guilds, modCases } from "./schema.js";
import { guildConfigSchema, parseGuildConfig, type GuildConfig, type GuildConfigSection } from "../guild-config.js";
import { publishEvent } from "../events.js";
import { deepMerge } from "../util.js";

/** In-process config cache, invalidated by `config.updated` events. */
const configCache = new Map<string, { config: GuildConfig; version: number; at: number }>();
const CACHE_TTL = 60_000;

export function invalidateGuildConfig(guildId: string): void {
  configCache.delete(guildId);
}

export async function ensureGuild(g: { id: string; name: string; icon?: string | null; ownerId: string; memberCount?: number }): Promise<void> {
  const db = getDb();
  await db.insert(guilds).values({
    id: g.id, name: g.name, icon: g.icon ?? null, ownerId: g.ownerId, memberCount: g.memberCount ?? 0, active: true,
  }).onConflictDoUpdate({
    target: guilds.id,
    set: { name: g.name, icon: g.icon ?? null, ownerId: g.ownerId, memberCount: g.memberCount ?? 0, active: true, leftAt: null, updatedAt: new Date() },
  });
  await db.insert(guildSettings).values({ guildId: g.id, config: {} }).onConflictDoNothing();
}

export async function getGuildConfig(guildId: string): Promise<GuildConfig> {
  const hit = configCache.get(guildId);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.config;
  const [row] = await getDb().select().from(guildSettings).where(eq(guildSettings.guildId, guildId)).limit(1);
  const config = parseGuildConfig(row?.config ?? {});
  configCache.set(guildId, { config, version: row?.version ?? 0, at: Date.now() });
  return config;
}

export async function getGuildConfigWithVersion(guildId: string): Promise<{ config: GuildConfig; version: number }> {
  const [row] = await getDb().select().from(guildSettings).where(eq(guildSettings.guildId, guildId)).limit(1);
  return { config: parseGuildConfig(row?.config ?? {}), version: row?.version ?? 0 };
}

export class ConfigConflictError extends Error {
  constructor() { super("Configuration was modified by someone else. Reload and try again."); }
}

/**
 * Applies a deep-merge patch to one or more config sections. Validates the
 * resulting config, records an audit entry and broadcasts `config.updated`.
 * Pass `expectedVersion` for optimistic concurrency (dashboard edits).
 */
export async function updateGuildConfig(
  guildId: string,
  patch: Partial<{ [K in GuildConfigSection]: unknown }>,
  opts: { actorId?: string | null; source: "discord" | "dashboard" | "ai" | "system" | "architect"; expectedVersion?: number; replaceSections?: boolean },
): Promise<{ config: GuildConfig; version: number }> {
  const db = getDb();
  const result = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(guildSettings).where(eq(guildSettings.guildId, guildId)).for("update").limit(1);
    if (!row) throw new Error(`Guild ${guildId} is not registered`);
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== row.version) throw new ConfigConflictError();
    const before = parseGuildConfig(row.config);
    const merged: Record<string, unknown> = { ...before };
    for (const [section, value] of Object.entries(patch)) {
      merged[section] = opts.replaceSections ? value : deepMerge((before as Record<string, unknown>)[section], value);
    }
    const config = guildConfigSchema.parse(merged);
    const version = row.version + 1;
    await tx.update(guildSettings).set({ config, version, updatedBy: opts.actorId ?? null, updatedAt: new Date() }).where(eq(guildSettings.guildId, guildId));
    const changedSections = Object.keys(patch);
    await tx.insert(changeLog).values({
      guildId, actorId: opts.actorId ?? null, source: opts.source, action: "config.update", target: changedSections.join(","),
      before: Object.fromEntries(changedSections.map((s) => [s, (before as Record<string, unknown>)[s]])),
      after: Object.fromEntries(changedSections.map((s) => [s, (config as Record<string, unknown>)[s]])),
    });
    return { config, version, sections: changedSections };
  });
  configCache.set(guildId, { config: result.config, version: result.version, at: Date.now() });
  await publishEvent("config.updated", guildId, { sections: result.sections, version: result.version }, opts.source);
  return { config: result.config, version: result.version };
}

export async function logChange(entry: typeof changeLog.$inferInsert): Promise<void> {
  await getDb().insert(changeLog).values(entry);
}

/** Creates a moderation case with an atomically allocated per-guild case number. */
export async function createCase(input: Omit<typeof modCases.$inferInsert, "caseNumber" | "id">): Promise<typeof modCases.$inferSelect> {
  const db = getDb();
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"case:" + input.guildId}))`);
    const [{ next }] = await tx.select({ next: sql<number>`coalesce(max(${modCases.caseNumber}), 0) + 1` }).from(modCases).where(eq(modCases.guildId, input.guildId));
    const [created] = await tx.insert(modCases).values({ ...input, caseNumber: Number(next) }).returning();
    return created;
  });
  await publishEvent("case.created", input.guildId, { caseNumber: row.caseNumber, type: row.type, targetId: row.targetId, automated: row.automated });
  return row;
}

/** Active, non-expired warnings for escalation decisions. */
export async function countActiveWarnings(guildId: string, userId: string, expiryDays: number): Promise<number> {
  const since = expiryDays > 0 ? new Date(Date.now() - expiryDays * 86_400_000) : new Date(0);
  const [{ n }] = await getDb().select({ n: sql<number>`count(*)` }).from(modCases).where(and(
    eq(modCases.guildId, guildId), eq(modCases.targetId, userId), eq(modCases.active, true),
    sql`${modCases.type} in ('warn','automod')`, sql`${modCases.createdAt} >= ${since}`,
  ));
  return Number(n);
}

export async function userHistory(guildId: string, userId: string, limit = 25) {
  return getDb().select().from(modCases).where(and(eq(modCases.guildId, guildId), eq(modCases.targetId, userId))).orderBy(desc(modCases.createdAt)).limit(limit);
}

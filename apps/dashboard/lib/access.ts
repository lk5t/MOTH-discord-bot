import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { dashboardAccess, getDb, getGuildConfig, guilds, ownerIds } from "@moth/core";
import { userGuilds, type Session } from "./session";
import { bot } from "./bot";

export type Level = "none" | "viewer" | "moderator" | "admin" | "owner";
export const LEVEL_RANK: Record<Level, number> = { none: 0, viewer: 1, moderator: 2, admin: 3, owner: 4 };
export const atLeast = (l: Level, req: Level) => LEVEL_RANK[l] >= LEVEL_RANK[req];

const ADMINISTRATOR = 1n << 3n, MANAGE_GUILD = 1n << 5n;
const cache = new Map<string, { level: Level; at: number }>();

export function isPlatformOwner(userId: string): boolean {
  return ownerIds({ MOTH_OWNER_IDS: process.env.MOTH_OWNER_IDS ?? "" }).has(userId);
}

/** Resolves a dashboard user's access level for a guild (cached 60s). */
export async function guildAccess(s: Session, guildId: string): Promise<Level> {
  const key = `${s.id}:${guildId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.level;
  const level = await compute(s, guildId);
  cache.set(key, { level, at: Date.now() });
  return level;
}

async function compute(s: Session, guildId: string): Promise<Level> {
  const db = getDb();
  const [g] = await db.select().from(guilds).where(eq(guilds.id, guildId));
  if (!g || !g.active) return "none";
  if (isPlatformOwner(s.userId) || g.ownerId === s.userId) return "owner";
  const ug = (await userGuilds(s)).find((x) => x.id === guildId);
  if (ug) {
    const p = BigInt(ug.permissions);
    if (ug.owner) return "owner";
    if ((p & ADMINISTRATOR) || (p & MANAGE_GUILD)) return "admin";
  }
  // Explicit grants by user
  const grants = await db.select().from(dashboardAccess).where(and(eq(dashboardAccess.guildId, guildId), eq(dashboardAccess.subjectType, "user"), eq(dashboardAccess.subjectId, s.userId)));
  let best: Level = grants.reduce<Level>((b, x) => (LEVEL_RANK[x.level] > LEVEL_RANK[b] ? x.level : b), "none");
  if (!ug) return best;
  // Role-based grants (needs live member roles from the bot)
  try {
    const m = await bot<{ inGuild: boolean; roles: string[]; moderator: boolean }>(`/guilds/${guildId}/access/${s.userId}`);
    if (!m.inGuild) return best;
    const cfg = await getGuildConfig(guildId);
    const has = (ids: string[]) => ids.some((r) => m.roles.includes(r));
    if (m.roles.length) {
      const roleGrants = await db.select().from(dashboardAccess).where(and(eq(dashboardAccess.guildId, guildId), eq(dashboardAccess.subjectType, "role"), inArray(dashboardAccess.subjectId, m.roles)));
      for (const r of roleGrants) if (LEVEL_RANK[r.level] > LEVEL_RANK[best]) best = r.level;
    }
    if (has(cfg.moderation.adminRoleIds) && LEVEL_RANK[best] < 3) best = "admin";
    if ((m.moderator || has(cfg.moderation.moderatorRoleIds) || has(cfg.dashboard.moderatorRoleIds)) && LEVEL_RANK[best] < 2) best = "moderator";
    if (has(cfg.dashboard.viewerRoleIds) && LEVEL_RANK[best] < 1) best = "viewer";
  } catch { /* bot offline — fall back to explicit user grants */ }
  return best;
}

export function invalidateAccess(guildId: string) {
  for (const k of cache.keys()) if (k.endsWith(`:${guildId}`)) cache.delete(k);
}

/** Section → minimum level. Drives navigation and API checks. */
export const SECTIONS = [
  { key: "overview", label: "Overview", level: "viewer" },
  { key: "setup", label: "Quick Setup", level: "admin" },
  { key: "tools", label: "Server Tools", level: "admin" },
  { key: "architect", label: "Architect", level: "admin" },
  { key: "moderation", label: "Moderation", level: "moderator" },
  { key: "security", label: "Security", level: "moderator" },
  { key: "tickets", label: "Tickets", level: "moderator" },
  { key: "automation", label: "Automation", level: "admin" },
  { key: "commands", label: "Commands", level: "admin" },
  { key: "members", label: "Members", level: "moderator" },
  { key: "analytics", label: "Analytics", level: "viewer" },
  { key: "ai", label: "AI Settings", level: "admin" },
  { key: "settings", label: "Server Settings", level: "admin" },
  { key: "system", label: "System", level: "owner" },
] as const satisfies readonly { key: string; label: string; level: Level }[];

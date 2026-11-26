import type { Guild } from "discord.js";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  automations, configBackups, customCommands, getDb, getGuildConfigWithVersion, roleMenus, ticketPanels, updateGuildConfig, logChange, type GuildSnapshot,
} from "@moth/core";
import { captureSnapshot } from "../lib/snapshot.js";

export interface BackupPayload {
  version: 1;
  discord: GuildSnapshot;
  moth: { config: unknown; automations: unknown[]; customCommands: unknown[]; ticketPanels: unknown[]; roleMenus: unknown[] };
}

/** Captures Discord structure + all MOTH configuration for a guild. */
export async function createBackup(guild: Guild, label: string, kind: "manual" | "auto" | "pre-architect" | "pre-restore", createdBy?: string | null): Promise<string> {
  const db = getDb();
  const [snapshot, { config }, autos, cmds, panels, menus] = await Promise.all([
    captureSnapshot(guild), getGuildConfigWithVersion(guild.id),
    db.select().from(automations).where(eq(automations.guildId, guild.id)),
    db.select().from(customCommands).where(eq(customCommands.guildId, guild.id)),
    db.select().from(ticketPanels).where(eq(ticketPanels.guildId, guild.id)),
    db.select().from(roleMenus).where(eq(roleMenus.guildId, guild.id)),
  ]);
  const payload: BackupPayload = { version: 1, discord: snapshot, moth: { config, automations: autos, customCommands: cmds, ticketPanels: panels, roleMenus: menus } };
  const json = JSON.stringify(payload);
  const [row] = await db.insert(configBackups).values({ guildId: guild.id, label, kind, snapshot: payload, sizeBytes: Buffer.byteLength(json), createdBy: createdBy ?? null }).returning({ id: configBackups.id });
  await logChange({ guildId: guild.id, actorId: createdBy ?? null, source: kind === "manual" ? "discord" : "system", action: "backup.create", target: row.id, after: { label, kind } });
  return row.id;
}

/** Keeps only the newest N automatic backups. */
export async function pruneBackups(guildId: string, keep: number): Promise<void> {
  const db = getDb();
  const rows = await db.select({ id: configBackups.id }).from(configBackups).where(and(eq(configBackups.guildId, guildId), eq(configBackups.kind, "auto"))).orderBy(asc(configBackups.createdAt));
  const excess = rows.length - keep;
  if (excess > 0) for (const r of rows.slice(0, excess)) await db.delete(configBackups).where(eq(configBackups.id, r.id));
}

/**
 * Restores MOTH configuration from a backup (settings, automations, commands,
 * ticket panels, role menus). Discord structure is restored via the Architect
 * restore path, which previews changes first.
 */
export async function restoreMothConfig(guild: Guild, backupId: string, actorId: string | null): Promise<void> {
  const db = getDb();
  const [b] = await db.select().from(configBackups).where(and(eq(configBackups.id, backupId), eq(configBackups.guildId, guild.id)));
  if (!b) throw new Error("Backup not found");
  await createBackup(guild, `Before restoring "${b.label}"`, "pre-restore", actorId);
  const p = b.snapshot as BackupPayload;
  await updateGuildConfig(guild.id, p.moth.config as Record<string, unknown>, { actorId, source: "system", replaceSections: true });
  await db.transaction(async (tx) => {
    const strip = <T extends Record<string, unknown>>(r: T) => { const { createdAt, updatedAt, ...rest } = r as Record<string, unknown>; void createdAt; void updatedAt; return rest; };
    await tx.delete(automations).where(eq(automations.guildId, guild.id));
    for (const a of p.moth.automations as Record<string, unknown>[]) await tx.insert(automations).values(strip(a) as never);
    await tx.delete(customCommands).where(eq(customCommands.guildId, guild.id));
    for (const c of p.moth.customCommands as Record<string, unknown>[]) await tx.insert(customCommands).values(strip(c) as never);
    await tx.delete(roleMenus).where(eq(roleMenus.guildId, guild.id));
    for (const m of p.moth.roleMenus as Record<string, unknown>[]) await tx.insert(roleMenus).values(strip(m) as never);
    await tx.execute(sql`update ${ticketPanels} set enabled = false where guild_id = ${guild.id}`);
    for (const t of p.moth.ticketPanels as Record<string, unknown>[]) {
      await tx.insert(ticketPanels).values(strip(t) as never).onConflictDoUpdate({ target: ticketPanels.id, set: { ...(strip(t) as object), enabled: true } as never });
    }
  });
  await logChange({ guildId: guild.id, actorId, source: "system", action: "backup.restore", target: backupId });
}

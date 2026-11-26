import { AuditLogEvent, ChannelType, GuildVerificationLevel, PermissionFlagsBits, type Guild, type GuildMember, type GuildBasedChannel } from "discord.js";
import { eq } from "drizzle-orm";
import { getDb, getGuildConfig, guildState, publishEvent, securityEvents, securityThresholds, type GuildConfig } from "@moth/core";
import { brandEmbed, BRAND } from "../lib/embeds.js";
import { sendLog } from "../lib/logs.js";
import { log } from "../context.js";
import { executeModAction } from "./moderation.js";

/**
 * Anti-raid & security engine.
 *  - Join-spike detection over a sliding window
 *  - Suspicious-account scoring with explainable signals
 *  - Raid mode (auto lockdown / kick / ban of new joiners) with automatic recovery
 *  - Emergency lockdown with exact permission restoration (persisted across restarts)
 *  - Anti-nuke: detects mass channel/role deletion and mass bans by a single actor
 */

const joins = new Map<string, number[]>();
const nukeActions = new Map<string, number[]>(); // guild:actor:kind -> timestamps

type Severity = "info" | "low" | "medium" | "high" | "critical";
async function record(guild: Guild, type: string, severity: Severity, summary: string, details: Record<string, unknown> = {}, actionTaken?: string, userId?: string) {
  await getDb().insert(securityEvents).values({ guildId: guild.id, type, severity, summary, details, actionTaken, userId }).catch(() => undefined);
  await publishEvent("security.event", guild.id, { type, severity, summary }).catch(() => undefined);
}

export interface SuspicionReport { score: number; signals: { signal: string; weight: number }[] }

/** Scores how likely an account is a throwaway/raid account (0–100). */
export function scoreAccount(member: GuildMember, cfg: GuildConfig["security"]): SuspicionReport {
  const u = member.user;
  const signals: { signal: string; weight: number }[] = [];
  const ageDays = (Date.now() - u.createdTimestamp) / 86_400_000;
  if (ageDays < 1) signals.push({ signal: "account created less than 24h ago", weight: 45 });
  else if (ageDays < cfg.minAccountAgeDays) signals.push({ signal: `account younger than ${cfg.minAccountAgeDays} days`, weight: 30 });
  else if (ageDays < 30) signals.push({ signal: "account younger than 30 days", weight: 10 });
  if (!u.avatar) signals.push({ signal: "default avatar", weight: 15 });
  if (looksGenerated(u.username)) signals.push({ signal: "auto-generated looking username", weight: 15 });
  if (/(discord\.gg|nitro|free|gift|steam|airdrop)/i.test(u.username + (u.globalName ?? ""))) signals.push({ signal: "scam-associated keywords in name", weight: 25 });
  if (u.flags?.has("Spammer")) signals.push({ signal: "flagged by Discord as a likely spammer", weight: 60 });
  const recentJoins = joins.get(member.guild.id)?.length ?? 0;
  if (recentJoins > 5) signals.push({ signal: `joined during a burst of ${recentJoins} joins`, weight: 10 });
  return { score: Math.min(100, signals.reduce((n, s) => n + s.weight, 0)), signals };
}

function looksGenerated(name: string): boolean {
  if (/^[a-z]+[._]?\d{4,}$/i.test(name)) return true; // word + long number
  const letters = name.replace(/[^a-z]/gi, "");
  const vowels = letters.replace(/[^aeiou]/gi, "").length;
  return name.length >= 10 && /\d/.test(name) && letters.length > 5 && vowels / letters.length < 0.15; // random consonant soup
}

export async function onMemberJoin(member: GuildMember): Promise<void> {
  const cfg = await getGuildConfig(member.guild.id);
  if (!cfg.security.enabled || member.user.bot) return;
  const guild = member.guild;
  const t = securityThresholds(cfg.security);
  const now = Date.now();
  const list = (joins.get(guild.id) ?? []).filter((x) => now - x < t.perSeconds * 1000);
  list.push(now); joins.set(guild.id, list);

  const [state] = await getDb().select().from(guildState).where(eq(guildState.guildId, guild.id));
  if (!state?.raidMode && list.length >= t.joins) {
    await enableRaidMode(guild, cfg, `Join spike: ${list.length} joins in ${t.perSeconds}s (threshold ${t.joins}).`, { joins: list.length, seconds: t.perSeconds, threshold: t.joins });
  }
  const inRaid = state?.raidMode || list.length >= t.joins;

  if (member.roles.cache.some((r) => cfg.security.trustedRoleIds.includes(r.id))) return;
  const report = scoreAccount(member, cfg.security);
  const suspicious = report.score >= t.suspicionScore;
  const explanation = { summary: `Suspicion score ${report.score}/100 (threshold ${t.suspicionScore}): ${report.signals.map((s) => s.signal).join("; ") || "no signals"}.`, ...report, threshold: t.suspicionScore, raidMode: inRaid };

  if (inRaid && (cfg.security.raidAction === "kick-new" || cfg.security.raidAction === "ban-new")) {
    const type = cfg.security.raidAction === "ban-new" ? "ban" : "kick";
    await executeModAction({ guild, target: member, moderator: guild.client.user, type, automated: true, reason: "Raid protection: joined during active raid", explanation }).catch(() => undefined);
    await record(guild, "raid_member_removed", "medium", `${member.user.username} was ${type}ed during raid mode.`, explanation, type, member.id);
    return;
  }
  if (suspicious) {
    let action = cfg.security.suspiciousAction;
    if (inRaid && action === "flag") action = "timeout";
    if (action === "timeout" || action === "kick" || action === "ban") {
      await executeModAction({ guild, target: member, moderator: guild.client.user, type: action, durationMs: action === "timeout" ? 3_600_000 : null, automated: true, reason: "Suspicious account", explanation }).catch(() => undefined);
    }
    await sendLog(guild, "security", brandEmbed("⚠️ Suspicious account joined", `<@${member.id}> \`${member.user.username}\`\n**Score:** ${report.score}/100\n**Signals:**\n${report.signals.map((s) => `• ${s.signal} (+${s.weight})`).join("\n")}\n**Action:** ${action}`, BRAND.warning).setThumbnail(member.user.displayAvatarURL()));
    await record(guild, "suspicious_account", report.score >= 80 ? "high" : "medium", `${member.user.username} scored ${report.score}/100.`, explanation, action, member.id);
  }
}

export async function enableRaidMode(guild: Guild, cfg: GuildConfig, reason: string, details: Record<string, unknown> = {}): Promise<void> {
  const until = new Date(Date.now() + cfg.security.raidModeMinutes * 60_000);
  await getDb().insert(guildState).values({ guildId: guild.id, raidMode: true, raidModeUntil: until }).onConflictDoUpdate({ target: guildState.guildId, set: { raidMode: true, raidModeUntil: until, updatedAt: new Date() } });
  let action = "alert";
  if (cfg.security.raidAction === "lockdown") { await setLockdown(guild, true, "Raid protection", cfg); action = "lockdown"; }
  else if (cfg.security.raiseVerificationOnRaid) await raiseVerification(guild);
  const ping = cfg.security.alertRoleIds.map((r) => `<@&${r}>`).join(" ");
  await sendLog(guild, "security", brandEmbed("🚨 RAID MODE ENABLED", `${reason}\n\n**Response:** ${cfg.security.raidAction}\n**Auto-recovery:** ${cfg.security.autoRecover ? `<t:${Math.floor(until.getTime() / 1000)}:R>` : "manual"}\n\nUse \`/lockdown off\` or the dashboard to end it early.`, BRAND.danger), ping || undefined);
  await record(guild, "raid_mode_on", "critical", reason, details, action);
  log.warn({ guild: guild.id, reason }, "raid mode enabled");
}

export async function disableRaidMode(guild: Guild, reason = "Automatic recovery"): Promise<void> {
  const [state] = await getDb().select().from(guildState).where(eq(guildState.guildId, guild.id));
  if (!state?.raidMode && !state?.lockdown) return;
  if (state.lockdown) await setLockdown(guild, false, reason);
  await getDb().update(guildState).set({ raidMode: false, raidModeUntil: null, updatedAt: new Date() }).where(eq(guildState.guildId, guild.id));
  await sendLog(guild, "security", brandEmbed("✅ Raid mode ended", `${reason}. Permissions and verification level have been restored.`, BRAND.success));
  await record(guild, "raid_mode_off", "info", reason, {}, "restore");
}

async function raiseVerification(guild: Guild): Promise<number | null> {
  const prev = guild.verificationLevel;
  if (prev >= GuildVerificationLevel.High) return null;
  await guild.setVerificationLevel(GuildVerificationLevel.High, "MOTH raid protection").catch(() => undefined);
  return prev;
}

const LOCK_PERMS = PermissionFlagsBits.SendMessages | PermissionFlagsBits.AddReactions | PermissionFlagsBits.CreatePublicThreads | PermissionFlagsBits.CreatePrivateThreads | PermissionFlagsBits.SendMessagesInThreads | PermissionFlagsBits.Connect;

/**
 * Locks or unlocks the server. The exact prior @everyone overwrite for each
 * channel and the previous verification level are persisted so unlock
 * restores the server precisely, even after a bot restart.
 */
export async function setLockdown(guild: Guild, enable: boolean, reason: string, cfg?: GuildConfig): Promise<{ channels: number }> {
  const config = cfg ?? await getGuildConfig(guild.id);
  const db = getDb();
  const [state] = await db.select().from(guildState).where(eq(guildState.guildId, guild.id));
  const everyone = guild.roles.everyone.id;
  if (enable) {
    if (state?.lockdown) return { channels: 0 };
    await guild.channels.fetch();
    const targets = guild.channels.cache.filter((c): c is Extract<GuildBasedChannel, { permissionOverwrites: unknown }> =>
      "permissionOverwrites" in c && [ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildStageVoice].includes(c.type)
      && (config.security.lockdownChannelIds.length === 0 || config.security.lockdownChannelIds.includes(c.id)));
    const saved: Record<string, { allow: string; deny: string } | null> = {};
    let count = 0;
    for (const ch of targets.values()) {
      const ow = ch.permissionOverwrites.cache.get(everyone);
      // Skip channels @everyone already can't view (staff areas etc).
      if (ow?.deny.has(PermissionFlagsBits.ViewChannel)) continue;
      saved[ch.id] = ow ? { allow: ow.allow.bitfield.toString(), deny: ow.deny.bitfield.toString() } : null;
      const deny = (ow?.deny.bitfield ?? 0n) | LOCK_PERMS;
      const allow = (ow?.allow.bitfield ?? 0n) & ~LOCK_PERMS;
      await ch.permissionOverwrites.edit(everyone, {}, { reason }).catch(() => undefined);
      await ch.permissionOverwrites.create(everyone, Object.fromEntries([...bitsToFlags(allow).map((f) => [f, true]), ...bitsToFlags(deny).map((f) => [f, false])]), { reason: `MOTH lockdown: ${reason}` }).then(() => count++).catch(() => undefined);
    }
    const prevVerification = config.security.raiseVerificationOnRaid ? await raiseVerification(guild) : null;
    await db.insert(guildState).values({ guildId: guild.id, lockdown: true, restoreData: { overwrites: saved, verificationLevel: prevVerification } })
      .onConflictDoUpdate({ target: guildState.guildId, set: { lockdown: true, restoreData: { overwrites: saved, verificationLevel: prevVerification }, updatedAt: new Date() } });
    await record(guild, "lockdown_on", "high", `Server locked down: ${reason}`, { channels: count }, "lockdown");
    return { channels: count };
  }
  if (!state?.lockdown) return { channels: 0 };
  const data = (state.restoreData ?? {}) as { overwrites?: Record<string, { allow: string; deny: string } | null>; verificationLevel?: number | null };
  let count = 0;
  for (const [id, prev] of Object.entries(data.overwrites ?? {})) {
    const ch = guild.channels.cache.get(id) ?? await guild.channels.fetch(id).catch(() => null);
    if (!ch || !("permissionOverwrites" in ch)) continue;
    try {
      if (prev === null) await ch.permissionOverwrites.delete(everyone, "MOTH lockdown lifted");
      else await ch.permissionOverwrites.set([...ch.permissionOverwrites.cache.filter((o) => o.id !== everyone).values(), { id: everyone, allow: BigInt(prev.allow), deny: BigInt(prev.deny) }], "MOTH lockdown lifted");
      count++;
    } catch { /* channel may have been removed */ }
  }
  if (data.verificationLevel !== null && data.verificationLevel !== undefined) await guild.setVerificationLevel(data.verificationLevel, "MOTH lockdown lifted").catch(() => undefined);
  await db.update(guildState).set({ lockdown: false, restoreData: null, updatedAt: new Date() }).where(eq(guildState.guildId, guild.id));
  await record(guild, "lockdown_off", "info", `Lockdown lifted: ${reason}`, { channels: count }, "restore");
  return { channels: count };
}

function bitsToFlags(bits: bigint): (keyof typeof PermissionFlagsBits)[] {
  return (Object.entries(PermissionFlagsBits) as [keyof typeof PermissionFlagsBits, bigint][]).filter(([, b]) => (bits & b) === b && b !== 0n).map(([k]) => k);
}

/** Called by the scheduler: ends expired raid modes. */
export async function recoverExpiredRaids(guilds: Map<string, Guild>): Promise<void> {
  const rows = await getDb().select().from(guildState).where(eq(guildState.raidMode, true));
  for (const r of rows) {
    if (!r.raidModeUntil || r.raidModeUntil.getTime() > Date.now()) continue;
    const guild = guilds.get(r.guildId); if (!guild) continue;
    const cfg = await getGuildConfig(guild.id);
    const recentJoins = (joins.get(guild.id) ?? []).filter((x) => Date.now() - x < 60_000).length;
    if (!cfg.security.autoRecover) continue;
    if (recentJoins >= securityThresholds(cfg.security).joins) {
      // Still under attack — extend.
      await getDb().update(guildState).set({ raidModeUntil: new Date(Date.now() + cfg.security.raidModeMinutes * 60_000) }).where(eq(guildState.guildId, guild.id));
      continue;
    }
    await disableRaidMode(guild, "Automatic recovery — join rate returned to normal");
  }
}

/** Anti-nuke: tracks destructive actions per executor using the audit log. */
export async function trackDestructive(guild: Guild, kind: "channel" | "role" | "ban", auditType: AuditLogEvent): Promise<void> {
  const cfg = await getGuildConfig(guild.id);
  if (!cfg.security.enabled || !cfg.security.antiNuke.enabled) return;
  const logs = await guild.fetchAuditLogs({ type: auditType, limit: 1 }).catch(() => null);
  const entry = logs?.entries.first();
  if (!entry?.executorId || Date.now() - entry.createdTimestamp > 10_000) return;
  const actor = entry.executorId;
  if (actor === guild.client.user.id || actor === guild.ownerId) return;
  const k = `${guild.id}:${actor}:${kind}`;
  const win = cfg.security.antiNuke.perSeconds * 1000;
  const list = (nukeActions.get(k) ?? []).filter((x) => Date.now() - x < win); list.push(Date.now()); nukeActions.set(k, list);
  const limit = kind === "channel" ? cfg.security.antiNuke.maxChannelDeletes : kind === "role" ? cfg.security.antiNuke.maxRoleDeletes : cfg.security.antiNuke.maxBans;
  if (list.length < limit) return;
  nukeActions.delete(k);
  const member = await guild.members.fetch(actor).catch(() => null);
  let action = "alert";
  if (member && member.manageable) {
    // Strip dangerous roles from the actor to stop the attack.
    const dangerous = member.roles.cache.filter((r) => r.editable && r.permissions.any([PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles, PermissionFlagsBits.BanMembers, PermissionFlagsBits.ManageGuild]));
    if (dangerous.size) { await member.roles.remove(dangerous, "MOTH anti-nuke").catch(() => undefined); action = `stripped ${dangerous.size} roles`; }
  }
  const summary = `<@${actor}> performed ${list.length} ${kind} ${kind === "ban" ? "bans" : "deletions"} within ${cfg.security.antiNuke.perSeconds}s (limit ${limit}).`;
  await sendLog(guild, "security", brandEmbed("🛑 Anti-nuke triggered", `${summary}\n**Action:** ${action}`, BRAND.danger), cfg.security.alertRoleIds.map((r) => `<@&${r}>`).join(" ") || undefined);
  await record(guild, "nuke_attempt", "critical", summary.replace(/<@|>/g, ""), { actor, kind, count: list.length }, action, actor);
}

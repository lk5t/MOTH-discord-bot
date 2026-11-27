import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, OverwriteType, PermissionFlagsBits,
  type Guild, type GuildChannel, type GuildMember, type PartialGuildMember, type TextChannel,
} from "discord.js";
import { and, eq, like, lt } from "drizzle-orm";
import {
  categoryRank, channelRank, featureState, idCmp, getDb, getGuildConfig, roleMenus, setupRecommendations, ticketPanels, updateGuildConfig, type GuildConfig,
} from "@moth/core";
import { applyLayout } from "../architect/executor.js";
import { gateUnverified } from "./setup.js";
import { publishPanel } from "./tickets.js";
import { publishRoleMenu } from "./roleMenus.js";
import { publishVerification } from "./welcome.js";
import { sendLog } from "../lib/logs.js";
import { brandEmbed, BRAND } from "../lib/embeds.js";
import { cid } from "../commands/types.js";
import { log, runtime } from "../context.js";
import { env } from "../env.js";

/**
 * Autopilot: hands-free upkeep. Runs a few seconds after the server's
 * structure changes, every 30 minutes, and on demand. Every step is
 * idempotent, so running it often is cheap and safe.
 */

/** Guilds where the Architect is currently applying a plan (Autopilot waits). */
export const architectBusy = new Set<string>();
const timers = new Map<string, NodeJS.Timeout>();
const running = new Set<string>();

export type AutopilotReport = { at: string; reason: string; actions: string[] };

const HIDE_PERMS = [PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ManageRoles, PermissionFlagsBits.BanMembers, PermissionFlagsBits.KickMembers, PermissionFlagsBits.ModerateMembers, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.MentionEveryone, PermissionFlagsBits.ManageWebhooks];

async function setState(guildId: string, key: string, value: unknown) {
  await getDb().insert(featureState).values({ guildId, key, value: value as never }).onConflictDoUpdate({ target: [featureState.guildId, featureState.key], set: { value: value as never, updatedAt: new Date() } });
}
async function getState<T>(guildId: string, key: string): Promise<T | null> {
  const [row] = await getDb().select().from(featureState).where(and(eq(featureState.guildId, guildId), eq(featureState.key, key)));
  return (row?.value as T) ?? null;
}
export const lastAutopilotRun = (guildId: string) => getState<AutopilotReport>(guildId, "autopilot:last");

/** Debounced run after structure changes (channels created/deleted, panels removed…). */
export function scheduleAutopilot(guild: Guild, reason: string, delayMs = 20_000) {
  clearTimeout(timers.get(guild.id));
  timers.set(guild.id, setTimeout(() => { timers.delete(guild.id); void runAutopilot(guild, reason); }, delayMs).unref());
}

export async function runAutopilot(guild: Guild, reason: string, force = false): Promise<AutopilotReport> {
  const report: AutopilotReport = { at: new Date().toISOString(), reason, actions: [] };
  const cfg = await getGuildConfig(guild.id);
  if ((!cfg.autopilot.enabled && !force) || running.has(guild.id)) return report;
  if (architectBusy.has(guild.id)) { scheduleAutopilot(guild, reason, 60_000); return report; }
  const me = guild.members.me;
  if (!me?.permissions.has([PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles])) return report;
  running.add(guild.id);
  try {
    await guild.channels.fetch();
    const a = cfg.autopilot;
    if (a.repair) await repair(guild, cfg, report.actions);
    const fresh = await getGuildConfig(guild.id);
    if (a.gateNewChannels && fresh.verification.enabled && fresh.verification.verifiedRoleId && fresh.verification.channelId
      && guild.roles.cache.has(fresh.verification.verifiedRoleId) && guild.channels.cache.has(fresh.verification.channelId)) {
      const n = await gateUnverified(guild, fresh.verification.verifiedRoleId, fresh.verification.channelId);
      if (n) report.actions.push(`Hid ${n} channel(s) from unverified members`);
    }
    if (a.organiseLayout && await organise(guild)) report.actions.push("Re-organised categories and channels (Start Here first)");
  } catch (err) {
    log.warn({ err, guild: guild.id }, "autopilot run failed");
    report.actions.push(`⚠️ ${(err as Error).message}`);
  } finally { running.delete(guild.id); }
  await setState(guild.id, "autopilot:last", report).catch(() => undefined);
  if (report.actions.length) {
    await sendLog(guild, "general", brandEmbed("🤖 Autopilot", report.actions.map((x) => `• ${x}`).join("\n"), BRAND.info).setFooter({ text: `Trigger: ${reason}` }));
  }
  return report;
}

/** Puts categories and channels in conventional order. Returns true when something moved. */
async function organise(guild: Guild): Promise<boolean> {
  const all = [...guild.channels.cache.values()].filter((c) => !c.isThread()) as GuildChannel[];
  const sortPos = (a: GuildChannel, b: GuildChannel) => a.rawPosition - b.rawPosition || idCmp(a.id, b.id);
  const stable = <T>(xs: T[], r: (x: T) => number) => xs.map((x, i) => ({ x, i, k: r(x) })).sort((p, q) => p.k - q.k || p.i - q.i).map((v) => v.x);
  const kind = (c: GuildChannel) => (c.type === ChannelType.GuildVoice ? "voice" : c.type === ChannelType.GuildStageVoice ? "stage" : "text");
  const cats = all.filter((c) => c.type === ChannelType.GuildCategory).sort(sortPos);
  const childrenOf = (id: string | null) => all.filter((c) => c.type !== ChannelType.GuildCategory && (c.parentId ?? null) === id).sort(sortPos);
  const wantCats = stable(cats, (c) => categoryRank(c.name, childrenOf(c.id).map((ch) => ({ name: ch.name, type: kind(ch) }))));
  let changed = wantCats.some((c, i) => c.id !== cats[i].id);
  const order: { id: string; parent: string | null }[] = [];
  for (const parent of [null, ...wantCats.map((c) => c.id)]) {
    if (parent) order.push({ id: parent, parent: null });
    const kids = childrenOf(parent);
    // Text and voice are separate lists in Discord, so compare each group on its own.
    for (const group of [kids.filter((k) => kind(k) === "text"), kids.filter((k) => kind(k) !== "text")]) {
      const want = stable(group, (c) => channelRank(c.name, kind(c)));
      if (want.some((c, i) => c.id !== group[i].id)) changed = true;
      order.push(...want.map((c) => ({ id: c.id, parent })));
    }
  }
  if (!changed) return false;
  await applyLayout(guild, order);
  return true;
}

const LOG_KEYS: { path: [keyof GuildConfig, string]; name: string }[] = [
  { path: ["general", "modLogChannelId"], name: "mod-log" }, { path: ["general", "logChannelId"], name: "server-log" },
  { path: ["general", "securityLogChannelId"], name: "security-log" }, { path: ["logging", "messageChannelId"], name: "message-log" },
  { path: ["logging", "memberChannelId"], name: "member-log" }, { path: ["logging", "serverChannelId"], name: "server-log" },
  { path: ["logging", "voiceChannelId"], name: "voice-log" }, { path: ["tickets", "transcriptChannelId"], name: "ticket-transcripts" },
];

async function repair(guild: Guild, cfg: GuildConfig, actions: string[]) {
  const has = (id: string | null | undefined) => !!id && guild.channels.cache.has(id);
  const patch: Record<string, Record<string, unknown>> = {};
  const set = (section: string, key: string, value: unknown) => { (patch[section] ??= {})[key] = value; };

  // 1. Deleted log channels are recreated (staff-only) and the config is pointed at them.
  const recreated = new Map<string, string>();
  for (const { path: [section, key], name } of LOG_KEYS) {
    const id = (cfg[section] as Record<string, string | null>)[key];
    if (!id || has(id)) continue;
    let newId = recreated.get(id);
    if (!newId) {
      const sibling = LOG_KEYS.map(({ path: [s, k] }) => (cfg[s] as Record<string, string | null>)[k]).find((x) => has(x));
      const parent = sibling ? guild.channels.cache.get(sibling)!.parentId : null;
      const staff = guild.roles.cache.filter((r) => !r.managed && r.id !== guild.id && r.permissions.any([PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ModerateMembers]));
      const ch = await guild.channels.create({
        name, type: ChannelType.GuildText, parent: parent ?? undefined, reason: "Autopilot: log channel was deleted",
        permissionOverwrites: [
          { id: guild.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
          { id: guild.client.user.id, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles] },
          ...staff.map((r) => ({ id: r.id, type: OverwriteType.Role, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] })),
        ],
      });
      newId = ch.id; recreated.set(id, newId);
      actions.push(`Recreated deleted log channel #${name}`);
    }
    set(section, key, newId);
  }

  // 2. Config entries that point at deleted channels are dropped.
  const live = <T extends { channelId: string }>(xs: T[]) => xs.filter((x) => has(x.channelId));
  for (const [section, list] of [["statsChannels", cfg.statsChannels], ["sticky", cfg.sticky], ["channelRules", cfg.channelRules]] as const) {
    const kept = live(list as { channelId: string }[]);
    if (kept.length !== list.length) { (patch as Record<string, unknown>)[section] = kept; actions.push(`Removed ${list.length - kept.length} ${section === "statsChannels" ? "stats channel" : section === "sticky" ? "sticky message" : "channel rule"}(s) for deleted channels`); }
  }
  if (cfg.tempVoice.hubChannelIds.some((id) => !has(id))) { set("tempVoice", "hubChannelIds", cfg.tempVoice.hubChannelIds.filter(has)); actions.push("Removed deleted voice hubs from Join-to-create"); }

  if (Object.keys(patch).length) await updateGuildConfig(guild.id, patch, { source: "system" });

  // 3. Panels whose message was deleted are posted again.
  const v = cfg.verification;
  if (v.enabled && has(v.channelId)) {
    const ch = guild.channels.cache.get(v.channelId!) as TextChannel;
    const recent = await ch.messages.fetch({ limit: 30 }).catch(() => null);
    const present = recent?.some((m) => m.author.id === guild.client.user.id && m.components.some((row) => "components" in row && (row.components as { customId?: string | null }[]).some((c) => c.customId?.startsWith("moth:verify:"))));
    if (recent && !present) { await publishVerification(guild).catch(() => undefined); actions.push("Re-posted the verification panel"); }
  }
  const missing = async (channelId: string | null, messageId: string | null) => {
    if (!channelId || !messageId || !has(channelId)) return false;
    const ch = guild.channels.cache.get(channelId);
    if (!ch?.isTextBased()) return false;
    try { await ch.messages.fetch(messageId); return false; } catch (err) { return (err as { code?: number }).code === 10008; }
  };
  for (const p of await getDb().select().from(ticketPanels).where(and(eq(ticketPanels.guildId, guild.id), eq(ticketPanels.enabled, true)))) {
    if (await missing(p.channelId, p.messageId)) { await publishPanel(guild, p.id).catch(() => undefined); actions.push(`Re-posted ticket panel “${p.name}”`); }
  }
  for (const m of await getDb().select().from(roleMenus).where(eq(roleMenus.guildId, guild.id))) {
    if (await missing(m.channelId, m.messageId)) { await publishRoleMenu(guild, m.id).catch(() => undefined); actions.push(`Re-posted role menu “${m.name}”`); }
  }
}

// ───────── Role restore ─────────
export async function rememberRoles(member: GuildMember | PartialGuildMember) {
  if (member.user.bot || !member.roles?.cache.size) return;
  const cfg = await getGuildConfig(member.guild.id);
  if (!cfg.autopilot.enabled || !cfg.autopilot.restoreRoles) return;
  const roles = member.roles.cache.filter((r) => r.id !== member.guild.id && !r.managed && !r.permissions.any(HIDE_PERMS)).map((r) => r.id);
  if (roles.length) await setState(member.guild.id, `roles:${member.id}`, { roles, at: Date.now() }).catch(() => undefined);
}

export async function restoreRoles(member: GuildMember) {
  const cfg = await getGuildConfig(member.guild.id);
  if (!cfg.autopilot.enabled || !cfg.autopilot.restoreRoles || member.user.bot) return;
  const saved = await getState<{ roles: string[]; at: number }>(member.guild.id, `roles:${member.id}`);
  if (!saved || Date.now() - saved.at > 30 * 86_400_000) return;
  const give = saved.roles.map((id) => member.guild.roles.cache.get(id)).filter((r) => r && r.editable && !r.permissions.any(HIDE_PERMS)).map((r) => r!.id);
  if (give.length) await member.roles.add(give, "Autopilot: restoring roles from before they left").catch(() => undefined);
  await getDb().delete(featureState).where(and(eq(featureState.guildId, member.guild.id), eq(featureState.key, `roles:${member.id}`))).catch(() => undefined);
}

// ───────── Dehoist ─────────
const HOIST = /^[^\p{L}\p{N}]+/u;
export async function dehoist(member: GuildMember) {
  const cfg = await getGuildConfig(member.guild.id);
  if (!cfg.autopilot.enabled || !cfg.autopilot.dehoist || member.user.bot || !member.manageable) return;
  const name = member.displayName;
  if (!HOIST.test(name)) return;
  const clean = name.replace(HOIST, "").trim() || member.user.username.replace(HOIST, "").trim() || "member";
  if (clean !== name) await member.setNickname(clean.slice(0, 32), "Autopilot: dehoist").catch(() => undefined);
}

// ───────── First join ─────────
export async function welcomeNewGuild(guild: Guild) {
  const cfg = await getGuildConfig(guild.id);
  if (!cfg.autopilot.setupPrompt) return;
  const recs = setupRecommendations(cfg);
  const target = guild.systemChannel?.permissionsFor(guild.members.me!)?.has(PermissionFlagsBits.SendMessages) ? guild.systemChannel
    : guild.channels.cache.find((c) => c.type === ChannelType.GuildText && !!c.permissionsFor(guild.members.me!)?.has(PermissionFlagsBits.SendMessages)) as TextChannel | undefined;
  if (!target) return;
  await target.send({
    embeds: [brandEmbed("🦋 Thanks for adding MOTH", `I can set this server up for you in one click — logs, protection, welcome, verification, tickets and more. I reuse what you already have and back up first.\n\n${recs.slice(0, 5).map((r) => `• ${r.title}`).join("\n")}\n\nAutopilot is on: I'll keep the layout organised, new channels locked behind verification, and panels and log channels repaired automatically.`)],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(cid("setup", "open")).setLabel("Set up this server").setEmoji("⚡").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Open dashboard").setURL(`${env.DASHBOARD_URL.replace(/\/$/, "")}/dashboard/${guild.id}`),
    )],
  }).catch(() => undefined);
}

/** Periodic pass + cleanup of old saved roles. */
export async function autopilotSweep() {
  for (const g of runtime.client?.guilds.cache.values() ?? []) await runAutopilot(g, "scheduled check").catch(() => undefined);
}
export async function pruneSavedRoles() {
  await getDb().delete(featureState).where(and(like(featureState.key, "roles:%"), lt(featureState.updatedAt, new Date(Date.now() - 30 * 86_400_000)))).catch(() => undefined);
}

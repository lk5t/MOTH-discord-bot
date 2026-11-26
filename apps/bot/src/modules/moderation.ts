import { type Guild, type GuildMember, type User, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { and, eq, lte, sql } from "drizzle-orm";
import { countActiveWarnings, createCase, formatDuration, getDb, getGuildConfig, modCases, scheduledJobs, type PunishmentAction } from "@moth/core";
import { brandEmbed, BRAND } from "../lib/embeds.js";
import { sendLog } from "../lib/logs.js";
import { log } from "../context.js";
import { cid } from "../commands/types.js";
import { analytics } from "./analytics.js";

export type ModActionType = "warn" | "timeout" | "untimeout" | "kick" | "ban" | "unban" | "softban" | "note";

export interface ModActionInput {
  guild: Guild;
  target: GuildMember | User;
  moderator: User;
  type: ModActionType;
  reason?: string | null;
  durationMs?: number | null;
  deleteMessageSeconds?: number;
  automated?: boolean;
  explanation?: Record<string, unknown>;
  /** Skip escalation (used when the action itself results from escalation). */
  noEscalate?: boolean;
}

const COLORS: Record<ModActionType, number> = { warn: BRAND.warning, timeout: 0xf97316, untimeout: BRAND.success, kick: 0xef4444, ban: BRAND.danger, unban: BRAND.success, softban: 0xef4444, note: BRAND.info };
const VERB: Record<ModActionType, string> = { warn: "warned", timeout: "timed out", untimeout: "had their timeout removed", kick: "kicked", ban: "banned", unban: "unbanned", softban: "softbanned", note: "noted" };

/**
 * Executes a moderation action end-to-end: DM, Discord action, case record,
 * mod-log, temp-ban scheduling and escalation. Used by commands, automod,
 * anti-raid and the dashboard so behaviour is identical everywhere.
 */
export async function executeModAction(input: ModActionInput): Promise<{ caseNumber: number; escalated?: string }> {
  const { guild, type, moderator } = input;
  const cfg = await getGuildConfig(guild.id);
  const user = "user" in input.target ? input.target.user : input.target;
  const member = "user" in input.target ? input.target : await guild.members.fetch(user.id).catch(() => null);
  const reason = input.reason?.trim() || "No reason provided";
  const auditReason = `${moderator.username}: ${reason}`.slice(0, 512);

  // DM before kicking/banning so the user can still receive it.
  if (cfg.moderation.dmOnAction && !["note", "unban"].includes(type) && !user.bot) {
    const dm = brandEmbed(`You were ${VERB[type]} in ${guild.name}`, `**Reason:** ${reason}${input.durationMs ? `\n**Duration:** ${formatDuration(input.durationMs)}` : ""}`, COLORS[type]);
    if (input.automated && input.explanation?.summary) dm.addFields({ name: "Why?", value: String(input.explanation.summary).slice(0, 1024) });
    const components = type === "ban" && cfg.moderation.appeals.enabled ? [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(cid("appeal", "open", guild.id)).setLabel("Appeal this ban").setStyle(ButtonStyle.Secondary))] : [];
    await user.send({ embeds: [dm], components }).catch(() => undefined);
  }

  switch (type) {
    case "timeout":
      if (!member) throw new Error("Member is not in the server");
      await member.timeout(Math.min(input.durationMs ?? 600_000, 28 * 86_400_000), auditReason);
      break;
    case "untimeout":
      if (!member) throw new Error("Member is not in the server");
      await member.timeout(null, auditReason);
      break;
    case "kick":
      if (!member) throw new Error("Member is not in the server");
      await member.kick(auditReason);
      break;
    case "ban":
      await guild.bans.create(user.id, { reason: auditReason, deleteMessageSeconds: input.deleteMessageSeconds ?? 0 });
      break;
    case "softban":
      await guild.bans.create(user.id, { reason: auditReason, deleteMessageSeconds: input.deleteMessageSeconds ?? 86_400 });
      await guild.bans.remove(user.id, "Softban release");
      break;
    case "unban":
      await guild.bans.remove(user.id, auditReason);
      break;
    case "warn": case "note":
      break;
  }

  const expiresAt = input.durationMs && (type === "timeout" || type === "ban") ? new Date(Date.now() + input.durationMs) : null;
  const row = await createCase({
    guildId: guild.id, type: input.automated && type === "warn" ? "automod" : type, targetId: user.id, targetTag: user.username,
    moderatorId: moderator.id, reason, durationMs: input.durationMs ?? null, expiresAt, automated: !!input.automated, explanation: input.explanation ?? null,
  });
  if (type === "ban" && expiresAt) {
    await getDb().insert(scheduledJobs).values({ guildId: guild.id, kind: "unban", runAt: expiresAt, payload: { userId: user.id, caseNumber: row.caseNumber } });
  }
  if (type === "unban") await getDb().update(modCases).set({ active: false }).where(and(eq(modCases.guildId, guild.id), eq(modCases.targetId, user.id), eq(modCases.type, "ban")));
  if (type === "untimeout") await getDb().update(modCases).set({ active: false }).where(and(eq(modCases.guildId, guild.id), eq(modCases.targetId, user.id), eq(modCases.type, "timeout")));

  const embed = brandEmbed(`Case #${row.caseNumber} · ${type.toUpperCase()}${input.automated ? " (auto)" : ""}`, undefined, COLORS[type])
    .addFields(
      { name: "User", value: `<@${user.id}> \`${user.username}\` (${user.id})`, inline: false },
      { name: "Moderator", value: input.automated ? "MOTH AutoMod" : `<@${moderator.id}>`, inline: true },
      ...(input.durationMs ? [{ name: "Duration", value: formatDuration(input.durationMs), inline: true }] : []),
      { name: "Reason", value: reason.slice(0, 1024) },
    ).setTimestamp();
  if (input.explanation?.summary) embed.addFields({ name: "Explanation", value: String(input.explanation.summary).slice(0, 1024) });
  const logId = await sendLog(guild, "mod", embed);
  if (logId) await getDb().update(modCases).set({ logMessageId: logId }).where(eq(modCases.id, row.id));
  analytics.command(guild.id);

  // Escalation: count active warnings and apply the highest matching rule.
  let escalated: string | undefined;
  if ((type === "warn") && !input.noEscalate && member) {
    const warnings = await countActiveWarnings(guild.id, user.id, cfg.moderation.warnExpiryDays);
    const rule = [...cfg.moderation.escalation].sort((a, b) => b.warnings - a.warnings).find((r) => warnings === r.warnings);
    if (rule) {
      escalated = rule.action;
      await executeModAction({
        guild, target: member, moderator: guild.client.user, type: rule.action, automated: true, noEscalate: true,
        durationMs: rule.durationMinutes ? rule.durationMinutes * 60_000 : rule.action === "timeout" ? 3_600_000 : null,
        reason: `Escalation: reached ${warnings} warnings`,
        explanation: { summary: `Automatic escalation — ${warnings} active warnings triggered the "${rule.action}" rule.`, rule, warnings },
      }).catch((err) => log.warn({ err, guild: guild.id }, "escalation failed"));
    }
  }
  return { caseNumber: row.caseNumber, escalated };
}

/** Maps an automod punishment to a moderation action. */
export async function applyPunishment(guild: Guild, member: GuildMember, action: PunishmentAction, reason: string, explanation: Record<string, unknown>, timeoutMinutes = 10) {
  if (action === "none" || action === "delete") return null;
  return executeModAction({
    guild, target: member, moderator: guild.client.user, type: action, reason, automated: true, explanation,
    durationMs: action === "timeout" ? timeoutMinutes * 60_000 : null,
  });
}

/** Processes expired temp-bans (scheduled jobs are handled by the scheduler; this is a fallback sweep). */
export async function expireTimeoutCases(): Promise<void> {
  await getDb().update(modCases).set({ active: false }).where(and(eq(modCases.type, "timeout"), eq(modCases.active, true), lte(modCases.expiresAt, sql`now()`)));
}

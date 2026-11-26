import type { GuildMember, Message } from "discord.js";
import { and, eq, sql } from "drizzle-orm";
import { getDb, getGuildConfig, levelFromXp, memberLevels, renderTemplate } from "@moth/core";
import { templateContext } from "../lib/embeds.js";
import { fireAutomations } from "./automation.js";
import { checkAchievements } from "./achievements.js";
import { log } from "../context.js";

/** Awards message XP with cooldown, multipliers, level-up announcements and role rewards. */
export async function handleMessageXp(message: Message<true>): Promise<void> {
  if (message.author.bot || !message.member) return;
  const cfg = await getGuildConfig(message.guildId);
  const lv = cfg.leveling;
  if (!lv.enabled) {
    await bumpMessages(message.guildId, message.author.id);
    return;
  }
  if (lv.noXpChannelIds.includes(message.channelId) || lv.noXpRoleIds.some((r) => message.member!.roles.cache.has(r))) return bumpMessages(message.guildId, message.author.id);
  const [row] = await getDb().select().from(memberLevels).where(and(eq(memberLevels.guildId, message.guildId), eq(memberLevels.userId, message.author.id)));
  if (row?.lastXpAt && Date.now() - row.lastXpAt.getTime() < lv.cooldownSeconds * 1000) return bumpMessages(message.guildId, message.author.id);
  const mult = Math.max(1, ...lv.multipliers.filter((m) => message.member!.roles.cache.has(m.roleId)).map((m) => m.multiplier));
  const amount = Math.round((lv.xpMin + Math.random() * Math.max(0, lv.xpMax - lv.xpMin)) * mult);
  await addXp(message.member, amount, message, true);
}

async function bumpMessages(guildId: string, userId: string) {
  await getDb().insert(memberLevels).values({ guildId, userId, messages: 1 })
    .onConflictDoUpdate({ target: [memberLevels.guildId, memberLevels.userId], set: { messages: sql`${memberLevels.messages} + 1` } });
}

export async function addXp(member: GuildMember, amount: number, message: Message<true> | null, countMessage = false): Promise<void> {
  const db = getDb();
  const [row] = await db.insert(memberLevels).values({ guildId: member.guild.id, userId: member.id, xp: Math.max(0, amount), messages: countMessage ? 1 : 0, lastXpAt: new Date() })
    .onConflictDoUpdate({
      target: [memberLevels.guildId, memberLevels.userId],
      set: { xp: sql`greatest(0, ${memberLevels.xp} + ${amount})`, messages: countMessage ? sql`${memberLevels.messages} + 1` : memberLevels.messages, lastXpAt: new Date(), updatedAt: new Date() },
    }).returning();
  const { level } = levelFromXp(row.xp);
  if (level === row.level) { if (countMessage) void checkAchievements(member, message?.channel ?? null); return; }
  await db.update(memberLevels).set({ level }).where(and(eq(memberLevels.guildId, member.guild.id), eq(memberLevels.userId, member.id)));
  if (level > row.level) await onLevelUp(member, level, message).catch((err) => log.warn({ err }, "level up handling failed"));
}

async function onLevelUp(member: GuildMember, level: number, message: Message<true> | null) {
  const cfg = await getGuildConfig(member.guild.id);
  const lv = cfg.leveling;
  // Role rewards
  const earned = lv.rewards.filter((r) => r.level <= level).sort((a, b) => a.level - b.level);
  if (earned.length) {
    const toAdd = lv.stackRewards ? earned.map((r) => r.roleId) : [earned[earned.length - 1].roleId];
    const toRemove = lv.stackRewards ? [] : earned.slice(0, -1).map((r) => r.roleId);
    await member.roles.add(toAdd.filter((r) => !member.roles.cache.has(r) && member.guild.roles.cache.has(r)), `Level ${level} reward`).catch(() => undefined);
    if (toRemove.length) await member.roles.remove(toRemove.filter((r) => member.roles.cache.has(r)), "Level reward replaced").catch(() => undefined);
  }
  const text = renderTemplate(lv.announceMessage, templateContext({ member, guild: member.guild, vars: { level } }));
  if (lv.announce === "same-channel" && message) await message.channel.send({ content: text, allowedMentions: { users: [member.id] } }).catch(() => undefined);
  else if (lv.announce === "channel" && lv.announceChannelId) {
    const ch = member.guild.channels.cache.get(lv.announceChannelId);
    if (ch?.isTextBased() && "send" in ch) await ch.send({ content: text, allowedMentions: { users: [member.id] } }).catch(() => undefined);
  } else if (lv.announce === "dm") await member.send(text).catch(() => undefined);
  void fireAutomations(member.guild, "level_up", { member, level, channel: message?.channel ?? null });
  void checkAchievements(member, message?.channel ?? null);
}

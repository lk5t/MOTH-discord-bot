import type { GuildMember, TextBasedChannel } from "discord.js";
import { and, eq, sql } from "drizzle-orm";
import { ACHIEVEMENTS, economyAccounts, getDb, getGuildConfig, giveaways, memberLevels, userAchievements } from "@moth/core";
import { brandEmbed } from "../lib/embeds.js";

const lastCheck = new Map<string, number>();

/** Evaluates achievements for a member (throttled) and announces new unlocks. */
export async function checkAchievements(member: GuildMember, channel: TextBasedChannel | null, force = false): Promise<string[]> {
  const cfg = await getGuildConfig(member.guild.id);
  if (!cfg.achievements.enabled) return [];
  const k = `${member.guild.id}:${member.id}`;
  if (!force && Date.now() - (lastCheck.get(k) ?? 0) < 60_000) return [];
  lastCheck.set(k, Date.now());
  const db = getDb();
  const [[lv], [eco], [{ won }], have] = await Promise.all([
    db.select().from(memberLevels).where(and(eq(memberLevels.guildId, member.guild.id), eq(memberLevels.userId, member.id))),
    db.select().from(economyAccounts).where(and(eq(economyAccounts.guildId, member.guild.id), eq(economyAccounts.userId, member.id))),
    db.select({ won: sql<number>`count(*)` }).from(giveaways).where(and(eq(giveaways.guildId, member.guild.id), sql`${giveaways.winnerIds} ? ${member.id}`)),
    db.select().from(userAchievements).where(and(eq(userAchievements.guildId, member.guild.id), eq(userAchievements.userId, member.id))),
  ]);
  const owned = new Set(have.map((h) => h.key));
  const stats = { messages: lv?.messages ?? 0, level: lv?.level ?? 0, voiceMinutes: lv?.voiceMinutes ?? 0, streak: eco?.streak ?? 0, balance: eco?.balance ?? 0, giveawaysWon: Number(won) };
  const unlocked = ACHIEVEMENTS.filter((a) => !owned.has(a.key) && !cfg.achievements.disabledKeys.includes(a.key) && a.check(stats));
  if (!unlocked.length) return [];
  await db.insert(userAchievements).values(unlocked.map((a) => ({ guildId: member.guild.id, userId: member.id, key: a.key }))).onConflictDoNothing();
  if (cfg.achievements.announce && channel && "send" in channel) {
    await channel.send({ content: `<@${member.id}>`, embeds: [brandEmbed("🏆 Achievement unlocked!", unlocked.map((a) => `${a.icon} **${a.name}** — ${a.description}`).join("\n"))], allowedMentions: { users: [member.id] } }).catch(() => undefined);
  }
  return unlocked.map((a) => a.key);
}

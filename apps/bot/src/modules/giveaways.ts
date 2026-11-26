import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type Guild, type TextBasedChannel } from "discord.js";
import { and, eq, lte } from "drizzle-orm";
import { getDb, giveaways, memberLevels } from "@moth/core";
import { brandEmbed, BRAND, ok, fail } from "../lib/embeds.js";
import { cid, type ComponentHandler } from "../commands/types.js";
import { respond } from "../lib/util.js";
import { runtime } from "../context.js";

type Giveaway = typeof giveaways.$inferSelect;

function giveawayEmbed(g: Giveaway) {
  const e = brandEmbed(`🎁 ${g.prize}`, `${g.description ? g.description + "\n\n" : ""}${g.ended ? `**Ended** <t:${Math.floor(g.endsAt.getTime() / 1000)}:R>` : `Ends <t:${Math.floor(g.endsAt.getTime() / 1000)}:R>`}\nHosted by <@${g.hostId}>\n**Winners:** ${g.winnerCount} · **Entries:** ${g.entrants.length}`);
  const req = [g.requiredRoleId ? `Role <@&${g.requiredRoleId}>` : "", g.minLevel ? `Level ${g.minLevel}+` : ""].filter(Boolean);
  if (req.length) e.addFields({ name: "Requirements", value: req.join(" · ") });
  if (g.ended) e.addFields({ name: "Winners", value: g.winnerIds.length ? g.winnerIds.map((w) => `<@${w}>`).join(", ") : "No valid entries" }).setColor(BRAND.info);
  return e;
}
const entryRow = (g: Giveaway) => new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(cid("gw", "enter", g.id)).setLabel(g.ended ? "Ended" : "Enter").setEmoji("🎉").setStyle(ButtonStyle.Primary).setDisabled(g.ended));

export async function startGiveaway(channel: TextBasedChannel & { send: Function }, input: { guildId: string; prize: string; description?: string; winners: number; durationMs: number; hostId: string; requiredRoleId?: string | null; minLevel?: number | null }) {
  const [g] = await getDb().insert(giveaways).values({ guildId: input.guildId, channelId: channel.id, prize: input.prize, description: input.description, winnerCount: input.winners, hostId: input.hostId, requiredRoleId: input.requiredRoleId ?? null, minLevel: input.minLevel ?? null, endsAt: new Date(Date.now() + input.durationMs) }).returning();
  const msg = await channel.send({ embeds: [giveawayEmbed(g)], components: [entryRow(g)] });
  await getDb().update(giveaways).set({ messageId: msg.id }).where(eq(giveaways.id, g.id));
  return g;
}

function pick<T>(arr: T[], n: number): T[] { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, n); }

export async function endGiveaway(guild: Guild, id: string, reroll = false): Promise<string[]> {
  const db = getDb();
  const [g] = await db.select().from(giveaways).where(and(eq(giveaways.id, id), eq(giveaways.guildId, guild.id)));
  if (!g) throw new Error("Giveaway not found");
  if (g.ended && !reroll) return g.winnerIds;
  // Only members still in the server can win.
  const present: string[] = [];
  for (const u of g.entrants) if (await guild.members.fetch(u).catch(() => null)) present.push(u);
  const pool = reroll ? present.filter((u) => !g.winnerIds.includes(u)) : present;
  const winners = pick(pool, g.winnerCount);
  const [updated] = await db.update(giveaways).set({ ended: true, winnerIds: winners }).where(eq(giveaways.id, g.id)).returning();
  const ch = await guild.channels.fetch(g.channelId).catch(() => null);
  if (ch?.isTextBased() && "send" in ch) {
    const msg = g.messageId ? await ch.messages.fetch(g.messageId).catch(() => null) : null;
    await msg?.edit({ embeds: [giveawayEmbed(updated)], components: [entryRow(updated)] }).catch(() => undefined);
    await ch.send({ content: winners.length ? `🎉 Congratulations ${winners.map((w) => `<@${w}>`).join(", ")}! You won **${g.prize}**!` : `No valid entries for **${g.prize}**.`, allowedMentions: { users: winners } });
  }
  return winners;
}

export async function endDueGiveaways(): Promise<void> {
  const due = await getDb().select().from(giveaways).where(and(eq(giveaways.ended, false), lte(giveaways.endsAt, new Date()))).limit(25);
  for (const g of due) {
    const guild = runtime.client?.guilds.cache.get(g.guildId);
    if (guild) await endGiveaway(guild, g.id).catch(() => undefined);
  }
}

export const giveawayComponents: ComponentHandler = {
  prefix: "gw",
  async handle(i, [action, id]) {
    if (action !== "enter") return;
    const db = getDb();
    const [g] = await db.select().from(giveaways).where(eq(giveaways.id, id));
    if (!g || g.ended) return respond(i, { embeds: [fail("This giveaway has ended.")], ephemeral: true });
    if (g.requiredRoleId && !i.member.roles.cache.has(g.requiredRoleId)) return respond(i, { embeds: [fail(`You need <@&${g.requiredRoleId}> to enter.`)], ephemeral: true });
    if (g.minLevel) {
      const [lv] = await db.select().from(memberLevels).where(and(eq(memberLevels.guildId, g.guildId), eq(memberLevels.userId, i.user.id)));
      if ((lv?.level ?? 0) < g.minLevel) return respond(i, { embeds: [fail(`You need to be level ${g.minLevel} to enter.`)], ephemeral: true });
    }
    const entered = g.entrants.includes(i.user.id);
    const entrants = entered ? g.entrants.filter((u) => u !== i.user.id) : [...g.entrants, i.user.id];
    const [updated] = await db.update(giveaways).set({ entrants }).where(eq(giveaways.id, g.id)).returning();
    if (i.isButton()) await i.message.edit({ embeds: [giveawayEmbed(updated)] }).catch(() => undefined);
    return respond(i, { embeds: [ok(entered ? "You left the giveaway." : "You're entered — good luck! 🍀")], ephemeral: true });
  },
};

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type Guild, type TextBasedChannel } from "discord.js";
import { and, eq, lte } from "drizzle-orm";
import { getDb, polls } from "@moth/core";
import { brandEmbed, BRAND, ok, fail } from "../lib/embeds.js";
import { cid, type ComponentHandler } from "../commands/types.js";
import { respond } from "../lib/util.js";
import { runtime } from "../context.js";

type Poll = typeof polls.$inferSelect;
const LETTERS = ["🇦", "🇧", "🇨", "🇩", "🇪", "🇫", "🇬", "🇭", "🇮", "🇯"];

function tally(p: Poll) {
  const counts = p.options.map(() => 0);
  for (const v of Object.values(p.votes)) for (const idx of v) if (counts[idx] !== undefined) counts[idx]++;
  return counts;
}

function pollEmbed(p: Poll) {
  const counts = tally(p); const total = counts.reduce((a, b) => a + b, 0);
  const lines = p.options.map((o, i) => {
    const pct = total ? Math.round((counts[i] / total) * 100) : 0;
    const bar = "█".repeat(Math.round(pct / 10)) + "░".repeat(10 - Math.round(pct / 10));
    return `${LETTERS[i]} **${o}**\n\`${bar}\` ${pct}% (${counts[i]})`;
  });
  return brandEmbed(`📊 ${p.question}`, `${lines.join("\n\n")}\n\n${total} vote${total === 1 ? "" : "s"}${p.multiple ? " · multiple choice" : ""}${p.endsAt ? ` · ${p.ended ? "ended" : "ends"} <t:${Math.floor(p.endsAt.getTime() / 1000)}:R>` : ""}`, p.ended ? BRAND.info : undefined);
}
function rows(p: Poll) {
  const out: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < p.options.length; i += 5) out.push(new ActionRowBuilder<ButtonBuilder>().addComponents(p.options.slice(i, i + 5).map((o, j) => new ButtonBuilder().setCustomId(cid("poll", p.id, i + j)).setEmoji(LETTERS[i + j]).setLabel(o.slice(0, 70)).setStyle(ButtonStyle.Secondary).setDisabled(p.ended))));
  return out;
}

export async function createPoll(channel: TextBasedChannel & { send: Function }, input: { guildId: string; question: string; options: string[]; multiple: boolean; creatorId: string; durationMs?: number | null }) {
  const [p] = await getDb().insert(polls).values({ guildId: input.guildId, channelId: channel.id, question: input.question, options: input.options.slice(0, 10), multiple: input.multiple, creatorId: input.creatorId, endsAt: input.durationMs ? new Date(Date.now() + input.durationMs) : null }).returning();
  const msg = await channel.send({ embeds: [pollEmbed(p)], components: rows(p) });
  await getDb().update(polls).set({ messageId: msg.id }).where(eq(polls.id, p.id));
  return p;
}

export async function endPoll(guild: Guild, id: string) {
  const [p] = await getDb().update(polls).set({ ended: true }).where(and(eq(polls.id, id), eq(polls.guildId, guild.id))).returning();
  if (!p) return;
  const ch = await guild.channels.fetch(p.channelId).catch(() => null);
  if (ch?.isTextBased() && p.messageId) await ch.messages.fetch(p.messageId).then((m) => m.edit({ embeds: [pollEmbed(p)], components: rows(p) })).catch(() => undefined);
}

export async function endDuePolls() {
  const due = await getDb().select().from(polls).where(and(eq(polls.ended, false), lte(polls.endsAt, new Date()))).limit(25);
  for (const p of due) { const g = runtime.client?.guilds.cache.get(p.guildId); if (g) await endPoll(g, p.id); }
}

export const pollComponents: ComponentHandler = {
  prefix: "poll",
  async handle(i, [id, idxStr]) {
    const idx = Number(idxStr);
    const db = getDb();
    const [p] = await db.select().from(polls).where(eq(polls.id, id));
    if (!p || p.ended) return respond(i, { embeds: [fail("This poll has ended.")], ephemeral: true });
    const mine = new Set(p.votes[i.user.id] ?? []);
    if (mine.has(idx)) mine.delete(idx); else { if (!p.multiple) mine.clear(); mine.add(idx); }
    const votes = { ...p.votes, [i.user.id]: [...mine] };
    if (!mine.size) delete votes[i.user.id];
    const [updated] = await db.update(polls).set({ votes }).where(eq(polls.id, p.id)).returning();
    if (i.isButton()) await i.update({ embeds: [pollEmbed(updated)] });
    else await respond(i, { embeds: [ok("Vote recorded.")], ephemeral: true });
  },
};

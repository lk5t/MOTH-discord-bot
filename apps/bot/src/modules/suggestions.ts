import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, ModalBuilder, PermissionFlagsBits, TextInputBuilder, TextInputStyle,
  type Guild, type GuildMember, type Message, type TextChannel,
} from "discord.js";
import { and, eq, sql } from "drizzle-orm";
import { getDb, getGuildConfig, suggestions, suggestionVotes, truncate } from "@moth/core";
import { cid, type ComponentHandler } from "../commands/types.js";
import { brandEmbed, fail, ok } from "../lib/embeds.js";
import { fireAutomations } from "./automation.js";
import { log } from "../context.js";

type Suggestion = typeof suggestions.$inferSelect;
export type SuggestionStatus = Suggestion["status"];

const STATUS: Record<SuggestionStatus, { label: string; color: number; emoji: string }> = {
  open: { label: "Open for votes", color: 0x3f3f46, emoji: "🗳️" },
  considering: { label: "Under consideration", color: 0xf59e0b, emoji: "🤔" },
  approved: { label: "Approved", color: 0x22c55e, emoji: "✅" },
  denied: { label: "Denied", color: 0xdc143c, emoji: "❌" },
  implemented: { label: "Implemented", color: 0x8b5cf6, emoji: "🚀" },
};

function render(s: Suggestion, anonymous: boolean, author?: GuildMember | null) {
  const total = s.upvotes + s.downvotes;
  const pct = total ? Math.round((s.upvotes / total) * 100) : 0;
  const bar = total ? "🟩".repeat(Math.round(pct / 10)) + "🟥".repeat(10 - Math.round(pct / 10)) : "⬜".repeat(10);
  const st = STATUS[s.status];
  const e = brandEmbed(`💡 Suggestion #${s.number}`, truncate(s.content, 3500), st.color)
    .addFields({ name: "Votes", value: `${bar}\n👍 **${s.upvotes}** · 👎 **${s.downvotes}**${total ? ` · ${pct}% in favour` : ""}`, inline: false }, { name: "Status", value: `${st.emoji} ${st.label}`, inline: true });
  if (!anonymous) e.setAuthor({ name: author?.displayName ?? "Member", iconURL: author?.displayAvatarURL() }).addFields({ name: "From", value: `<@${s.authorId}>`, inline: true });
  if (s.response) e.addFields({ name: `Staff response${s.reviewerId ? "" : ""}`, value: truncate(s.response, 1024) });
  if (s.reviewerId) e.setFooter({ text: "Reviewed by staff" });
  const open = s.status === "open" || s.status === "considering";
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(cid("sug", "up", s.id)).setEmoji("👍").setLabel(String(s.upvotes)).setStyle(ButtonStyle.Success).setDisabled(!open),
    new ButtonBuilder().setCustomId(cid("sug", "down", s.id)).setEmoji("👎").setLabel(String(s.downvotes)).setStyle(ButtonStyle.Danger).setDisabled(!open),
    new ButtonBuilder().setCustomId(cid("sug", "review", s.id)).setEmoji("🛠️").setLabel("Review").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [e], components: [row], allowedMentions: { parse: [] as never[] } };
}

export async function isSuggestionStaff(member: GuildMember): Promise<boolean> {
  const cfg = (await getGuildConfig(member.guild.id)).suggestions;
  return member.permissions.has(PermissionFlagsBits.ManageGuild) || member.roles.cache.some((r) => cfg.staffRoleIds.includes(r.id));
}

export async function createSuggestion(member: GuildMember, content: string): Promise<Suggestion> {
  const cfg = (await getGuildConfig(member.guild.id)).suggestions;
  if (!cfg.enabled || !cfg.channelId) throw new Error("Suggestions aren't set up on this server.");
  const ch = member.guild.channels.cache.get(cfg.channelId);
  if (!ch || ch.type !== ChannelType.GuildText) throw new Error("The suggestion channel no longer exists.");
  const db = getDb();
  const [row] = await db.insert(suggestions).values({
    guildId: member.guild.id, authorId: member.id, content: content.slice(0, 2000), channelId: ch.id,
    number: sql`(select coalesce(max(${suggestions.number}), 0) + 1 from ${suggestions} where ${suggestions.guildId} = ${member.guild.id})`,
  }).returning();
  const msg = await ch.send(render(row, cfg.anonymous, member));
  let threadId: string | null = null;
  if (cfg.autoThread) threadId = (await msg.startThread({ name: `Suggestion #${row.number} — discussion`.slice(0, 100) }).catch(() => null))?.id ?? null;
  const [saved] = await db.update(suggestions).set({ messageId: msg.id, threadId }).where(eq(suggestions.id, row.id)).returning();
  void fireAutomations(member.guild, "suggestion_created", { member, user: member.user, channel: ch, text: content });
  return saved;
}

/** Messages typed in the suggestion channel become suggestions. Returns true if consumed. */
export async function handleSuggestionMessage(message: Message<true>): Promise<boolean> {
  const cfg = (await getGuildConfig(message.guildId)).suggestions;
  if (!cfg.enabled || !cfg.convertMessages || message.channelId !== cfg.channelId || !message.member) return false;
  if (message.content.trim().length < 3) { await message.delete().catch(() => undefined); return true; }
  try {
    await createSuggestion(message.member, message.content);
    await message.delete().catch(() => undefined);
  } catch (err) { log.warn({ err }, "suggestion from message failed"); }
  return true;
}

async function refresh(guild: Guild, s: Suggestion) {
  const cfg = (await getGuildConfig(guild.id)).suggestions;
  const ch = guild.channels.cache.get(s.channelId) as TextChannel | undefined;
  const msg = s.messageId ? await ch?.messages.fetch(s.messageId).catch(() => null) : null;
  const author = await guild.members.fetch(s.authorId).catch(() => null);
  await msg?.edit(render(s, cfg.anonymous, author)).catch(() => undefined);
}

export async function reviewSuggestion(reviewer: GuildMember, number: number, status: SuggestionStatus, response: string | null): Promise<Suggestion> {
  const guild = reviewer.guild;
  const cfg = (await getGuildConfig(guild.id)).suggestions;
  const [s] = await getDb().update(suggestions).set({ status, response, reviewerId: reviewer.id, updatedAt: new Date() })
    .where(and(eq(suggestions.guildId, guild.id), eq(suggestions.number, number))).returning();
  if (!s) throw new Error(`Suggestion #${number} not found.`);
  await refresh(guild, s);
  const st = STATUS[status];
  if (s.threadId && (status === "approved" || status === "denied" || status === "implemented")) {
    const th = guild.channels.cache.get(s.threadId);
    if (th?.isThread()) { await th.send({ content: `${st.emoji} Marked **${st.label.toLowerCase()}**${response ? `: ${response}` : ""}` }).catch(() => undefined); await th.setArchived(true).catch(() => undefined); }
  }
  if (cfg.reviewedChannelId && status !== "open") {
    const out = guild.channels.cache.get(cfg.reviewedChannelId);
    const author = await guild.members.fetch(s.authorId).catch(() => null);
    if (out?.isTextBased() && "send" in out) await out.send({ embeds: render(s, cfg.anonymous, author).embeds, allowedMentions: { parse: [] } }).catch(() => undefined);
  }
  if (cfg.dmAuthor && status !== "open") {
    const u = await guild.client.users.fetch(s.authorId).catch(() => null);
    await u?.send({ embeds: [brandEmbed(`${st.emoji} Your suggestion was ${st.label.toLowerCase()}`, `**${guild.name}** · Suggestion #${s.number}\n> ${truncate(s.content, 900)}${response ? `\n\n**Staff:** ${response}` : ""}`, st.color)] }).catch(() => undefined);
  }
  return s;
}

export const suggestionComponents: ComponentHandler = {
  prefix: "sug",
  async handle(i, [action, idStr, extra]) {
    const id = Number(idStr);
    const db = getDb();
    const [s] = await db.select().from(suggestions).where(and(eq(suggestions.id, id), eq(suggestions.guildId, i.guildId)));
    if (!s) return i.reply({ embeds: [fail("Suggestion not found.")], ephemeral: true });

    if (action === "up" || action === "down") {
      if (s.status !== "open" && s.status !== "considering") return i.reply({ embeds: [fail("Voting has closed.")], ephemeral: true });
      const value = action === "up" ? 1 : -1;
      const [prev] = await db.select().from(suggestionVotes).where(and(eq(suggestionVotes.suggestionId, id), eq(suggestionVotes.userId, i.user.id)));
      if (prev?.value === value) await db.delete(suggestionVotes).where(and(eq(suggestionVotes.suggestionId, id), eq(suggestionVotes.userId, i.user.id)));
      else await db.insert(suggestionVotes).values({ suggestionId: id, userId: i.user.id, value }).onConflictDoUpdate({ target: [suggestionVotes.suggestionId, suggestionVotes.userId], set: { value } });
      const [counts] = await db.select({ up: sql<number>`count(*) filter (where value > 0)::int`, down: sql<number>`count(*) filter (where value < 0)::int` }).from(suggestionVotes).where(eq(suggestionVotes.suggestionId, id));
      const [updated] = await db.update(suggestions).set({ upvotes: counts.up, downvotes: counts.down }).where(eq(suggestions.id, id)).returning();
      const cfg = (await getGuildConfig(i.guildId)).suggestions;
      const author = await i.guild.members.fetch(s.authorId).catch(() => null);
      if (i.isButton()) return i.update(render(updated, cfg.anonymous, author));
      return;
    }

    if (!(await isSuggestionStaff(i.member))) return i.reply({ embeds: [fail("Only staff can review suggestions.")], ephemeral: true });
    if (action === "review") {
      const b = (status: SuggestionStatus) => new ButtonBuilder().setCustomId(cid("sug", "set", id, status)).setLabel(STATUS[status].label).setEmoji(STATUS[status].emoji).setStyle(status === "approved" || status === "implemented" ? ButtonStyle.Success : status === "denied" ? ButtonStyle.Danger : ButtonStyle.Secondary);
      return i.reply({ content: `Review suggestion #${s.number}:`, components: [new ActionRowBuilder<ButtonBuilder>().addComponents(b("approved"), b("denied"), b("considering"), b("implemented"), b("open"))], ephemeral: true });
    }
    if (action === "set" && i.isButton()) {
      return i.showModal(new ModalBuilder().setCustomId(cid("sug", "reason", id, extra)).setTitle(`${STATUS[extra as SuggestionStatus]?.label ?? "Review"} · #${s.number}`)
        .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("reason").setLabel("Response to the member (optional)").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000))));
    }
    if (action === "reason" && i.isModalSubmit()) {
      const status = (extra in STATUS ? extra : "open") as SuggestionStatus;
      await reviewSuggestion(i.member, s.number, status, i.fields.getTextInputValue("reason").trim() || null);
      return i.reply({ embeds: [ok(`Suggestion #${s.number} marked **${STATUS[status].label.toLowerCase()}**.`)], ephemeral: true });
    }
  },
};

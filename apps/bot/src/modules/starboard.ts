import { EmbedBuilder, type MessageReaction, type PartialMessageReaction, type PartialUser, type User } from "discord.js";
import { eq } from "drizzle-orm";
import { getDb, getGuildConfig, starboardPosts, truncate } from "@moth/core";

/** Reposts messages that collect enough star reactions; keeps the count live. */

const emojiKey = (r: MessageReaction | PartialMessageReaction) => (r.emoji.id ? `<:${r.emoji.name}:${r.emoji.id}>` : r.emoji.name ?? "");
const locks = new Map<string, Promise<void>>();

export function onStarboardReaction(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) {
  const id = reaction.message.id;
  const prev = locks.get(id) ?? Promise.resolve();
  const next = prev.then(() => handle(reaction, user)).catch(() => undefined);
  locks.set(id, next);
  void next.finally(() => { if (locks.get(id) === next) locks.delete(id); });
}

async function handle(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) {
  const guild = reaction.message.guild;
  if (!guild || user.bot) return;
  const cfg = (await getGuildConfig(guild.id)).starboard;
  if (!cfg.enabled || !cfg.channelId || (emojiKey(reaction) !== cfg.emoji && reaction.emoji.name !== cfg.emoji)) return;
  if (reaction.message.channelId === cfg.channelId || cfg.ignoredChannelIds.includes(reaction.message.channelId)) return;
  const r = reaction.partial ? await reaction.fetch().catch(() => null) : reaction;
  const msg = r?.message.partial ? await r.message.fetch().catch(() => null) : r?.message;
  if (!r || !msg || !msg.author || msg.author.bot) return;
  const users = await r.users.fetch().catch(() => null);
  const stars = users ? users.filter((u) => !u.bot && (cfg.allowSelfStar || u.id !== msg.author!.id)).size : r.count ?? 0;
  const board = guild.channels.cache.get(cfg.channelId);
  if (!board?.isTextBased() || !("send" in board)) return;
  const db = getDb();
  const [row] = await db.select().from(starboardPosts).where(eq(starboardPosts.messageId, msg.id));
  const content = `${cfg.emoji} **${stars}** · <#${msg.channelId}>`;
  const embed = new EmbedBuilder().setColor(0xf5c542).setAuthor({ name: msg.member?.displayName ?? msg.author.username, iconURL: msg.author.displayAvatarURL() })
    .setDescription(truncate(msg.content || "", 3900) || null).addFields({ name: "Source", value: `[Jump to message](${msg.url})` }).setTimestamp(msg.createdAt);
  const img = msg.attachments.find((a) => a.contentType?.startsWith("image/"));
  if (img) embed.setImage(img.url);
  else if (msg.embeds[0]?.image?.url) embed.setImage(msg.embeds[0].image.url);

  if (row?.starboardMessageId) {
    const posted = await board.messages.fetch(row.starboardMessageId).catch(() => null);
    if (stars < cfg.threshold) { await posted?.delete().catch(() => undefined); await db.update(starboardPosts).set({ starboardMessageId: null, stars }).where(eq(starboardPosts.messageId, msg.id)); return; }
    if (posted) { await posted.edit({ content, embeds: [embed] }); await db.update(starboardPosts).set({ stars }).where(eq(starboardPosts.messageId, msg.id)); return; }
  }
  if (stars < cfg.threshold) return;
  const posted = await board.send({ content, embeds: [embed], allowedMentions: { parse: [] } });
  await db.insert(starboardPosts).values({ messageId: msg.id, guildId: guild.id, channelId: msg.channelId, authorId: msg.author.id, starboardMessageId: posted.id, stars })
    .onConflictDoUpdate({ target: starboardPosts.messageId, set: { starboardMessageId: posted.id, stars } });
}

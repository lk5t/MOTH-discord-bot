import { ChannelType, type Guild, type Message } from "discord.js";
import { and, eq } from "drizzle-orm";
import { featureState, getDb, getGuildConfig, renderTemplate } from "@moth/core";
import { messagePayload, templateContext } from "../lib/embeds.js";
import { log, runtime } from "../context.js";

/**
 * Channel rules (media-only, auto-thread, auto-publish, auto-react, auto-delete,
 * one-message-per-interval), sticky messages and live stats channels.
 */

const lastPost = new Map<string, number>();
const LINK = /https?:\/\/\S+/i;

/** Returns true when the message was removed by a rule. */
export async function applyChannelRules(message: Message<true>): Promise<boolean> {
  const cfg = await getGuildConfig(message.guildId);
  const rule = cfg.channelRules.find((r) => r.channelId === message.channelId);
  if (!rule || message.author.bot) return false;
  const staff = message.member?.permissions.has("ManageMessages") ?? false;

  if (rule.mediaOnly && !staff && !message.attachments.size && !LINK.test(message.content) && !message.stickers.size) {
    await message.delete().catch(() => undefined);
    const warn = await message.channel.send({ content: `<@${message.author.id}> this channel is for images, videos and links only — reply in a thread to discuss.`, allowedMentions: { users: [message.author.id] } }).catch(() => null);
    setTimeout(() => void warn?.delete().catch(() => undefined), 6000);
    return true;
  }
  if (rule.oneMessagePerMinutes && !staff) {
    const key = `${message.channelId}:${message.author.id}`;
    const prev = lastPost.get(key) ?? 0;
    if (Date.now() - prev < rule.oneMessagePerMinutes * 60_000) {
      await message.delete().catch(() => undefined);
      await message.author.send(`You can post in **#${message.channel.name}** once every ${rule.oneMessagePerMinutes} minute(s). Your message:\n>>> ${message.content.slice(0, 1800)}`).catch(() => undefined);
      return true;
    }
    lastPost.set(key, Date.now());
  }
  for (const e of rule.autoReact) await message.react(e).catch(() => undefined);
  if (rule.autoThread && message.channel.type === ChannelType.GuildText && !message.hasThread) {
    const name = renderTemplate(rule.threadName, templateContext({ member: message.member, guild: message.guild })) || "Discussion";
    await message.startThread({ name: name.slice(0, 100) }).catch(() => undefined);
  }
  if (rule.autoPublish && message.channel.type === ChannelType.GuildAnnouncement && message.crosspostable) await message.crosspost().catch(() => undefined);
  if (rule.deleteAfterSeconds && !message.pinned) setTimeout(() => void message.delete().catch(() => undefined), rule.deleteAfterSeconds * 1000);
  return false;
}

// ───────── Sticky messages ─────────
const stickyCount = new Map<string, number>();
const stickyBusy = new Set<string>();

async function getState<T>(guildId: string, key: string): Promise<T | null> {
  const [row] = await getDb().select().from(featureState).where(and(eq(featureState.guildId, guildId), eq(featureState.key, key)));
  return (row?.value as T) ?? null;
}
async function setState(guildId: string, key: string, value: unknown) {
  await getDb().insert(featureState).values({ guildId, key, value: value as never }).onConflictDoUpdate({ target: [featureState.guildId, featureState.key], set: { value: value as never, updatedAt: new Date() } });
}

export async function handleSticky(message: Message<true>): Promise<void> {
  if (message.author.id === message.client.user.id) return;
  const cfg = await getGuildConfig(message.guildId);
  const sticky = cfg.sticky.find((s) => s.channelId === message.channelId);
  if (!sticky) return;
  const key = message.channelId;
  const n = (stickyCount.get(key) ?? 0) + 1;
  stickyCount.set(key, n);
  if (n < sticky.every || stickyBusy.has(key)) return;
  stickyBusy.add(key);
  try {
    stickyCount.set(key, 0);
    const stateKey = `sticky:${message.channelId}`;
    const prev = await getState<{ messageId: string }>(message.guildId, stateKey);
    if (prev?.messageId) await message.channel.messages.delete(prev.messageId).catch(() => undefined);
    const payload = messagePayload(sticky.message, templateContext({ guild: message.guild, channel: { id: message.channelId, name: message.channel.name } }));
    const sent = await message.channel.send({ ...payload, content: payload.content && payload.content !== "​" ? `📌 ${payload.content}` : payload.embeds ? undefined : payload.content });
    await setState(message.guildId, stateKey, { messageId: sent.id });
  } catch (err) { log.debug({ err }, "sticky repost failed"); } finally { stickyBusy.delete(key); }
}

/** Posts (or re-posts) every configured sticky right away, e.g. after a config change. */
export async function refreshStickies(guild: Guild): Promise<void> {
  const cfg = await getGuildConfig(guild.id);
  for (const s of cfg.sticky) {
    const ch = guild.channels.cache.get(s.channelId);
    if (!ch?.isTextBased() || !("send" in ch)) continue;
    const stateKey = `sticky:${s.channelId}`;
    const prev = await getState<{ messageId: string }>(guild.id, stateKey);
    const last = ch.lastMessageId;
    if (prev?.messageId && prev.messageId === last) continue; // already at the bottom
    if (prev?.messageId) await ch.messages.delete(prev.messageId).catch(() => undefined);
    const payload = messagePayload(s.message, templateContext({ guild, channel: { id: ch.id, name: ch.name } }));
    const sent = await ch.send({ ...payload, content: payload.content && payload.content !== "​" ? `📌 ${payload.content}` : payload.embeds ? undefined : payload.content }).catch(() => null);
    if (sent) await setState(guild.id, stateKey, { messageId: sent.id });
  }
}

// ───────── Stats channels ─────────
export function statsValues(guild: Guild): Record<string, number> {
  const bots = guild.members.cache.filter((m) => m.user.bot).size;
  return {
    members: guild.memberCount,
    bots,
    humans: Math.max(0, guild.memberCount - bots),
    boosts: guild.premiumSubscriptionCount ?? 0,
    online: guild.approximatePresenceCount ?? guild.presences.cache.filter((p) => p.status !== "offline").size,
    channels: guild.channels.cache.filter((c) => !c.isThread() && c.type !== ChannelType.GuildCategory).size,
    roles: guild.roles.cache.size - 1,
  };
}

export const renderStats = (template: string, v: Record<string, number>) => template.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? v[k].toLocaleString("en-US") : m));

/** Renames stats channels when their value changed (Discord allows ~2 renames / 10 min per channel). */
export async function updateStatsChannels(only?: Guild): Promise<void> {
  for (const guild of only ? [only] : runtime.client?.guilds.cache.values() ?? []) {
    const cfg = await getGuildConfig(guild.id).catch(() => null);
    if (!cfg?.statsChannels.length) continue;
    let v = statsValues(guild);
    if (cfg.statsChannels.some((s) => s.template.includes("{online}"))) {
      const fresh = await guild.client.guilds.fetch({ guild: guild.id, withCounts: true, force: true }).catch(() => null);
      if (fresh?.approximatePresenceCount != null) v = { ...v, online: fresh.approximatePresenceCount };
    }
    for (const s of cfg.statsChannels) {
      const ch = guild.channels.cache.get(s.channelId);
      if (!ch || ch.isThread() || !("setName" in ch)) continue;
      const name = renderStats(s.template, v).slice(0, 100);
      if (ch.name !== name) await ch.setName(name, "MOTH stats channel").catch((err) => log.debug({ err }, "stats rename failed"));
    }
  }
}

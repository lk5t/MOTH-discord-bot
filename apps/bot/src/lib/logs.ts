import type { EmbedBuilder, Guild, TextBasedChannel } from "discord.js";
import { getGuildConfig } from "@moth/core";
import { log } from "../context.js";

export type LogKind = "mod" | "security" | "general";

/** Sends an embed to the configured log channel for this kind. Never throws. */
export async function sendLog(guild: Guild, kind: LogKind, embed: EmbedBuilder, content?: string): Promise<string | null> {
  try {
    const cfg = await getGuildConfig(guild.id);
    const id = kind === "mod" ? cfg.general.modLogChannelId ?? cfg.general.logChannelId
      : kind === "security" ? cfg.general.securityLogChannelId ?? cfg.general.modLogChannelId ?? cfg.general.logChannelId
      : cfg.general.logChannelId;
    if (!id) return null;
    const ch = guild.channels.cache.get(id) ?? (await guild.channels.fetch(id).catch(() => null));
    if (!ch || !ch.isTextBased()) return null;
    const msg = await (ch as TextBasedChannel & { send: Function }).send({ content, embeds: [embed], allowedMentions: { parse: ["roles"] } });
    return msg.id as string;
  } catch (err) {
    log.debug({ err, guild: guild.id }, "failed to send log");
    return null;
  }
}

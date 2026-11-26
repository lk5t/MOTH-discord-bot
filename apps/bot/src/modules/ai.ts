import { PermissionFlagsBits, type Guild, type GuildMember, type Message, type TextBasedChannel } from "discord.js";
import { aiRequestsToday, buildPersonalityPrompt, getGuildConfig, recordAIUsage, resolveAIClient, type ChatMessage, type GuildConfig } from "@moth/core";
import { log } from "../context.js";

/** Short server context the assistant may use (public info only). */
export function serverContext(guild: Guild): string {
  const channels = guild.channels.cache.filter((c) => c.isTextBased() && !c.isThread() && c.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel)).map((c) => `#${c.name}${"topic" in c && c.topic ? ` — ${String(c.topic).slice(0, 80)}` : ""}`).slice(0, 40);
  const roles = guild.roles.cache.filter((r) => r.hoist && !r.managed).sort((a, b) => b.position - a.position).map((r) => r.name).slice(0, 15);
  return `Members: ${guild.memberCount}. Created ${guild.createdAt.toDateString()}.\nPublic channels:\n${channels.join("\n")}\nStaff/display roles: ${roles.join(", ")}`;
}

export async function canUseAI(member: GuildMember, cfg: GuildConfig): Promise<string | null> {
  if (!cfg.ai.enabled) return "The AI assistant is disabled on this server.";
  if (cfg.ai.allowedRoleIds.length && !cfg.ai.allowedRoleIds.some((r) => member.roles.cache.has(r)) && !member.permissions.has(PermissionFlagsBits.ManageGuild)) return "You don't have access to the AI assistant.";
  if (cfg.ai.dailyRequestLimitPerUser > 0 && !member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    const used = await aiRequestsToday(member.guild.id, member.id);
    if (used >= cfg.ai.dailyRequestLimitPerUser) return `You've reached today's AI limit (${cfg.ai.dailyRequestLimitPerUser}).`;
  }
  return null;
}

export async function askAI(guild: Guild, member: GuildMember, prompt: string, history: ChatMessage[] = [], feature = "chat"): Promise<string> {
  const cfg = await getGuildConfig(guild.id);
  const ai = await resolveAIClient(guild.id, cfg.ai.providerId);
  if (!ai) return "No AI provider is configured. An admin can add one in the MOTH dashboard → AI Settings.";
  const system = buildPersonalityPrompt(cfg.ai, guild.name, serverContext(guild)) + `\nThe user talking to you is ${member.displayName}. Their roles: ${member.roles.cache.filter((r) => r.id !== guild.id).map((r) => r.name).slice(0, 10).join(", ") || "none"}.`;
  const r = await ai.complete([{ role: "system", content: system }, ...history.slice(-10), { role: "user", content: prompt.slice(0, 4000) }], { maxTokens: cfg.ai.maxTokens });
  await recordAIUsage({ guildId: guild.id, userId: member.id, feature, inputTokens: r.inputTokens, outputTokens: r.outputTokens, providerKind: ai.config.kind });
  return r.text.trim() || "…";
}

export async function summarizeChannel(channel: TextBasedChannel, member: GuildMember, count: number): Promise<string> {
  const guild = member.guild;
  const cfg = await getGuildConfig(guild.id);
  const ai = await resolveAIClient(guild.id, cfg.ai.providerId);
  if (!ai) return "No AI provider is configured.";
  const msgs = await channel.messages.fetch({ limit: Math.min(100, count) });
  const transcript = [...msgs.values()].reverse().filter((m) => m.content).map((m) => `${m.member?.displayName ?? m.author.username}: ${m.content.slice(0, 300)}`).join("\n");
  const r = await ai.complete([
    { role: "system", content: buildPersonalityPrompt(cfg.ai, guild.name) + "\nSummarise the conversation below into concise bullet points: main topics, decisions, open questions. Do not invent details." },
    { role: "user", content: transcript.slice(-12000) || "(no messages)" },
  ], { maxTokens: 600 });
  await recordAIUsage({ guildId: guild.id, userId: member.id, feature: "summarize", inputTokens: r.inputTokens, outputTokens: r.outputTokens, providerKind: ai.config.kind });
  return r.text.trim();
}

const threads = new Map<string, ChatMessage[]>(); // channel:user -> recent conversation

/** Responds when MOTH is mentioned or in AI chat channels. */
export async function handleAIMessage(message: Message<true>): Promise<boolean> {
  if (message.author.bot || !message.member) return false;
  const cfg = await getGuildConfig(message.guildId);
  if (!cfg.ai.enabled) return false;
  const mentioned = cfg.ai.respondToMentions && message.mentions.users.has(message.client.user.id) && !message.mentions.everyone;
  const inChat = cfg.ai.chatChannelIds.includes(message.channelId);
  if (!mentioned && !inChat) return false;
  const denied = await canUseAI(message.member, cfg);
  if (denied) { if (mentioned) await message.reply({ content: denied, allowedMentions: { repliedUser: false } }).catch(() => undefined); return true; }
  const prompt = message.content.replace(new RegExp(`<@!?${message.client.user.id}>`, "g"), "").trim();
  if (!prompt) return false;
  const key = `${message.channelId}:${message.author.id}`;
  const history = threads.get(key) ?? [];
  try {
    await message.channel.sendTyping().catch(() => undefined);
    const reply = await askAI(message.guild, message.member, prompt, history);
    history.push({ role: "user", content: prompt }, { role: "assistant", content: reply });
    threads.set(key, history.slice(-12));
    await message.reply({ content: reply.slice(0, 2000), allowedMentions: { repliedUser: false, parse: [] } });
  } catch (err) {
    log.warn({ err }, "ai reply failed");
    await message.reply({ content: "Sorry — I couldn't reach the AI provider right now.", allowedMentions: { repliedUser: false } }).catch(() => undefined);
  }
  return true;
}

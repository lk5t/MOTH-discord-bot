import { PermissionFlagsBits, type Message } from "discord.js";
import { getGuildConfig, publishEvent, getDb, securityEvents, resolveAIClient, recordAIUsage, type GuildConfig, type PunishmentAction } from "@moth/core";
import { applyPunishment } from "./moderation.js";
import { brandEmbed, BRAND } from "../lib/embeds.js";
import { sendLog } from "../lib/logs.js";
import { log } from "../context.js";

/**
 * Message auto-moderation. Every enforcement records a human-readable
 * explanation (rule, threshold, observed value) to keep decisions auditable
 * and to help admins tune out false positives.
 */

interface Violation { rule: string; action: PunishmentAction; timeoutMinutes: number; summary: string; details: Record<string, unknown> }

const recent = new Map<string, { at: number; content: string }[]>(); // guild:user -> messages
setInterval(() => { const cutoff = Date.now() - 600_000; for (const [k, v] of recent) { const f = v.filter((m) => m.at > cutoff); if (f.length) recent.set(k, f); else recent.delete(k); } }, 60_000).unref();

const INVITE_RE = /(?:discord(?:app)?\.com\/invite|discord\.gg|dsc\.gg|discord\.me)\/([a-z0-9-]+)/gi;
const URL_RE = /https?:\/\/([^\s/$.?#][^\s/]*)/gi;
const ZALGO_RE = /[̀-ͯ҉]{4,}/;

function escapeRe(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

export async function checkMessage(message: Message<true>): Promise<boolean> {
  if (message.author.bot || !message.member || message.system) return false;
  const cfg = await getGuildConfig(message.guildId);
  const am = cfg.automod;
  if (!am.enabled) return false;
  const m = message.member;
  if (m.permissions.has(PermissionFlagsBits.ManageMessages) || m.permissions.has(PermissionFlagsBits.Administrator)) return false;
  if (am.exemptChannelIds.includes(message.channelId) || (message.channel.isThread() && message.channel.parentId && am.exemptChannelIds.includes(message.channel.parentId))) return false;
  if (am.exemptRoleIds.some((r) => m.roles.cache.has(r))) return false;

  const v = await detect(message, cfg);
  if (!v) {
    if (am.aiAssist.enabled && message.content.length >= 12) void aiReview(message, cfg).catch(() => undefined);
    return false;
  }
  await enforce(message, v, cfg);
  return true;
}

async function detect(message: Message<true>, cfg: GuildConfig): Promise<Violation | null> {
  const am = cfg.automod;
  const content = message.content;
  const key = `${message.guildId}:${message.author.id}`;
  const list = recent.get(key) ?? [];
  list.push({ at: Date.now(), content }); recent.set(key, list.slice(-50));

  if (am.words.enabled && (am.words.words.length || am.words.regex.length)) {
    const lower = content.toLowerCase();
    const hit = am.words.words.find((w) => w && (am.words.matchWholeWord ? new RegExp(`(^|\\W)${escapeRe(w.toLowerCase())}($|\\W)`, "i").test(lower) : lower.includes(w.toLowerCase())));
    const rx = !hit && am.words.regex.find((r) => { try { return new RegExp(r, "i").test(content); } catch { return false; } });
    if (hit || rx) return { rule: "word_filter", action: am.words.action, timeoutMinutes: am.words.timeoutMinutes, summary: "Message contained a filtered word or phrase.", details: { matched: hit ? "word" : "pattern" } };
  }
  if (am.invites.enabled) {
    const codes = [...content.matchAll(INVITE_RE)].map((x) => x[1]);
    if (codes.length) {
      let foreign = codes;
      if (am.invites.allowOwnGuild || am.invites.allowedGuildIds.length) {
        foreign = [];
        for (const code of codes) {
          const inv = await message.client.fetchInvite(code).catch(() => null);
          const gid = inv?.guild?.id;
          if (!gid || !((am.invites.allowOwnGuild && gid === message.guildId) || am.invites.allowedGuildIds.includes(gid))) foreign.push(code);
        }
      }
      if (foreign.length) return { rule: "invite_filter", action: am.invites.action, timeoutMinutes: am.invites.timeoutMinutes, summary: "Posting invites to other servers isn't allowed here.", details: { invites: foreign.length } };
    }
  }
  if (am.links.enabled && am.links.mode !== "allow-all") {
    const hosts = [...content.matchAll(URL_RE)].map((x) => x[1].toLowerCase().replace(/^www\./, ""));
    const bad = am.links.mode === "block-all" ? hosts : hosts.filter((h) => !am.links.allowedDomains.some((d) => h === d || h.endsWith(`.${d}`)));
    if (bad.length) return { rule: "link_filter", action: am.links.action, timeoutMinutes: am.links.timeoutMinutes, summary: am.links.mode === "block-all" ? "Links aren't allowed here." : `Links to ${bad[0]} aren't on the allowed list.`, details: { domains: bad.slice(0, 5) } };
  }
  if (am.mentions.enabled) {
    const count = message.mentions.users.size + message.mentions.roles.size;
    if (count >= am.mentions.maxMentions) return { rule: "mass_mention", action: am.mentions.action, timeoutMinutes: am.mentions.timeoutMinutes, summary: `Mentioned ${count} users/roles (limit ${am.mentions.maxMentions}).`, details: { count, limit: am.mentions.maxMentions } };
    if (am.mentions.blockEveryone && message.mentions.everyone && !message.member!.permissions.has(PermissionFlagsBits.MentionEveryone)) return { rule: "everyone_mention", action: "delete", timeoutMinutes: 0, summary: "Attempted to ping @everyone/@here without permission.", details: {} };
  }
  if (am.spam.enabled) {
    const windowMs = am.spam.perSeconds * 1000;
    const inWindow = list.filter((x) => Date.now() - x.at <= windowMs).length;
    if (inWindow >= am.spam.maxMessages) { recent.delete(key); return { rule: "spam", action: am.spam.action, timeoutMinutes: am.spam.timeoutMinutes, summary: `Sent ${inWindow} messages in ${am.spam.perSeconds}s (limit ${am.spam.maxMessages - 1}).`, details: { count: inWindow, seconds: am.spam.perSeconds } }; }
  }
  if (am.duplicates.enabled && content.length > 3) {
    const windowMs = am.duplicates.perSeconds * 1000;
    const dupes = list.filter((x) => Date.now() - x.at <= windowMs && x.content.trim().toLowerCase() === content.trim().toLowerCase()).length;
    if (dupes >= am.duplicates.maxDuplicates) return { rule: "duplicates", action: am.duplicates.action, timeoutMinutes: am.duplicates.timeoutMinutes, summary: `Repeated the same message ${dupes} times.`, details: { count: dupes } };
  }
  if (am.caps.enabled && content.length >= am.caps.minLength) {
    const letters = content.replace(/[^a-zA-Z]/g, "");
    const pct = letters.length ? Math.round((letters.replace(/[^A-Z]/g, "").length / letters.length) * 100) : 0;
    if (letters.length >= am.caps.minLength && pct >= am.caps.percent) return { rule: "caps", action: am.caps.action, timeoutMinutes: am.caps.timeoutMinutes, summary: `Message was ${pct}% capital letters (limit ${am.caps.percent}%).`, details: { percent: pct } };
  }
  if (am.zalgo.enabled && ZALGO_RE.test(content)) return { rule: "zalgo", action: am.zalgo.action, timeoutMinutes: am.zalgo.timeoutMinutes, summary: "Message contained corrupted (zalgo) text.", details: {} };
  return null;
}

async function enforce(message: Message<true>, v: Violation, cfg: GuildConfig) {
  if (v.action !== "none") await message.delete().catch(() => undefined);
  const explanation = { rule: v.rule, summary: v.summary, ...v.details, channelId: message.channelId, excerpt: message.content.slice(0, 200) };
  if (v.action === "delete") {
    const warn = await message.channel.send({ content: `<@${message.author.id}>, your message was removed: ${v.summary}`, allowedMentions: { users: [message.author.id] } }).catch(() => null);
    if (warn) setTimeout(() => void warn.delete().catch(() => undefined), 8000);
    await sendLog(message.guild, "mod", brandEmbed("AutoMod · message removed", `**User:** <@${message.author.id}>\n**Channel:** <#${message.channelId}>\n**Rule:** ${v.rule}\n**Why:** ${v.summary}`, BRAND.warning).addFields({ name: "Content", value: message.content.slice(0, 1000) || "—" }));
  } else if (v.action !== "none") {
    await applyPunishment(message.guild, message.member!, v.action, `AutoMod: ${v.summary}`, explanation, v.timeoutMinutes).catch((err) => log.warn({ err }, "automod punishment failed"));
  }
  await getDb().insert(securityEvents).values({ guildId: message.guildId, type: "automod", severity: v.action === "ban" || v.action === "kick" ? "medium" : "low", userId: message.author.id, summary: `${v.rule}: ${v.summary}`, details: explanation, actionTaken: v.action });
  await publishEvent("security.event", message.guildId, { type: "automod", rule: v.rule, action: v.action, userId: message.author.id });
  void cfg;
}

/** Optional AI review: flags potentially harmful messages for moderators. Never punishes unless autoAct is enabled. */
async function aiReview(message: Message<true>, cfg: GuildConfig) {
  const ai = await resolveAIClient(message.guildId, cfg.ai.providerId);
  if (!ai) return;
  const { z } = await import("zod");
  const schema = z.object({ harmful: z.boolean(), score: z.number().min(0).max(1), category: z.string(), reason: z.string() });
  const { data, usage } = await ai.completeJson([
    { role: "system", content: "You are a content-moderation classifier for a Discord server. Classify the message for harassment, hate, threats, sexual content involving minors, self-harm encouragement, scams or doxxing. Be conservative: banter, swearing without a target, and gaming trash-talk are NOT harmful. Respond with JSON {harmful, score (0-1), category, reason}." },
    { role: "user", content: message.content.slice(0, 1500) },
  ], schema, { maxTokens: 150, temperature: 0 });
  await recordAIUsage({ guildId: message.guildId, userId: null, feature: "automod", inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, providerKind: ai.config.kind });
  if (!data.harmful || data.score < cfg.automod.aiAssist.threshold) return;
  await sendLog(message.guild, "mod", brandEmbed("🤖 AI moderation flag", `**User:** <@${message.author.id}>\n**Channel:** ${message.url}\n**Category:** ${data.category} (${Math.round(data.score * 100)}%)\n**Reason:** ${data.reason}`, BRAND.warning).addFields({ name: "Content", value: message.content.slice(0, 1000) }).setFooter({ text: cfg.automod.aiAssist.autoAct ? "Message removed automatically" : "Recommendation only — no action taken" }));
  if (cfg.automod.aiAssist.autoAct) await message.delete().catch(() => undefined);
}

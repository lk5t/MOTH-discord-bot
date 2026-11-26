import { ChannelType, PermissionFlagsBits, type Guild, type GuildMember, type Message, type TextBasedChannel, type User } from "discord.js";
import { Cron } from "croner";
import { eq, sql } from "drizzle-orm";
import {
  automationRuns, automations, automationSchema, getDb, getGuildConfig, renderTemplate, scheduledJobs, type AutomationAction, type AutomationCondition, type AutomationDefinition, type AutomationTrigger,
} from "@moth/core";
import { messagePayload, templateContext } from "../lib/embeds.js";
import { sendLog } from "../lib/logs.js";
import { brandEmbed, BRAND } from "../lib/embeds.js";
import { log, runtime } from "../context.js";
import { addXp } from "./leveling.js";
import { addCurrency } from "./economy.js";

/**
 * Event-driven workflow engine. Automations are cached per guild and
 * reloaded on `automations.updated`. Scheduled triggers use croner.
 */

type Row = typeof automations.$inferSelect & { def: AutomationDefinition };
export interface RunContext {
  member?: GuildMember | null;
  user?: User | null;
  message?: Message<true> | null;
  channel?: TextBasedChannel | { id: string; name: string } | null;
  emoji?: string;
  roleId?: string;
  level?: number;
  /** Text for {message} when there is no message object (deleted message, suggestion…). */
  text?: string;
  /** Parent channel (thread_create). */
  parentId?: string | null;
  invite?: { code: string; inviterId: string | null } | null;
  dryRun?: boolean;
  /** Resolved per run. */
  timezone?: string;
}

const cache = new Map<string, Row[]>();
const cooldowns = new Map<string, number>();
const crons = new Map<string, Cron>();

async function load(guildId: string): Promise<Row[]> {
  const hit = cache.get(guildId);
  if (hit) return hit;
  const rows = await getDb().select().from(automations).where(eq(automations.guildId, guildId));
  const parsed: Row[] = [];
  for (const r of rows) {
    const def = automationSchema.safeParse(r.definition);
    if (def.success) parsed.push({ ...r, def: def.data });
    else log.warn({ automation: r.id }, "invalid automation definition skipped");
  }
  cache.set(guildId, parsed);
  return parsed;
}

export function invalidateAutomations(guildId: string) {
  cache.delete(guildId);
  void scheduleGuild(guildId);
}

function triggerMatches(t: AutomationTrigger, type: AutomationTrigger["type"], ctx: RunContext): boolean {
  if (t.type !== type) return false;
  const chId = ctx.channel && "id" in ctx.channel ? ctx.channel.id : undefined;
  switch (t.type) {
    case "message": {
      const msg = ctx.message;
      if (!msg || (t.ignoreBots && msg.author.bot) || msg.author.id === msg.client.user.id) return false;
      if (t.channelIds.length && !t.channelIds.includes(msg.channelId)) return false;
      const c = msg.content.toLowerCase(); const p = t.pattern.toLowerCase();
      if (t.match === "any") return true;
      if (t.match === "contains") return !!p && c.includes(p);
      if (t.match === "starts_with") return !!p && c.startsWith(p);
      if (t.match === "exact") return c.trim() === p.trim();
      try { return new RegExp(t.pattern, "i").test(msg.content); } catch { return false; }
    }
    case "reaction_add": return (!t.emoji || t.emoji === ctx.emoji) && (!t.messageId || t.messageId === ctx.message?.id) && (!t.channelIds.length || (!!chId && t.channelIds.includes(chId)));
    case "role_added": case "role_removed": return t.roleId === ctx.roleId;
    case "voice_join": case "voice_leave": return !t.channelIds.length || (!!chId && t.channelIds.includes(chId));
    case "level_up": return t.level === undefined || t.level === ctx.level;
    case "message_delete": return !t.channelIds.length || (!!chId && t.channelIds.includes(chId));
    case "thread_create": return !t.channelIds.length || (!!ctx.parentId && t.channelIds.includes(ctx.parentId));
    default: return true;
  }
}

function checkCondition(c: AutomationCondition, guild: Guild, ctx: RunContext): boolean {
  const m = ctx.member;
  const chId = ctx.channel && "id" in ctx.channel ? ctx.channel.id : ctx.message?.channelId;
  switch (c.type) {
    case "has_role": return !!m?.roles.cache.has(c.roleId);
    case "missing_role": return !!m && !m.roles.cache.has(c.roleId);
    case "in_channel": return !!chId && c.channelIds.includes(chId);
    case "account_age_days": { const u = m?.user ?? ctx.user; if (!u) return false; const d = (Date.now() - u.createdTimestamp) / 86_400_000; return c.op === "gt" ? d > c.days : d < c.days; }
    case "message_matches": try { return !!ctx.message && new RegExp(c.regex, "i").test(ctx.message.content); } catch { return false; }
    case "chance": return Math.random() * 100 < c.percent;
    case "is_bot": return !!(m?.user ?? ctx.user)?.bot === c.value;
    case "member_count": return c.op === "gt" ? guild.memberCount > c.value : guild.memberCount < c.value;
    case "level_at_least": return (ctx.level ?? 0) >= c.level;
    case "has_any_role": return !!m && c.roleIds.some((r) => m.roles.cache.has(r));
    case "joined_days": { if (!m?.joinedTimestamp) return false; const d = (Date.now() - m.joinedTimestamp) / 86_400_000; return c.op === "gt" ? d > c.days : d < c.days; }
    case "time_between": { const h = zoned(ctx.timezone).hour; return c.from <= c.to ? h >= c.from && h < c.to : h >= c.from || h < c.to; }
    case "weekday": return c.days.includes(zoned(ctx.timezone).weekday);
    case "invite_code": return !!ctx.invite && c.codes.some((x) => x.toLowerCase() === ctx.invite!.code.toLowerCase());
  }
}

function zoned(tz = "UTC"): { hour: number; weekday: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23", weekday: "short" }).formatToParts(new Date());
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
    const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.find((p) => p.type === "weekday")?.value ?? "Sun");
    return { hour: hour % 24, weekday: Math.max(0, wd) };
  } catch { const d = new Date(); return { hour: d.getUTCHours(), weekday: d.getUTCDay() }; }
}

/** Blocks webhooks to local/private networks (the bot runs next to the database). */
function safeWebhookUrl(raw: string): URL {
  const u = new URL(raw);
  if (u.protocol !== "https:") throw new Error("Webhooks must use https://");
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const privateV4 = /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;
  if (!h.includes(".") || h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".localhost") || privateV4.test(h) || h.includes(":")) throw new Error("Webhook host is not allowed");
  return u;
}

async function lockChannel(guild: Guild, id: string | undefined, ctx: RunContext, lock: boolean) {
  const ch = id ? guild.channels.cache.get(id) : ctx.message?.channel ?? (ctx.channel && "id" in ctx.channel ? guild.channels.cache.get(ctx.channel.id) : undefined);
  if (!ch || ch.isThread() || !("permissionOverwrites" in ch)) throw new Error("Channel not found");
  await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: lock ? false : null, SendMessagesInThreads: lock ? false : null, AddReactions: lock ? false : null, Connect: ch.isVoiceBased() ? (lock ? false : null) : undefined }, { reason: "MOTH automation" });
}

async function sendable(guild: Guild, id: string | undefined, ctx: RunContext): Promise<(TextBasedChannel & { send: Function }) | null> {
  const ch = id ? guild.channels.cache.get(id) ?? await guild.channels.fetch(id).catch(() => null) : ctx.message?.channel ?? (ctx.channel && "send" in ctx.channel ? ctx.channel : null);
  return ch && "send" in ch && (ch as TextBasedChannel).isTextBased() ? ch as TextBasedChannel & { send: Function } : null;
}

async function runAction(a: AutomationAction, guild: Guild, ctx: RunContext, name: string): Promise<string> {
  const tctx = templateContext({ member: ctx.member, user: ctx.user, guild, channel: ctx.channel && "name" in ctx.channel ? { id: ctx.channel.id, name: String(ctx.channel.name) } : null, vars: {
    level: ctx.level, message: (ctx.message?.content ?? ctx.text ?? "").slice(0, 1500), automation: name,
    invite: ctx.invite?.code ?? "", inviter: ctx.invite?.inviterId ? `<@${ctx.invite.inviterId}>` : "",
  } });
  const roles = (t: { content?: string; embed?: { description?: string } }) => /<@&\d+>/.test(`${t.content ?? ""} ${t.embed?.description ?? ""}`);
  if (ctx.dryRun) return `would ${a.type}`;
  switch (a.type) {
    case "send_message": { const ch = await sendable(guild, a.channelId, ctx); if (!ch) throw new Error("Target channel not found"); await ch.send(messagePayload(a.message, tctx, roles(a.message))); return "sent"; }
    case "send_dm": { const u = ctx.member?.user ?? ctx.user; await u?.send(messagePayload(a.message, tctx)).catch(() => undefined); return "dm"; }
    case "reply": { if (!ctx.message) throw new Error("No message to reply to"); await ctx.message.reply(messagePayload(a.message, tctx)); return "replied"; }
    case "add_role": { await ctx.member?.roles.add(a.roleId, "MOTH automation"); return "role added"; }
    case "remove_role": { await ctx.member?.roles.remove(a.roleId, "MOTH automation"); return "role removed"; }
    case "react": { await ctx.message?.react(a.emoji); return "reacted"; }
    case "delete_message": { await ctx.message?.delete(); return "deleted"; }
    case "timeout": { await ctx.member?.timeout(a.minutes * 60_000, a.reason); return "timed out"; }
    case "set_nickname": { await ctx.member?.setNickname(a.nickname.replace("{user.name}", ctx.member.user.username).slice(0, 32), "MOTH automation"); return "nick"; }
    case "create_thread": { if (ctx.message && ctx.message.channel.type === ChannelType.GuildText) await ctx.message.startThread({ name: a.name.slice(0, 100) }); return "thread"; }
    case "log": { await sendLog(guild, "general", brandEmbed("Automation log", a.message.slice(0, 4000), BRAND.info)); return "logged"; }
    case "set_channel_name": { const ch = guild.channels.cache.get(a.channelId); const name = a.name.replace("{server.members}", String(guild.memberCount)); if (ch && "setName" in ch) await ch.setName(name.slice(0, 100)); return "renamed"; }
    case "add_xp": { if (ctx.member) await addXp(ctx.member, a.amount, null); return "xp"; }
    case "add_currency": { if (ctx.member) await addCurrency(guild.id, ctx.member.id, a.amount); return "currency"; }
    case "toggle_role": { if (!ctx.member) return "no member"; const has = ctx.member.roles.cache.has(a.roleId); await (has ? ctx.member.roles.remove(a.roleId, "MOTH automation") : ctx.member.roles.add(a.roleId, "MOTH automation")); return has ? "role removed" : "role added"; }
    case "kick": { if (!ctx.member?.kickable) throw new Error("Member can't be kicked"); await ctx.member.kick(a.reason); return "kicked"; }
    case "ban": { const id = ctx.member?.id ?? ctx.user?.id; if (!id) throw new Error("No member"); if (ctx.member && !ctx.member.bannable) throw new Error("Member can't be banned"); await guild.members.ban(id, { reason: a.reason, deleteMessageSeconds: a.deleteMessageSeconds }); return "banned"; }
    case "pin_message": { await ctx.message?.pin("MOTH automation"); return "pinned"; }
    case "publish_message": { if (ctx.message?.crosspostable) await ctx.message.crosspost(); return "published"; }
    case "lock_channel": await lockChannel(guild, a.channelId, ctx, true); return "locked";
    case "unlock_channel": await lockChannel(guild, a.channelId, ctx, false); return "unlocked";
    case "slowmode": { const ch = a.channelId ? guild.channels.cache.get(a.channelId) : ctx.message?.channel; if (!ch || !("setRateLimitPerUser" in ch)) throw new Error("Channel not found"); await ch.setRateLimitPerUser(a.seconds, "MOTH automation"); return `slowmode ${a.seconds}s`; }
    case "move_voice": { if (!ctx.member?.voice.channelId) return "not in voice"; await ctx.member.voice.setChannel(a.channelId, "MOTH automation"); return "moved"; }
    case "disconnect_voice": { if (ctx.member?.voice.channelId) await ctx.member.voice.disconnect("MOTH automation"); return "disconnected"; }
    case "random_message": { const ch = await sendable(guild, a.channelId, ctx); if (!ch) throw new Error("Target channel not found"); const pick = a.messages[Math.floor(Math.random() * a.messages.length)]; await ch.send(messagePayload({ content: pick }, tctx, roles({ content: pick }))); return "sent"; }
    case "webhook": {
      const url = safeWebhookUrl(a.url);
      const body = renderTemplate(a.body, tctx);
      let json = false; try { JSON.parse(body); json = true; } catch { /* plain text */ }
      const res = await fetch(url, { method: "POST", headers: { "content-type": json ? "application/json" : "text/plain", "user-agent": "MOTH-Automation" }, body, redirect: "error", signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`Webhook responded ${res.status}`);
      return `webhook ${res.status}`;
    }
  }
}

/** Executes a single automation. Returns a run log (also used for dashboard testing). */
export async function runAutomation(row: Pick<Row, "id" | "def" | "guildId" | "name">, guild: Guild, ctx: RunContext, triggerName: string, startAt = 0): Promise<{ status: "success" | "skipped" | "failed"; log: string[]; error?: string }> {
  const started = Date.now();
  const logs: string[] = [];
  let status: "success" | "skipped" | "failed" = "success";
  let error: string | undefined;
  ctx.timezone ??= (await getGuildConfig(guild.id).catch(() => null))?.general.timezone ?? "UTC";
  try {
    for (let idx = startAt; idx < row.def.steps.length; idx++) {
      const step = row.def.steps[idx];
      if (step.kind === "condition") {
        const pass = checkCondition(step.condition, guild, ctx) !== step.negate;
        logs.push(`condition ${step.condition.type}${step.negate ? " (negated)" : ""}: ${pass ? "pass" : "fail"}`);
        if (!pass) { status = "skipped"; break; }
      } else if (step.kind === "delay") {
        logs.push(`delay ${step.seconds}s`);
        if (ctx.dryRun) continue;
        if (step.seconds > 60 && idx < row.def.steps.length - 1) {
          // Long waits are stored in the database so they survive restarts.
          await getDb().insert(scheduledJobs).values({ guildId: guild.id, kind: "automation-resume", runAt: new Date(Date.now() + step.seconds * 1000), payload: { automationId: row.id, step: idx + 1, ctx: serialiseCtx(ctx) } });
          logs.push("continues later");
          break;
        }
        await new Promise((r) => setTimeout(r, step.seconds * 1000));
      } else {
        logs.push(`${step.action.type}: ${await runAction(step.action, guild, ctx, row.name)}`);
      }
    }
  } catch (err) {
    status = "failed"; error = (err as Error).message; logs.push(`error: ${error}`);
  }
  if (!ctx.dryRun) {
    const db = getDb();
    await db.insert(automationRuns).values({ automationId: row.id, guildId: row.guildId, status, trigger: triggerName, durationMs: Date.now() - started, error: error ?? null }).catch(() => undefined);
    await db.update(automations).set({ runCount: sql`${automations.runCount} + 1`, failCount: status === "failed" ? sql`${automations.failCount} + 1` : automations.failCount, lastRunAt: new Date() }).where(eq(automations.id, row.id)).catch(() => undefined);
  }
  return { status, log: logs, error };
}

type SerialCtx = { memberId?: string; userId?: string; channelId?: string; messageId?: string; emoji?: string; roleId?: string; level?: number; text?: string; parentId?: string | null; invite?: RunContext["invite"] };
function serialiseCtx(c: RunContext): SerialCtx {
  return {
    memberId: c.member?.id, userId: c.user?.id ?? c.member?.id, channelId: c.message?.channelId ?? (c.channel && "id" in c.channel ? c.channel.id : undefined),
    messageId: c.message?.id, emoji: c.emoji, roleId: c.roleId, level: c.level, text: c.text ?? c.message?.content?.slice(0, 1500), parentId: c.parentId, invite: c.invite,
  };
}

/** Continues an automation after a long (database-stored) delay. */
export async function resumeAutomation(guild: Guild, payload: { automationId: string; step: number; ctx: SerialCtx }): Promise<void> {
  const rows = await load(guild.id);
  const row = rows.find((r) => r.id === payload.automationId);
  if (!row || !row.enabled) return;
  const c = payload.ctx;
  const member = c.memberId ? await guild.members.fetch(c.memberId).catch(() => null) : null;
  const user = c.userId ? await guild.client.users.fetch(c.userId).catch(() => null) : null;
  const channel = c.channelId ? guild.channels.cache.get(c.channelId) ?? null : null;
  const message = c.messageId && channel?.isTextBased() ? await channel.messages.fetch(c.messageId).catch(() => null) : null;
  await runAutomation(row, guild, { member, user, channel: channel?.isTextBased() ? channel : null, message: message?.inGuild() ? message : null, emoji: c.emoji, roleId: c.roleId, level: c.level, text: c.text, parentId: c.parentId, invite: c.invite }, "resume", payload.step);
}

export async function fireAutomations(guild: Guild, type: AutomationTrigger["type"], ctx: RunContext): Promise<void> {
  try {
    const rows = await load(guild.id);
    for (const row of rows) {
      if (!row.enabled || !triggerMatches(row.def.trigger, type, ctx)) continue;
      if (row.def.cooldownSeconds) {
        const key = `${row.id}:${ctx.member?.id ?? ctx.user?.id ?? "guild"}`;
        if ((cooldowns.get(key) ?? 0) > Date.now()) continue;
        cooldowns.set(key, Date.now() + row.def.cooldownSeconds * 1000);
      }
      void runAutomation(row, guild, ctx, type);
    }
  } catch (err) { log.warn({ err, guild: guild.id }, "automation dispatch failed"); }
}

async function scheduleGuild(guildId: string) {
  for (const [k, c] of crons) if (k.startsWith(`${guildId}:`)) { c.stop(); crons.delete(k); }
  const rows = await load(guildId);
  for (const row of rows) {
    if (!row.enabled || row.def.trigger.type !== "schedule") continue;
    const t = row.def.trigger;
    try {
      crons.set(`${guildId}:${row.id}`, new Cron(t.cron, { timezone: t.timezone, protect: true }, () => {
        const guild = runtime.client?.guilds.cache.get(guildId);
        if (guild) void runAutomation(row, guild, {}, "schedule");
      }));
    } catch (err) { log.warn({ err, automation: row.id }, "invalid cron expression"); }
  }
}

export async function startScheduledAutomations(guildIds: string[]) {
  for (const id of guildIds) await scheduleGuild(id).catch(() => undefined);
}

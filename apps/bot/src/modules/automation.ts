import { ChannelType, type Guild, type GuildMember, type Message, type TextBasedChannel, type User } from "discord.js";
import { Cron } from "croner";
import { eq, sql } from "drizzle-orm";
import {
  automationRuns, automations, automationSchema, getDb, type AutomationAction, type AutomationCondition, type AutomationDefinition, type AutomationTrigger,
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
  dryRun?: boolean;
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
      if (!msg || (t.ignoreBots && msg.author.bot)) return false;
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
  }
}

async function sendable(guild: Guild, id: string | undefined, ctx: RunContext): Promise<(TextBasedChannel & { send: Function }) | null> {
  const ch = id ? guild.channels.cache.get(id) ?? await guild.channels.fetch(id).catch(() => null) : ctx.message?.channel ?? (ctx.channel && "send" in ctx.channel ? ctx.channel : null);
  return ch && "send" in ch && (ch as TextBasedChannel).isTextBased() ? ch as TextBasedChannel & { send: Function } : null;
}

async function runAction(a: AutomationAction, guild: Guild, ctx: RunContext): Promise<string> {
  const tctx = templateContext({ member: ctx.member, user: ctx.user, guild, channel: ctx.channel && "name" in ctx.channel ? { id: ctx.channel.id, name: String(ctx.channel.name) } : null, vars: { level: ctx.level } });
  if (ctx.dryRun) return `would ${a.type}`;
  switch (a.type) {
    case "send_message": { const ch = await sendable(guild, a.channelId, ctx); if (!ch) throw new Error("Target channel not found"); await ch.send(messagePayload(a.message, tctx)); return "sent"; }
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
  }
}

/** Executes a single automation. Returns a run log (also used for dashboard testing). */
export async function runAutomation(row: Pick<Row, "id" | "def" | "guildId" | "name">, guild: Guild, ctx: RunContext, triggerName: string): Promise<{ status: "success" | "skipped" | "failed"; log: string[]; error?: string }> {
  const started = Date.now();
  const logs: string[] = [];
  let status: "success" | "skipped" | "failed" = "success";
  let error: string | undefined;
  try {
    for (const step of row.def.steps) {
      if (step.kind === "condition") {
        const pass = checkCondition(step.condition, guild, ctx) !== step.negate;
        logs.push(`condition ${step.condition.type}${step.negate ? " (negated)" : ""}: ${pass ? "pass" : "fail"}`);
        if (!pass) { status = "skipped"; break; }
      } else if (step.kind === "delay") {
        logs.push(`delay ${step.seconds}s`);
        if (!ctx.dryRun) await new Promise((r) => setTimeout(r, Math.min(step.seconds, 900) * 1000));
      } else {
        logs.push(`${step.action.type}: ${await runAction(step.action, guild, ctx)}`);
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

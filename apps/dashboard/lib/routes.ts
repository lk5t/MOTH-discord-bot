import "server-only";
import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import {
  aiProviders, aiUsage, analyticsHourly, appeals, architectSessions, automationRuns, automations, automationSchema, blueprints, BUILTIN_TEMPLATES,
  builtinTemplate, changeLog, channelActivity, commandExportSchema, commandNameSchema, configBackups, customCommands, customCommandSchema,
  dashboardAccess, encryptSecret, getDb, getGuildConfigWithVersion, guildConfigSchema, guildConfigSections, guildState, maskSecret, memberLevels,
  economyAccounts, modCases, publishEvent, renderMessage, roleMenus, securityEvents, ticketPanels, tickets, ticketTranscripts, updateGuildConfig,
  userAchievements, logChange, blueprintSchema, messageTemplateSchema, embedSchema, type GuildConfigSection,
  buildRecipe, suggestions, memberInvites, starboardPosts, tempVoiceChannels, memberBackups, guilds,
} from "@moth/core";
import { ApiError, body, json, requireLevel, type GuildCtx } from "./api";
import { bot } from "./bot";
import { invalidateAccess, isPlatformOwner } from "./access";

type Handler = (ctx: GuildCtx) => Promise<Response>;
type Route = { method: string; path: string; handler: Handler };
const routes: Route[] = [];
const r = (method: string, path: string, handler: Handler) => routes.push({ method, path, handler });

/** Matches "a/:id/b" against params array; returns named params. */
export function matchRoute(method: string, parts: string[]): { handler: Handler; named: Record<string, string> } | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    const segs = route.path.split("/");
    if (segs.length !== parts.length) continue;
    const named: Record<string, string> = {};
    if (segs.every((s, i) => (s.startsWith(":") ? ((named[s.slice(1)] = decodeURIComponent(parts[i])), true) : s === parts[i]))) return { handler: route.handler, named };
  }
  return null;
}
const db = () => getDb();
const audit = (ctx: GuildCtx, action: string, target?: string, after?: unknown, before?: unknown) =>
  logChange({ guildId: ctx.guildId, actorId: ctx.userId, source: "dashboard", action, target, after: after as never, before: before as never });

// ───────── Overview & Discord data ─────────
r("GET", "overview", async (ctx) => {
  const g = ctx.guildId;
  const since = new Date(Date.now() - 7 * 86_400_000);
  const [live, [stats], [cases], [openTickets], recentCases, recentSecurity, [state]] = await Promise.all([
    bot(`/guilds/${g}/overview`).catch(() => null),
    db().select({ messages: sql<number>`coalesce(sum(messages),0)`, joins: sql<number>`coalesce(sum(joins),0)`, leaves: sql<number>`coalesce(sum(leaves),0)` }).from(analyticsHourly).where(and(eq(analyticsHourly.guildId, g), gte(analyticsHourly.hour, since))),
    db().select({ n: sql<number>`count(*)` }).from(modCases).where(and(eq(modCases.guildId, g), gte(modCases.createdAt, since))),
    db().select({ n: sql<number>`count(*)` }).from(tickets).where(and(eq(tickets.guildId, g), eq(tickets.status, "open"))),
    db().select().from(modCases).where(eq(modCases.guildId, g)).orderBy(desc(modCases.createdAt)).limit(6),
    db().select().from(securityEvents).where(eq(securityEvents.guildId, g)).orderBy(desc(securityEvents.createdAt)).limit(6),
    db().select().from(guildState).where(eq(guildState.guildId, g)),
  ]);
  const hourly = await db().select().from(analyticsHourly).where(and(eq(analyticsHourly.guildId, g), gte(analyticsHourly.hour, new Date(Date.now() - 48 * 3_600_000)))).orderBy(asc(analyticsHourly.hour));
  return json({ live, week: { ...stats, cases: Number(cases.n) }, openTickets: Number(openTickets.n), recentCases, recentSecurity, state: state ?? null, hourly });
});
r("GET", "discord/channels", async (ctx) => json(await bot(`/guilds/${ctx.guildId}/channels`)));
r("GET", "discord/roles", async (ctx) => json(await bot(`/guilds/${ctx.guildId}/roles`)));
r("POST", "discord/messages", async (ctx) => {
  requireLevel(ctx, "admin");
  const b = await body(ctx.req, z.object({ channelId: z.string(), message: messageTemplateSchema }));
  const out = await bot(`/guilds/${ctx.guildId}/messages`, { body: b });
  await audit(ctx, "message.send", b.channelId);
  return json(out);
});

// ───────── Configuration ─────────
r("GET", "config", async (ctx) => json(await getGuildConfigWithVersion(ctx.guildId)));
const SECTION_LEVEL: Partial<Record<GuildConfigSection, "moderator" | "admin">> = {};
r("PATCH", "config", async (ctx) => {
  const b = await body(ctx.req, z.object({ patch: z.record(z.string(), z.unknown()), version: z.number().int().optional() }));
  for (const k of Object.keys(b.patch)) {
    if (!guildConfigSections.includes(k as GuildConfigSection)) throw new ApiError(400, `Unknown section ${k}`);
    requireLevel(ctx, SECTION_LEVEL[k as GuildConfigSection] ?? "admin");
    const shape = guildConfigSchema.shape[k as GuildConfigSection];
    const v = shape.safeParse(b.patch[k]);
    if (!v.success) throw new ApiError(400, `${k}: ${v.error.issues.slice(0, 4).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const out = await updateGuildConfig(ctx.guildId, b.patch, { actorId: ctx.userId, source: "dashboard", expectedVersion: b.version });
  if (b.patch.dashboard || b.patch.moderation) invalidateAccess(ctx.guildId);
  return json(out);
});
r("POST", "preview/message", async (ctx) => {
  const b = await body(ctx.req, z.object({ message: messageTemplateSchema, args: z.record(z.string(), z.string()).optional() }));
  return json(renderMessage(b.message, { user: { id: ctx.userId, username: ctx.session.user.username, displayName: ctx.session.user.globalName ?? ctx.session.user.username, createdAt: new Date() }, server: { id: ctx.guildId, name: "Your Server", memberCount: 1234 }, channel: { id: "0", name: "general" }, args: b.args, vars: { level: 12, xp: 3456, balance: 789 } }));
});

// ───────── Moderation ─────────
r("GET", "cases", async (ctx) => {
  requireLevel(ctx, "moderator");
  const user = ctx.query.get("user"); const type = ctx.query.get("type"); const page = Math.max(0, Number(ctx.query.get("page") ?? 0));
  const where = and(eq(modCases.guildId, ctx.guildId), user ? eq(modCases.targetId, user) : undefined, type ? eq(modCases.type, type as never) : undefined);
  const [rows, [{ n }]] = await Promise.all([
    db().select().from(modCases).where(where).orderBy(desc(modCases.createdAt)).limit(50).offset(page * 50),
    db().select({ n: sql<number>`count(*)` }).from(modCases).where(where),
  ]);
  return json({ rows, total: Number(n) });
});
r("PATCH", "cases/:number", async (ctx) => {
  requireLevel(ctx, "moderator");
  const b = await body(ctx.req, z.object({ reason: z.string().max(500).optional(), active: z.boolean().optional() }));
  const [row] = await db().update(modCases).set(b).where(and(eq(modCases.guildId, ctx.guildId), eq(modCases.caseNumber, Number(ctx.p.number)))).returning();
  if (!row) throw new ApiError(404, "Case not found");
  await audit(ctx, "case.update", `#${ctx.p.number}`, b);
  return json(row);
});
r("POST", "moderation/action", async (ctx) => {
  requireLevel(ctx, "moderator");
  const b = await body(ctx.req, z.object({ type: z.enum(["warn", "timeout", "untimeout", "kick", "ban", "unban", "note"]), userId: z.string(), reason: z.string().max(500).optional(), durationMs: z.number().int().positive().optional() }));
  if (["ban", "unban"].includes(b.type)) requireLevel(ctx, "moderator");
  return json(await bot(`/guilds/${ctx.guildId}/moderation`, { body: { ...b, actorId: ctx.userId } }));
});
r("GET", "moderation/stats", async (ctx) => {
  requireLevel(ctx, "moderator");
  const since = new Date(Date.now() - 30 * 86_400_000);
  const [byType, byDay, topMods, [auto]] = await Promise.all([
    db().select({ type: modCases.type, n: sql<number>`count(*)` }).from(modCases).where(and(eq(modCases.guildId, ctx.guildId), gte(modCases.createdAt, since))).groupBy(modCases.type),
    db().select({ day: sql<string>`date_trunc('day', ${modCases.createdAt})`, n: sql<number>`count(*)` }).from(modCases).where(and(eq(modCases.guildId, ctx.guildId), gte(modCases.createdAt, since))).groupBy(sql`1`).orderBy(sql`1`),
    db().select({ moderatorId: modCases.moderatorId, n: sql<number>`count(*)` }).from(modCases).where(and(eq(modCases.guildId, ctx.guildId), eq(modCases.automated, false), gte(modCases.createdAt, since))).groupBy(modCases.moderatorId).orderBy(desc(sql`2`)).limit(8),
    db().select({ n: sql<number>`count(*) filter (where automated)`, total: sql<number>`count(*)` }).from(modCases).where(and(eq(modCases.guildId, ctx.guildId), gte(modCases.createdAt, since))),
  ]);
  return json({ byType, byDay, topMods, automated: Number(auto.n), total: Number(auto.total) });
});
r("GET", "appeals", async (ctx) => {
  requireLevel(ctx, "moderator");
  return json(await db().select().from(appeals).where(eq(appeals.guildId, ctx.guildId)).orderBy(desc(appeals.createdAt)).limit(100));
});
r("POST", "appeals/:id", async (ctx) => {
  requireLevel(ctx, "moderator");
  const b = await body(ctx.req, z.object({ decision: z.enum(["accepted", "denied"]), response: z.string().max(1000).optional() }));
  const [a] = await db().select().from(appeals).where(and(eq(appeals.id, Number(ctx.p.id)), eq(appeals.guildId, ctx.guildId)));
  if (!a || a.status !== "pending") throw new ApiError(409, "Appeal already reviewed");
  if (b.decision === "accepted") await bot(`/guilds/${ctx.guildId}/moderation`, { body: { type: "unban", userId: a.userId, reason: `Appeal #${a.id} accepted`, actorId: ctx.userId } }).catch(() => undefined);
  await db().update(appeals).set({ status: b.decision, response: b.response, reviewerId: ctx.userId, reviewedAt: new Date() }).where(eq(appeals.id, a.id));
  await audit(ctx, `appeal.${b.decision}`, String(a.id));
  return json({ ok: true });
});

// ───────── Security ─────────
r("GET", "security", async (ctx) => {
  requireLevel(ctx, "moderator");
  const since = new Date(Date.now() - 30 * 86_400_000);
  const [events, [state], byType] = await Promise.all([
    db().select().from(securityEvents).where(eq(securityEvents.guildId, ctx.guildId)).orderBy(desc(securityEvents.createdAt)).limit(100),
    db().select().from(guildState).where(eq(guildState.guildId, ctx.guildId)),
    db().select({ type: securityEvents.type, n: sql<number>`count(*)` }).from(securityEvents).where(and(eq(securityEvents.guildId, ctx.guildId), gte(securityEvents.createdAt, since))).groupBy(securityEvents.type),
  ]);
  return json({ events, state: state ?? null, byType });
});
r("POST", "security/lockdown", async (ctx) => { requireLevel(ctx, "admin"); const b = await body(ctx.req, z.object({ enable: z.boolean() })); const out = await bot(`/guilds/${ctx.guildId}/lockdown`, { body: { ...b, actorId: ctx.userId }, timeoutMs: 120_000 }); await audit(ctx, b.enable ? "lockdown.on" : "lockdown.off"); return json(out); });
r("POST", "security/raid-mode", async (ctx) => { requireLevel(ctx, "admin"); const b = await body(ctx.req, z.object({ enable: z.boolean() })); const out = await bot(`/guilds/${ctx.guildId}/raid-mode`, { body: { ...b, actorId: ctx.userId }, timeoutMs: 120_000 }); await audit(ctx, b.enable ? "raid.on" : "raid.off"); return json(out); });

// ───────── Tickets ─────────
r("GET", "tickets", async (ctx) => {
  requireLevel(ctx, "moderator");
  const status = ctx.query.get("status");
  const [rows, [stats], byCategory] = await Promise.all([
    db().select().from(tickets).where(and(eq(tickets.guildId, ctx.guildId), status ? eq(tickets.status, status as never) : undefined)).orderBy(desc(tickets.createdAt)).limit(100),
    db().select({
      open: sql<number>`count(*) filter (where status = 'open')`, closed: sql<number>`count(*) filter (where status <> 'open')`, total: sql<number>`count(*)`,
      week: sql<number>`count(*) filter (where created_at > now() - interval '7 days')`,
      avgFirst: sql<number>`coalesce(avg(extract(epoch from (first_response_at - created_at))) filter (where first_response_at is not null), 0)`,
      avgResolve: sql<number>`coalesce(avg(extract(epoch from (closed_at - created_at))) filter (where closed_at is not null), 0)`,
      urgent: sql<number>`count(*) filter (where status = 'open' and priority in ('high','urgent'))`,
    }).from(tickets).where(eq(tickets.guildId, ctx.guildId)),
    db().select({ label: tickets.categoryLabel, n: sql<number>`count(*)` }).from(tickets).where(eq(tickets.guildId, ctx.guildId)).groupBy(tickets.categoryLabel),
  ]);
  return json({ rows, stats, byCategory });
});
r("GET", "tickets/:id", async (ctx) => {
  requireLevel(ctx, "moderator");
  const [t] = await db().select().from(tickets).where(and(eq(tickets.id, ctx.p.id), eq(tickets.guildId, ctx.guildId)));
  if (!t) throw new ApiError(404, "Ticket not found");
  const [tr] = await db().select().from(ticketTranscripts).where(eq(ticketTranscripts.ticketId, t.id)).orderBy(desc(ticketTranscripts.createdAt)).limit(1);
  return json({ ticket: t, transcript: tr ? { html: tr.html, messageCount: tr.messageCount, createdAt: tr.createdAt } : null });
});
r("POST", "tickets/:id/close", async (ctx) => { requireLevel(ctx, "moderator"); const b = await body(ctx.req, z.object({ reason: z.string().max(300).optional() })); return json(await bot(`/guilds/${ctx.guildId}/tickets/${ctx.p.id}/close`, { body: { ...b, actorId: ctx.userId }, timeoutMs: 90_000 })); });
r("POST", "tickets/:id/reopen", async (ctx) => { requireLevel(ctx, "moderator"); return json(await bot(`/guilds/${ctx.guildId}/tickets/${ctx.p.id}/reopen`, { body: { actorId: ctx.userId } })); });
r("PATCH", "tickets/:id", async (ctx) => {
  requireLevel(ctx, "moderator");
  const b = await body(ctx.req, z.object({ priority: z.enum(["low", "normal", "high", "urgent"]).optional(), claimedById: z.string().nullable().optional(), assigneeIds: z.array(z.string()).optional() }));
  const [t] = await db().update(tickets).set(b).where(and(eq(tickets.id, ctx.p.id), eq(tickets.guildId, ctx.guildId))).returning();
  await publishEvent("ticket.updated", ctx.guildId, { id: ctx.p.id, ...b }, "dashboard");
  return json(t);
});
const panelSchema = z.object({
  name: z.string().min(1).max(100), channelId: z.string().nullable(), style: z.enum(["buttons", "select"]), embed: embedSchema,
  staffRoleIds: z.array(z.string()).default([]), parentCategoryId: z.string().nullable().default(null), enabled: z.boolean().default(true),
  categories: z.array(z.object({ id: z.string().min(1).max(40), label: z.string().min(1).max(80), emoji: z.string().max(60).optional(), description: z.string().max(100).optional(), parentCategoryId: z.string().nullable().optional(), staffRoleIds: z.array(z.string()).default([]), openMessage: z.string().max(2000).optional(), defaultPriority: z.enum(["low", "normal", "high", "urgent"]).optional(), questions: z.array(z.object({ label: z.string().min(1).max(45), placeholder: z.string().max(100).optional(), required: z.boolean().optional(), long: z.boolean().optional() })).max(5).optional() })).min(1).max(25),
});
r("GET", "ticket-panels", async (ctx) => { requireLevel(ctx, "moderator"); return json(await db().select().from(ticketPanels).where(eq(ticketPanels.guildId, ctx.guildId)).orderBy(asc(ticketPanels.createdAt))); });
r("POST", "ticket-panels", async (ctx) => { requireLevel(ctx, "admin"); const b = await body(ctx.req, panelSchema); const [row] = await db().insert(ticketPanels).values({ ...b, guildId: ctx.guildId }).returning(); await audit(ctx, "ticketpanel.create", row.id, b); return json(row); });
r("PATCH", "ticket-panels/:id", async (ctx) => { requireLevel(ctx, "admin"); const b = await body(ctx.req, panelSchema.partial()); const [row] = await db().update(ticketPanels).set({ ...b, updatedAt: new Date() }).where(and(eq(ticketPanels.id, ctx.p.id), eq(ticketPanels.guildId, ctx.guildId))).returning(); await audit(ctx, "ticketpanel.update", ctx.p.id, b); return json(row); });
r("DELETE", "ticket-panels/:id", async (ctx) => { requireLevel(ctx, "admin"); await db().delete(ticketPanels).where(and(eq(ticketPanels.id, ctx.p.id), eq(ticketPanels.guildId, ctx.guildId))); await audit(ctx, "ticketpanel.delete", ctx.p.id); return json({ ok: true }); });
r("POST", "ticket-panels/:id/publish", async (ctx) => { requireLevel(ctx, "admin"); return json(await bot(`/guilds/${ctx.guildId}/ticket-panels/${ctx.p.id}/publish`, { body: {} })); });

// ───────── Role menus ─────────
const menuSchema = z.object({ name: z.string().min(1).max(100), channelId: z.string().nullable(), style: z.enum(["reactions", "buttons", "select"]), mode: z.enum(["toggle", "unique", "add-only", "remove-only"]), embed: embedSchema, options: z.array(z.object({ roleId: z.string(), label: z.string().min(1).max(80), emoji: z.string().max(60).optional(), description: z.string().max(100).optional() })).min(1).max(25), maxSelections: z.number().int().min(1).max(25).nullable().optional(), requiredRoleIds: z.array(z.string()).default([]) });
r("GET", "role-menus", async (ctx) => { requireLevel(ctx, "admin"); return json(await db().select().from(roleMenus).where(eq(roleMenus.guildId, ctx.guildId)).orderBy(asc(roleMenus.createdAt))); });
r("POST", "role-menus", async (ctx) => { requireLevel(ctx, "admin"); const b = await body(ctx.req, menuSchema); const [row] = await db().insert(roleMenus).values({ ...b, guildId: ctx.guildId }).returning(); await audit(ctx, "rolemenu.create", row.id, b); return json(row); });
r("PATCH", "role-menus/:id", async (ctx) => { requireLevel(ctx, "admin"); const b = await body(ctx.req, menuSchema.partial()); const [row] = await db().update(roleMenus).set({ ...b, updatedAt: new Date() }).where(and(eq(roleMenus.id, ctx.p.id), eq(roleMenus.guildId, ctx.guildId))).returning(); return json(row); });
r("DELETE", "role-menus/:id", async (ctx) => { requireLevel(ctx, "admin"); await db().delete(roleMenus).where(and(eq(roleMenus.id, ctx.p.id), eq(roleMenus.guildId, ctx.guildId))); return json({ ok: true }); });
r("POST", "role-menus/:id/publish", async (ctx) => { requireLevel(ctx, "admin"); return json(await bot(`/guilds/${ctx.guildId}/role-menus/${ctx.p.id}/publish`, { body: {} })); });
r("POST", "verification/publish", async (ctx) => { requireLevel(ctx, "admin"); return json(await bot(`/guilds/${ctx.guildId}/verification/publish`, { body: {} })); });

// ───────── Automations ─────────
const autoBody = z.object({ name: z.string().min(1).max(100), description: z.string().max(500).optional().nullable(), enabled: z.boolean().default(true), definition: automationSchema });
r("GET", "automations", async (ctx) => {
  requireLevel(ctx, "admin");
  const [rows, runs] = await Promise.all([
    db().select().from(automations).where(eq(automations.guildId, ctx.guildId)).orderBy(asc(automations.createdAt)),
    db().select().from(automationRuns).where(eq(automationRuns.guildId, ctx.guildId)).orderBy(desc(automationRuns.createdAt)).limit(50),
  ]);
  return json({ rows, runs });
});
r("POST", "automations", async (ctx) => { requireLevel(ctx, "admin"); const b = await body(ctx.req, autoBody); const [row] = await db().insert(automations).values({ ...b, guildId: ctx.guildId, createdBy: ctx.userId }).returning(); await publishEvent("automations.updated", ctx.guildId, {}, "dashboard"); await audit(ctx, "automation.create", row.id, b); return json(row); });
r("PATCH", "automations/:id", async (ctx) => { requireLevel(ctx, "admin"); const b = await body(ctx.req, autoBody.partial()); const [row] = await db().update(automations).set({ ...b, updatedAt: new Date() }).where(and(eq(automations.id, ctx.p.id), eq(automations.guildId, ctx.guildId))).returning(); await publishEvent("automations.updated", ctx.guildId, {}, "dashboard"); await audit(ctx, "automation.update", ctx.p.id, b); return json(row); });
r("DELETE", "automations/:id", async (ctx) => { requireLevel(ctx, "admin"); await db().delete(automations).where(and(eq(automations.id, ctx.p.id), eq(automations.guildId, ctx.guildId))); await publishEvent("automations.updated", ctx.guildId, {}, "dashboard"); await audit(ctx, "automation.delete", ctx.p.id); return json({ ok: true }); });
r("POST", "automations/:id/test", async (ctx) => { requireLevel(ctx, "admin"); const b = await body(ctx.req, z.object({ live: z.boolean().default(false) })); return json(await bot(`/guilds/${ctx.guildId}/automations/${ctx.p.id}/test`, { body: { userId: ctx.userId, live: b.live }, timeoutMs: 60_000 })); });
r("POST", "automations/generate", async (ctx) => { requireLevel(ctx, "admin"); const b = await body(ctx.req, z.object({ prompt: z.string().min(3).max(2000) })); return json(await bot(`/guilds/${ctx.guildId}/ai/generate-automation`, { body: { ...b, actorId: ctx.userId }, timeoutMs: 120_000 })); });

r("POST", "automations/recipes", async (ctx) => {
  requireLevel(ctx, "admin");
  const b = await body(ctx.req, z.object({ key: z.string(), params: z.record(z.string(), z.string()).default({}) }));
  let outputs;
  try { outputs = buildRecipe(b.key, { ...b.params }); } catch (e) { throw new ApiError(400, (e as Error).message); }
  const rows = [];
  for (const o of outputs) {
    const def = automationSchema.safeParse(o.definition);
    if (!def.success) throw new ApiError(400, `Recipe produced an invalid workflow: ${def.error.issues[0]?.message}`);
    const [row] = await db().insert(automations).values({ guildId: ctx.guildId, name: o.name, description: o.description, enabled: true, definition: def.data, createdBy: ctx.userId }).returning();
    rows.push(row);
  }
  await publishEvent("automations.updated", ctx.guildId, {}, "dashboard");
  await audit(ctx, "automation.recipe", b.key, b.params);
  return json(rows);
});

// ───────── Quick setup & server tools ─────────
r("POST", "setup", async (ctx) => {
  requireLevel(ctx, "admin");
  const b = await body(ctx.req, z.object({ packs: z.array(z.string()).min(1).max(20), dry: z.boolean().default(true) }));
  const out = await bot(`/guilds/${ctx.guildId}/setup`, { body: { ...b, actorId: ctx.userId }, timeoutMs: 180_000 });
  if (!b.dry) await audit(ctx, "setup.apply", b.packs.join(","));
  return json(out);
});
r("GET", "tools/summary", async (ctx) => {
  requireLevel(ctx, "admin");
  const g = ctx.guildId;
  const [sugs, [sugStats], inviters, [invStats], stars, [voice], stats] = await Promise.all([
    db().select().from(suggestions).where(eq(suggestions.guildId, g)).orderBy(desc(suggestions.createdAt)).limit(50),
    db().select({ total: sql<number>`count(*)::int`, open: sql<number>`count(*) filter (where status in ('open','considering'))::int`, approved: sql<number>`count(*) filter (where status in ('approved','implemented'))::int` }).from(suggestions).where(eq(suggestions.guildId, g)),
    db().select({ inviterId: memberInvites.inviterId, total: sql<number>`count(*)::int`, active: sql<number>`count(*) filter (where not ${memberInvites.left})::int` }).from(memberInvites).where(and(eq(memberInvites.guildId, g), sql`${memberInvites.inviterId} is not null`)).groupBy(memberInvites.inviterId).orderBy(sql`3 desc`).limit(10),
    db().select({ tracked: sql<number>`count(*)::int`, unknown: sql<number>`count(*) filter (where ${memberInvites.code} is null)::int` }).from(memberInvites).where(eq(memberInvites.guildId, g)),
    db().select().from(starboardPosts).where(and(eq(starboardPosts.guildId, g), sql`${starboardPosts.starboardMessageId} is not null`)).orderBy(desc(starboardPosts.stars)).limit(10),
    db().select({ n: sql<number>`count(*)::int` }).from(tempVoiceChannels).where(eq(tempVoiceChannels.guildId, g)),
    bot<Record<string, number>>(`/guilds/${g}/stats-preview`).catch(() => null),
  ]);
  return json({ suggestions: sugs, suggestionStats: sugStats, inviters, inviteStats: invStats, starboard: stars, activeVoiceRooms: voice.n, stats });
});

// ───────── Member backup (Verify with Discord → pull members back) ─────────
const backupCounts = (guildIds: string[]) => guildIds.length
  ? db().select({ guildId: memberBackups.guildId, total: sql<number>`count(*)::int`, active: sql<number>`count(*) filter (where not ${memberBackups.revoked})::int`, last: sql<string | null>`max(${memberBackups.createdAt})` })
    .from(memberBackups).where(sql`${memberBackups.guildId} in (${sql.join(guildIds.map((g) => sql`${g}`), sql`, `)})`).groupBy(memberBackups.guildId)
  : Promise.resolve([]);
r("GET", "member-backup", async (ctx) => {
  requireLevel(ctx, "admin");
  // Sources: servers this user owns (including deleted/lost ones) — that's what makes a restore possible after a nuke.
  const owned = isPlatformOwner(ctx.userId)
    ? await db().select({ id: guilds.id, name: guilds.name, active: guilds.active }).from(guilds)
    : await db().select({ id: guilds.id, name: guilds.name, active: guilds.active }).from(guilds).where(eq(guilds.ownerId, ctx.userId));
  const ids = [...new Set([ctx.guildId, ...owned.map((g) => g.id)])];
  const counts = await backupCounts(ids);
  const live = await bot<{ status: unknown }>(`/guilds/${ctx.guildId}/member-pull`).catch(() => ({ status: null }));
  const here = counts.find((c) => c.guildId === ctx.guildId);
  return json({
    here: { total: here?.total ?? 0, active: here?.active ?? 0 },
    canPull: ctx.level === "owner" || owned.length > 0,
    sources: owned.map((g) => { const c = counts.find((x) => x.guildId === g.id); return { id: g.id, name: g.name, active: g.active, total: c?.total ?? 0, restorable: c?.active ?? 0, last: c?.last ?? null }; }).filter((g) => g.total > 0),
    status: live.status,
  });
});
r("POST", "member-backup/pull", async (ctx) => {
  requireLevel(ctx, "admin");
  const b = await body(ctx.req, z.object({ sourceGuildId: z.string().regex(/^\d{15,22}$/) }));
  const [src] = await db().select().from(guilds).where(eq(guilds.id, b.sourceGuildId));
  const allowed = isPlatformOwner(ctx.userId) || src?.ownerId === ctx.userId || (b.sourceGuildId === ctx.guildId && ctx.level === "owner");
  if (!allowed) throw new ApiError(403, "Only the owner of the backed-up server can restore its members");
  const out = await bot(`/guilds/${ctx.guildId}/member-pull`, { body: { sourceGuildId: b.sourceGuildId } });
  await audit(ctx, "member-backup.pull", b.sourceGuildId);
  return json(out);
});
r("DELETE", "member-backup", async (ctx) => {
  requireLevel(ctx, "owner");
  await db().delete(memberBackups).where(eq(memberBackups.guildId, ctx.guildId));
  await audit(ctx, "member-backup.delete");
  return json({ ok: true });
});

// ───────── Custom commands ─────────
async function reserved(): Promise<Set<string>> { return new Set(await bot<string[]>("/commands/builtin").catch(() => [])); }
const cmdBody = z.object({ name: commandNameSchema, enabled: z.boolean().default(true), definition: customCommandSchema });
r("GET", "commands", async (ctx) => { requireLevel(ctx, "admin"); return json({ rows: await db().select().from(customCommands).where(eq(customCommands.guildId, ctx.guildId)).orderBy(asc(customCommands.name)), reserved: [...await reserved()] }); });
r("POST", "commands", async (ctx) => {
  requireLevel(ctx, "admin");
  const b = await body(ctx.req, cmdBody);
  if ((await reserved()).has(b.name)) throw new ApiError(409, `/${b.name} is a built-in MOTH command`);
  const [row] = await db().insert(customCommands).values({ ...b, guildId: ctx.guildId, createdBy: ctx.userId }).onConflictDoNothing().returning();
  if (!row) throw new ApiError(409, "A command with that name already exists");
  await publishEvent("commands.updated", ctx.guildId, {}, "dashboard"); await audit(ctx, "command.create", b.name);
  return json(row);
});
r("PATCH", "commands/:id", async (ctx) => { requireLevel(ctx, "admin"); const b = await body(ctx.req, cmdBody.partial()); if (b.name && (await reserved()).has(b.name)) throw new ApiError(409, "Reserved name"); const [row] = await db().update(customCommands).set({ ...b, updatedAt: new Date() }).where(and(eq(customCommands.id, ctx.p.id), eq(customCommands.guildId, ctx.guildId))).returning(); await publishEvent("commands.updated", ctx.guildId, {}, "dashboard"); await audit(ctx, "command.update", row?.name); return json(row); });
r("DELETE", "commands/:id", async (ctx) => { requireLevel(ctx, "admin"); await db().delete(customCommands).where(and(eq(customCommands.id, ctx.p.id), eq(customCommands.guildId, ctx.guildId))); await publishEvent("commands.updated", ctx.guildId, {}, "dashboard"); await audit(ctx, "command.delete", ctx.p.id); return json({ ok: true }); });
r("GET", "commands/export", async (ctx) => {
  requireLevel(ctx, "admin");
  const rows = await db().select().from(customCommands).where(eq(customCommands.guildId, ctx.guildId));
  return json({ moth: "commands", version: 1, commands: rows.map((c) => ({ name: c.name, enabled: c.enabled, definition: c.definition })) });
});
r("POST", "commands/import", async (ctx) => {
  requireLevel(ctx, "admin");
  const b = await body(ctx.req, z.object({ data: commandExportSchema, overwrite: z.boolean().default(false) }));
  const res = await reserved();
  let imported = 0, skipped = 0;
  for (const c of b.data.commands) {
    if (res.has(c.name)) { skipped++; continue; }
    const q = db().insert(customCommands).values({ guildId: ctx.guildId, name: c.name, enabled: c.enabled, definition: c.definition, createdBy: ctx.userId });
    const out = b.overwrite ? await q.onConflictDoUpdate({ target: [customCommands.guildId, customCommands.name], set: { definition: c.definition, enabled: c.enabled, updatedAt: new Date() } }).returning() : await q.onConflictDoNothing().returning();
    out.length ? imported++ : skipped++;
  }
  await publishEvent("commands.updated", ctx.guildId, {}, "dashboard"); await audit(ctx, "command.import", undefined, { imported, skipped });
  return json({ imported, skipped });
});
r("POST", "commands/generate", async (ctx) => { requireLevel(ctx, "admin"); const b = await body(ctx.req, z.object({ prompt: z.string().min(3).max(2000) })); return json(await bot(`/guilds/${ctx.guildId}/ai/generate-command`, { body: { ...b, actorId: ctx.userId }, timeoutMs: 120_000 })); });
r("POST", "commands/sync", async (ctx) => { requireLevel(ctx, "admin"); return json(await bot(`/guilds/${ctx.guildId}/commands/sync`, { body: {} })); });

// ───────── Members ─────────
r("GET", "members", async (ctx) => { requireLevel(ctx, "moderator"); return json(await bot(`/guilds/${ctx.guildId}/members?q=${encodeURIComponent(ctx.query.get("q") ?? "")}&limit=50`)); });
r("GET", "members/:userId", async (ctx) => {
  requireLevel(ctx, "moderator");
  const [live, cases, [lv], [eco], achs] = await Promise.all([
    bot(`/guilds/${ctx.guildId}/members/${ctx.p.userId}`).catch(() => null),
    db().select().from(modCases).where(and(eq(modCases.guildId, ctx.guildId), eq(modCases.targetId, ctx.p.userId))).orderBy(desc(modCases.createdAt)).limit(50),
    db().select().from(memberLevels).where(and(eq(memberLevels.guildId, ctx.guildId), eq(memberLevels.userId, ctx.p.userId))),
    db().select().from(economyAccounts).where(and(eq(economyAccounts.guildId, ctx.guildId), eq(economyAccounts.userId, ctx.p.userId))),
    db().select().from(userAchievements).where(and(eq(userAchievements.guildId, ctx.guildId), eq(userAchievements.userId, ctx.p.userId))),
  ]);
  return json({ live, cases, levels: lv ?? null, economy: eco ?? null, achievements: achs });
});
r("POST", "members/:userId/roles", async (ctx) => { requireLevel(ctx, "admin"); const b = await body(ctx.req, z.object({ add: z.array(z.string()).default([]), remove: z.array(z.string()).default([]) })); const out = await bot(`/guilds/${ctx.guildId}/members/${ctx.p.userId}/roles`, { body: { ...b, actorId: ctx.userId } }); await audit(ctx, "member.roles", ctx.p.userId, b); return json(out); });
r("GET", "leaderboard", async (ctx) => {
  const [levels, eco] = await Promise.all([
    db().select().from(memberLevels).where(eq(memberLevels.guildId, ctx.guildId)).orderBy(desc(memberLevels.xp)).limit(25),
    db().select().from(economyAccounts).where(eq(economyAccounts.guildId, ctx.guildId)).orderBy(desc(economyAccounts.balance)).limit(25),
  ]);
  return json({ levels, economy: eco });
});

// ───────── Analytics ─────────
r("GET", "analytics", async (ctx) => {
  const days = Math.min(365, Math.max(1, Number(ctx.query.get("days") ?? 30)));
  const since = new Date(Date.now() - days * 86_400_000);
  const g = ctx.guildId;
  const bucket = days <= 3 ? "hour" : "day";
  const [series, channels, moderation, ticketsDaily, security, autoRuns, ai, heat] = await Promise.all([
    db().select({ t: sql<string>`date_trunc(${bucket}, ${analyticsHourly.hour})`, messages: sql<number>`sum(messages)`, joins: sql<number>`sum(joins)`, leaves: sql<number>`sum(leaves)`, active: sql<number>`max(active_users)`, voice: sql<number>`sum(voice_minutes)`, commands: sql<number>`sum(commands)`, members: sql<number>`max(member_count)` })
      .from(analyticsHourly).where(and(eq(analyticsHourly.guildId, g), gte(analyticsHourly.hour, since))).groupBy(sql`1`).orderBy(sql`1`),
    db().select({ channelId: channelActivity.channelId, n: sql<number>`sum(messages)` }).from(channelActivity).where(and(eq(channelActivity.guildId, g), gte(channelActivity.day, since))).groupBy(channelActivity.channelId).orderBy(desc(sql`2`)).limit(10),
    db().select({ t: sql<string>`date_trunc('day', created_at)`, n: sql<number>`count(*)`, auto: sql<number>`count(*) filter (where automated)` }).from(modCases).where(and(eq(modCases.guildId, g), gte(modCases.createdAt, since))).groupBy(sql`1`).orderBy(sql`1`),
    db().select({ t: sql<string>`date_trunc('day', created_at)`, opened: sql<number>`count(*)`, closed: sql<number>`count(*) filter (where closed_at is not null)` }).from(tickets).where(and(eq(tickets.guildId, g), gte(tickets.createdAt, since))).groupBy(sql`1`).orderBy(sql`1`),
    db().select({ severity: securityEvents.severity, n: sql<number>`count(*)` }).from(securityEvents).where(and(eq(securityEvents.guildId, g), gte(securityEvents.createdAt, since))).groupBy(securityEvents.severity),
    db().select({ status: automationRuns.status, n: sql<number>`count(*)` }).from(automationRuns).where(and(eq(automationRuns.guildId, g), gte(automationRuns.createdAt, since))).groupBy(automationRuns.status),
    db().select({ feature: aiUsage.feature, n: sql<number>`count(*)`, tokens: sql<number>`sum(input_tokens + output_tokens)` }).from(aiUsage).where(and(eq(aiUsage.guildId, g), gte(aiUsage.createdAt, since))).groupBy(aiUsage.feature),
    db().select({ dow: sql<number>`extract(dow from hour)`, h: sql<number>`extract(hour from hour)`, n: sql<number>`sum(messages)` }).from(analyticsHourly).where(and(eq(analyticsHourly.guildId, g), gte(analyticsHourly.hour, since))).groupBy(sql`1`, sql`2`),
  ]);
  return json({ days, bucket, series, channels, moderation, tickets: ticketsDaily, security, automations: autoRuns, ai, heat });
});

// ───────── AI providers ─────────
const providerBody = z.object({ name: z.string().min(1).max(60), kind: z.enum(["openai", "anthropic", "ollama", "openai-compatible"]), baseUrl: z.string().url().nullable().optional(), model: z.string().min(1).max(120), apiKey: z.string().max(400).optional(), temperature: z.number().min(0).max(2).default(0.4), isDefault: z.boolean().default(false) });
const showProvider = (p: typeof aiProviders.$inferSelect) => ({ ...p, apiKeyEnc: undefined, hasKey: !!p.apiKeyEnc, keyPreview: p.apiKeyEnc ? maskSecret("sk-••••••••") : null });
r("GET", "ai/providers", async (ctx) => {
  requireLevel(ctx, "admin");
  const rows = await db().select().from(aiProviders).where(sql`${aiProviders.guildId} = ${ctx.guildId} or ${aiProviders.guildId} is null`);
  return json({ rows: rows.map(showProvider), envProvider: process.env.AI_PROVIDER && process.env.AI_PROVIDER !== "none" ? { kind: process.env.AI_PROVIDER, model: process.env.AI_MODEL } : null });
});
r("POST", "ai/providers", async (ctx) => {
  requireLevel(ctx, "admin");
  const b = await body(ctx.req, providerBody);
  if (b.isDefault) await db().update(aiProviders).set({ isDefault: false }).where(eq(aiProviders.guildId, ctx.guildId));
  const [row] = await db().insert(aiProviders).values({ guildId: ctx.guildId, name: b.name, kind: b.kind, baseUrl: b.baseUrl ?? null, model: b.model, temperature: b.temperature, isDefault: b.isDefault, apiKeyEnc: b.apiKey ? encryptSecret(b.apiKey) : null }).returning();
  await audit(ctx, "ai.provider.create", row.id, { name: b.name, kind: b.kind, model: b.model });
  return json(showProvider(row));
});
r("PATCH", "ai/providers/:id", async (ctx) => {
  requireLevel(ctx, "admin");
  const b = await body(ctx.req, providerBody.partial());
  if (b.isDefault) await db().update(aiProviders).set({ isDefault: false }).where(eq(aiProviders.guildId, ctx.guildId));
  const { apiKey, ...rest } = b;
  const [row] = await db().update(aiProviders).set({ ...rest, ...(apiKey !== undefined ? { apiKeyEnc: apiKey ? encryptSecret(apiKey) : null } : {}), updatedAt: new Date() }).where(and(eq(aiProviders.id, ctx.p.id), eq(aiProviders.guildId, ctx.guildId))).returning();
  if (!row) throw new ApiError(404, "Provider not found (instance-wide providers are managed on the System page)");
  return json(showProvider(row));
});
r("DELETE", "ai/providers/:id", async (ctx) => { requireLevel(ctx, "admin"); await db().delete(aiProviders).where(and(eq(aiProviders.id, ctx.p.id), eq(aiProviders.guildId, ctx.guildId))); return json({ ok: true }); });
r("POST", "ai/providers/:id/test", async (ctx) => {
  requireLevel(ctx, "admin");
  const [p] = await db().select().from(aiProviders).where(eq(aiProviders.id, ctx.p.id));
  if (!p || (p.guildId && p.guildId !== ctx.guildId)) throw new ApiError(404, "Provider not found");
  return json(await bot(`/ai/test-provider`, { body: { providerId: p.id }, timeoutMs: 45_000 }));
});
r("GET", "ai/usage", async (ctx) => {
  requireLevel(ctx, "admin");
  const since = new Date(Date.now() - 30 * 86_400_000);
  return json(await db().select({ day: sql<string>`date_trunc('day', created_at)`, n: sql<number>`count(*)`, tokens: sql<number>`sum(input_tokens + output_tokens)` }).from(aiUsage).where(and(eq(aiUsage.guildId, ctx.guildId), gte(aiUsage.createdAt, since))).groupBy(sql`1`).orderBy(sql`1`));
});

// ───────── Architect ─────────
r("GET", "architect/sessions", async (ctx) => { requireLevel(ctx, "admin"); return json(await db().select({ id: architectSessions.id, mode: architectSessions.mode, title: architectSessions.title, status: architectSessions.status, userId: architectSessions.userId, createdAt: architectSessions.createdAt, updatedAt: architectSessions.updatedAt }).from(architectSessions).where(eq(architectSessions.guildId, ctx.guildId)).orderBy(desc(architectSessions.updatedAt)).limit(30)); });
r("GET", "architect/sessions/:id", async (ctx) => { requireLevel(ctx, "admin"); const [s] = await db().select().from(architectSessions).where(and(eq(architectSessions.id, ctx.p.id), eq(architectSessions.guildId, ctx.guildId))); if (!s) throw new ApiError(404, "Session not found"); return json(s); });
r("POST", "architect/sessions", async (ctx) => { requireLevel(ctx, "admin"); const b = await body(ctx.req, z.object({ mode: z.enum(["create", "quick", "improve", "redesign"]), prompt: z.string().min(1).max(4000).optional() })); return json(await bot(`/guilds/${ctx.guildId}/architect/sessions`, { body: { ...b, userId: ctx.userId }, timeoutMs: 180_000 })); });
r("POST", "architect/sessions/:id/messages", async (ctx) => { requireLevel(ctx, "admin"); const b = await body(ctx.req, z.object({ message: z.string().min(1).max(4000) })); return json(await bot(`/guilds/${ctx.guildId}/architect/sessions/${ctx.p.id}/messages`, { body: b, timeoutMs: 180_000 })); });
r("POST", "architect/sessions/:id/plan", async (ctx) => { requireLevel(ctx, "admin"); const b = await body(ctx.req, z.object({ options: z.object({ prune: z.boolean().optional(), resetPermissions: z.boolean().optional(), reorder: z.boolean().optional(), removeBots: z.boolean().optional() }) })); return json(await bot(`/guilds/${ctx.guildId}/architect/sessions/${ctx.p.id}/plan`, { body: b, timeoutMs: 60_000 })); });
r("POST", "architect/sessions/:id/apply", async (ctx) => {
  requireLevel(ctx, "admin");
  const b = await body(ctx.req, z.object({ excludeOpIds: z.array(z.string()).default([]), approveDestructive: z.array(z.string()).default([]), prune: z.boolean().optional(), resetPermissions: z.boolean().optional(), reorder: z.boolean().optional(), removeBots: z.boolean().optional(), cleanMessages: z.boolean().optional(), confirm: z.literal(true) }));
  await audit(ctx, "architect.apply.request", ctx.p.id, { excluded: b.excludeOpIds.length, destructive: b.approveDestructive.length });
  return json(await bot(`/guilds/${ctx.guildId}/architect/sessions/${ctx.p.id}/apply`, { body: { ...b, actorId: ctx.userId } }));
});
r("POST", "architect/sessions/:id/rollback", async (ctx) => { requireLevel(ctx, "admin"); return json(await bot(`/guilds/${ctx.guildId}/architect/sessions/${ctx.p.id}/rollback`, { body: { actorId: ctx.userId }, timeoutMs: 300_000 })); });
r("POST", "architect/sessions/:id/cancel", async (ctx) => { requireLevel(ctx, "admin"); await db().update(architectSessions).set({ status: "cancelled" }).where(and(eq(architectSessions.id, ctx.p.id), eq(architectSessions.guildId, ctx.guildId), eq(architectSessions.status, "drafting"))); return json({ ok: true }); });
r("POST", "architect/analyze", async (ctx) => { requireLevel(ctx, "admin"); return json(await bot(`/guilds/${ctx.guildId}/architect/analyze`, { body: {}, timeoutMs: 60_000 })); });
r("POST", "architect/from-backup", async (ctx) => { requireLevel(ctx, "admin"); const b = await body(ctx.req, z.object({ backupId: z.string().uuid() })); return json(await bot(`/guilds/${ctx.guildId}/architect/from-backup`, { body: { ...b, userId: ctx.userId }, timeoutMs: 60_000 })); });
r("GET", "architect/templates", async (ctx) => {
  requireLevel(ctx, "admin");
  const saved = await db().select().from(blueprints).where(sql`${blueprints.guildId} = ${ctx.guildId} or ${blueprints.guildId} is null`).orderBy(desc(blueprints.createdAt));
  return json({ builtin: BUILTIN_TEMPLATES, saved: saved.map((b) => ({ ...b, blueprint: undefined })) });
});
r("GET", "architect/templates/:id", async (ctx) => {
  requireLevel(ctx, "admin");
  const bi = builtinTemplate(ctx.p.id);
  if (bi) return json(bi);
  const [b] = await db().select().from(blueprints).where(eq(blueprints.id, ctx.p.id));
  if (!b || (b.guildId && b.guildId !== ctx.guildId)) throw new ApiError(404, "Template not found");
  return json(b.blueprint);
});
r("POST", "architect/templates", async (ctx) => {
  requireLevel(ctx, "admin");
  const b = await body(ctx.req, z.object({ name: z.string().min(1).max(100), description: z.string().max(500).optional(), tags: z.array(z.string()).default([]), blueprint: blueprintSchema.optional(), fromCurrentServer: z.boolean().optional(), shared: z.boolean().default(false) }));
  let bp: unknown = b.blueprint;
  if (b.fromCurrentServer) { const { snapshotToBlueprint } = await import("@moth/core"); bp = snapshotToBlueprint(await bot(`/guilds/${ctx.guildId}/snapshot`)); }
  if (!bp) throw new ApiError(400, "Provide a blueprint or fromCurrentServer");
  const [row] = await db().insert(blueprints).values({ guildId: b.shared && ctx.level === "owner" ? null : ctx.guildId, name: b.name, description: b.description, tags: b.tags, blueprint: bp, createdBy: ctx.userId }).returning();
  return json({ ...row, blueprint: undefined });
});
r("DELETE", "architect/templates/:id", async (ctx) => { requireLevel(ctx, "admin"); await db().delete(blueprints).where(and(eq(blueprints.id, ctx.p.id), eq(blueprints.guildId, ctx.guildId))); return json({ ok: true }); });
r("POST", "architect/sessions/from-template", async (ctx) => {
  requireLevel(ctx, "admin");
  const b = await body(ctx.req, z.object({ templateId: z.string() }));
  if (builtinTemplate(b.templateId)) return json(await bot(`/guilds/${ctx.guildId}/architect/sessions`, { body: { mode: "create", prompt: `template:${b.templateId}`, userId: ctx.userId }, timeoutMs: 180_000 }));
  const [t] = await db().select().from(blueprints).where(eq(blueprints.id, b.templateId));
  if (!t || (t.guildId && t.guildId !== ctx.guildId)) throw new ApiError(404, "Template not found");
  return json(await bot(`/guilds/${ctx.guildId}/architect/sessions/from-blueprint`, { body: { blueprint: t.blueprint, title: t.name, userId: ctx.userId }, timeoutMs: 60_000 }));
});

// ───────── Backups & audit ─────────
r("GET", "backups", async (ctx) => { requireLevel(ctx, "admin"); return json(await db().select({ id: configBackups.id, label: configBackups.label, kind: configBackups.kind, sizeBytes: configBackups.sizeBytes, createdBy: configBackups.createdBy, createdAt: configBackups.createdAt }).from(configBackups).where(eq(configBackups.guildId, ctx.guildId)).orderBy(desc(configBackups.createdAt)).limit(100)); });
r("POST", "backups", async (ctx) => { requireLevel(ctx, "admin"); const b = await body(ctx.req, z.object({ label: z.string().min(1).max(100) })); return json(await bot(`/guilds/${ctx.guildId}/backups`, { body: { ...b, actorId: ctx.userId }, timeoutMs: 60_000 })); });
r("GET", "backups/:id", async (ctx) => {
  requireLevel(ctx, "admin");
  const [b] = await db().select().from(configBackups).where(and(eq(configBackups.id, ctx.p.id), eq(configBackups.guildId, ctx.guildId)));
  if (!b) throw new ApiError(404, "Backup not found");
  return new Response(JSON.stringify(b, null, 2), { headers: { "content-type": "application/json", "content-disposition": `attachment; filename="moth-backup-${b.createdAt.toISOString().slice(0, 10)}.json"` } });
});
r("DELETE", "backups/:id", async (ctx) => { requireLevel(ctx, "admin"); await db().delete(configBackups).where(and(eq(configBackups.id, ctx.p.id), eq(configBackups.guildId, ctx.guildId))); await audit(ctx, "backup.delete", ctx.p.id); return json({ ok: true }); });
r("POST", "backups/:id/restore-config", async (ctx) => { requireLevel(ctx, "admin"); const out = await bot(`/guilds/${ctx.guildId}/backups/${ctx.p.id}/restore-config`, { body: { actorId: ctx.userId }, timeoutMs: 120_000 }); return json(out); });
r("GET", "changelog", async (ctx) => { requireLevel(ctx, "admin"); return json(await db().select().from(changeLog).where(eq(changeLog.guildId, ctx.guildId)).orderBy(desc(changeLog.createdAt)).limit(Math.min(200, Number(ctx.query.get("limit") ?? 100)))); });

// ───────── Dashboard access ─────────
r("GET", "access", async (ctx) => { requireLevel(ctx, "admin"); return json(await db().select().from(dashboardAccess).where(eq(dashboardAccess.guildId, ctx.guildId))); });
r("POST", "access", async (ctx) => {
  requireLevel(ctx, "admin");
  const b = await body(ctx.req, z.object({ subjectType: z.enum(["user", "role"]), subjectId: z.string().regex(/^\d{15,22}$/), level: z.enum(["admin", "moderator", "viewer"]) }));
  if (b.level === "admin" && ctx.level !== "owner") throw new ApiError(403, "Only the server owner can grant admin access");
  const [row] = await db().insert(dashboardAccess).values({ ...b, guildId: ctx.guildId, createdBy: ctx.userId }).onConflictDoUpdate({ target: [dashboardAccess.guildId, dashboardAccess.subjectType, dashboardAccess.subjectId], set: { level: b.level } }).returning();
  invalidateAccess(ctx.guildId); await audit(ctx, "access.grant", `${b.subjectType}:${b.subjectId}`, b);
  return json(row);
});
r("DELETE", "access/:id", async (ctx) => { requireLevel(ctx, "admin"); await db().delete(dashboardAccess).where(and(eq(dashboardAccess.id, Number(ctx.p.id)), eq(dashboardAccess.guildId, ctx.guildId))); invalidateAccess(ctx.guildId); await audit(ctx, "access.revoke", ctx.p.id); return json({ ok: true }); });

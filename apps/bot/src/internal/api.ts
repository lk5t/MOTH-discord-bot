import http from "node:http";
import { ChannelType, PermissionFlagsBits, type Guild } from "discord.js";
import { z } from "zod";
import {
  analyzeServer, automationSchema, automations, generateAutomation, generateCommand,
  getDb, getGuildConfig, messageTemplateSchema, recordAIUsage, resolveAIClient, safeEqual, publishEvent, AIClient, decryptSecret, aiProviders,
} from "@moth/core";
import { and, eq } from "drizzle-orm";
import { env } from "../env.js";
import { log, runtime } from "../context.js";
import { captureSnapshot } from "../lib/snapshot.js";
import { executeModAction } from "../modules/moderation.js";
import { setLockdown, enableRaidMode, disableRaidMode } from "../modules/security.js";
import { applySession, architectTurn, createSession, createSessionFromBlueprint, getSession, refreshPlan, rollbackSession, sessionFromBackup } from "../architect/session.js";
import { createBackup, restoreMothConfig } from "../modules/backups.js";
import { publishPanel, closeTicket, reopenTicket } from "../modules/tickets.js";
import { publishRoleMenu } from "../modules/roleMenus.js";
import { publishVerification } from "../modules/welcome.js";
import { syncGuildCommands } from "../sync.js";
import { runAutomation } from "../modules/automation.js";
import { messagePayload, templateContext } from "../lib/embeds.js";
import { BUILTIN_NAMES } from "../commands/index.js";

/**
 * Internal HTTP API used by the dashboard for anything requiring the Discord
 * gateway (live data, actions, AI). Only reachable on the private Docker
 * network and authenticated with INTERNAL_API_SECRET.
 */

class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
type Ctx = { guild: Guild; params: Record<string, string>; body: Record<string, unknown>; query: URLSearchParams };
type Handler = (ctx: Ctx) => Promise<unknown>;
const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler; guild: boolean }[] = [];

function route(method: string, path: string, handler: Handler, guild = true) {
  const keys: string[] = [];
  const pattern = new RegExp("^" + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "$");
  routes.push({ method, pattern, keys, handler, guild });
}

const actor = async (guild: Guild, body: Record<string, unknown>) => {
  const id = String(body.actorId ?? "");
  const user = await guild.client.users.fetch(id).catch(() => null);
  if (!user) throw new HttpError(400, "actorId is required");
  return user;
};

// ── System ──
route("GET", "/v1/health", async () => ({ status: runtime.ready ? "ok" : "starting", ready: runtime.ready, ping: runtime.client?.ws.ping ?? -1, guilds: runtime.client?.guilds.cache.size ?? 0, uptimeSeconds: Math.round(process.uptime()), memoryMb: Math.round(process.memoryUsage().rss / 1048576), node: process.version }), false);
route("GET", "/v1/bot", async () => {
  const c = runtime.client!;
  return { id: c.user?.id, username: c.user?.username, avatar: c.user?.displayAvatarURL(), guilds: c.guilds.cache.map((g) => g.id), inviteUrl: `https://discord.com/oauth2/authorize?client_id=${env.DISCORD_CLIENT_ID}&permissions=8&scope=bot%20applications.commands` };
}, false);

// ── Guild data ──
route("GET", "/v1/guilds/:guildId/overview", async ({ guild }) => ({
  id: guild.id, name: guild.name, icon: guild.iconURL(), memberCount: guild.memberCount, premiumTier: guild.premiumTier, boosts: guild.premiumSubscriptionCount ?? 0,
  channels: guild.channels.cache.size, roles: guild.roles.cache.size, verificationLevel: guild.verificationLevel, createdAt: guild.createdAt, ownerId: guild.ownerId,
  botPermissions: { administrator: guild.members.me?.permissions.has(PermissionFlagsBits.Administrator) ?? false, manageGuild: guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuild) ?? false, manageRoles: guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles) ?? false, manageChannels: guild.members.me?.permissions.has(PermissionFlagsBits.ManageChannels) ?? false },
  botRolePosition: guild.members.me?.roles.highest.position ?? 0, roleCount: guild.roles.cache.size,
}));
route("GET", "/v1/guilds/:guildId/snapshot", async ({ guild }) => captureSnapshot(guild));
route("GET", "/v1/guilds/:guildId/channels", async ({ guild }) => guild.channels.cache.filter((c) => !c.isThread()).map((c) => ({ id: c.id, name: c.name, type: ChannelType[c.type], parentId: c.parentId, position: "rawPosition" in c ? c.rawPosition : 0, text: c.isTextBased() })));
route("GET", "/v1/guilds/:guildId/roles", async ({ guild }) => guild.roles.cache.sort((a, b) => b.position - a.position).map((r) => ({ id: r.id, name: r.name, color: r.hexColor, position: r.position, managed: r.managed, everyone: r.id === guild.id, members: r.members.size, editable: r.editable })));
route("GET", "/v1/guilds/:guildId/members", async ({ guild, query }) => {
  const q = query.get("q")?.trim(); const limit = Math.min(100, Number(query.get("limit") ?? 50));
  const members = q ? await guild.members.search({ query: q, limit }) : await guild.members.fetch({ limit });
  return [...members.values()].map((m) => ({ id: m.id, username: m.user.username, displayName: m.displayName, avatar: m.displayAvatarURL({ size: 64 }), bot: m.user.bot, joinedAt: m.joinedAt, createdAt: m.user.createdAt, roles: m.roles.cache.filter((r) => r.id !== guild.id).sort((a, b) => b.position - a.position).map((r) => ({ id: r.id, name: r.name, color: r.hexColor })), timedOutUntil: m.communicationDisabledUntil }));
});
route("GET", "/v1/guilds/:guildId/members/:userId", async ({ guild, params }) => {
  const m = await guild.members.fetch(params.userId).catch(() => null);
  if (!m) { const ban = await guild.bans.fetch(params.userId).catch(() => null); const u = await guild.client.users.fetch(params.userId).catch(() => null); return { inGuild: false, banned: !!ban, banReason: ban?.reason, user: u ? { id: u.id, username: u.username, avatar: u.displayAvatarURL(), createdAt: u.createdAt } : null }; }
  return { inGuild: true, banned: false, id: m.id, user: { id: m.id, username: m.user.username, avatar: m.displayAvatarURL({ size: 128 }), createdAt: m.user.createdAt }, displayName: m.displayName, joinedAt: m.joinedAt, roles: m.roles.cache.filter((r) => r.id !== guild.id).map((r) => r.id), timedOutUntil: m.communicationDisabledUntil, permissions: m.permissions.toArray() };
});
route("POST", "/v1/guilds/:guildId/members/:userId/roles", async ({ guild, params, body }) => {
  const m = await guild.members.fetch(params.userId);
  const add = z.array(z.string()).default([]).parse(body.add); const remove = z.array(z.string()).default([]).parse(body.remove);
  const a = await actor(guild, body);
  if (add.length) await m.roles.add(add, `Dashboard: ${a.username}`);
  if (remove.length) await m.roles.remove(remove, `Dashboard: ${a.username}`);
  return { ok: true };
});
route("GET", "/v1/guilds/:guildId/access/:userId", async ({ guild, params }) => {
  const m = await guild.members.fetch(params.userId).catch(() => null);
  return { inGuild: !!m, roles: m ? [...m.roles.cache.keys()] : [], owner: guild.ownerId === params.userId, administrator: m?.permissions.has(PermissionFlagsBits.Administrator) ?? false, manageGuild: m?.permissions.has(PermissionFlagsBits.ManageGuild) ?? false, moderator: m?.permissions.any([PermissionFlagsBits.ModerateMembers, PermissionFlagsBits.KickMembers, PermissionFlagsBits.BanMembers]) ?? false };
});

// ── Moderation & security ──
route("POST", "/v1/guilds/:guildId/moderation", async ({ guild, body }) => {
  const input = z.object({ type: z.enum(["warn", "timeout", "untimeout", "kick", "ban", "unban", "note"]), userId: z.string(), reason: z.string().max(500).optional(), durationMs: z.number().int().positive().optional(), deleteMessageSeconds: z.number().int().min(0).max(604800).optional() }).parse(body);
  const mod = await actor(guild, body);
  const target = await guild.members.fetch(input.userId).catch(() => null) ?? await guild.client.users.fetch(input.userId);
  return executeModAction({ guild, target, moderator: mod, type: input.type, reason: input.reason ? `${input.reason} (via dashboard)` : "Via dashboard", durationMs: input.durationMs ?? null, deleteMessageSeconds: input.deleteMessageSeconds });
});
route("POST", "/v1/guilds/:guildId/lockdown", async ({ guild, body }) => {
  const a = await actor(guild, body);
  if (body.enable) return setLockdown(guild, true, `Dashboard: ${a.username}`);
  await disableRaidMode(guild, `Lifted from dashboard by ${a.username}`);
  return setLockdown(guild, false, `Dashboard: ${a.username}`);
});
route("POST", "/v1/guilds/:guildId/raid-mode", async ({ guild, body }) => {
  const a = await actor(guild, body);
  if (body.enable) { await enableRaidMode(guild, await getGuildConfig(guild.id), `Manually enabled by ${a.username}`); return { ok: true }; }
  await disableRaidMode(guild, `Manually ended by ${a.username}`); return { ok: true };
});

// ── Architect ──
route("POST", "/v1/guilds/:guildId/architect/sessions", async ({ guild, body }) => {
  const input = z.object({ mode: z.enum(["create", "quick", "improve", "redesign"]), prompt: z.string().min(1).max(4000).optional(), userId: z.string() }).parse(body);
  return createSession(guild, input.userId, input.mode, input.prompt);
});
route("POST", "/v1/guilds/:guildId/architect/sessions/:sessionId/messages", async ({ guild, params, body }) => {
  const s = await getSession(guild.id, params.sessionId); if (!s) throw new HttpError(404, "Session not found");
  if (s.status !== "drafting") throw new HttpError(409, `Session is ${s.status}`);
  return architectTurn(guild, s, z.string().min(1).max(4000).parse(body.message));
});
route("POST", "/v1/guilds/:guildId/architect/sessions/:sessionId/plan", async ({ guild, params, body }) => {
  const s = await getSession(guild.id, params.sessionId); if (!s) throw new HttpError(404, "Session not found");
  return refreshPlan(guild, s, z.object({ prune: z.boolean().optional(), resetPermissions: z.boolean().optional(), reorder: z.boolean().optional() }).parse(body.options ?? {}));
});
route("POST", "/v1/guilds/:guildId/architect/sessions/:sessionId/apply", async ({ guild, params, body }) => {
  const s = await getSession(guild.id, params.sessionId); if (!s) throw new HttpError(404, "Session not found");
  const opts = z.object({ excludeOpIds: z.array(z.string()).default([]), approveDestructive: z.array(z.string()).default([]), prune: z.boolean().optional(), resetPermissions: z.boolean().optional(), reorder: z.boolean().optional() }).parse(body);
  const a = await actor(guild, body);
  // Applying can take minutes — run in the background and stream progress via events.
  void applySession(guild, s, a.id, opts, (done, total, description) => void publishEvent("architect.updated", guild.id, { sessionId: s.id, progress: { done, total, description } }))
    .catch((err) => { log.warn({ err }, "architect apply failed"); void publishEvent("architect.updated", guild.id, { sessionId: s.id, status: "failed", error: (err as Error).message }); });
  return { accepted: true };
});
route("POST", "/v1/guilds/:guildId/architect/sessions/:sessionId/rollback", async ({ guild, params, body }) => {
  const s = await getSession(guild.id, params.sessionId); if (!s) throw new HttpError(404, "Session not found");
  return rollbackSession(guild, s, (await actor(guild, body)).id);
});
route("POST", "/v1/guilds/:guildId/architect/sessions/from-blueprint", async ({ guild, body }) => createSessionFromBlueprint(guild, String(body.userId), body.blueprint, String(body.title ?? "Saved blueprint").slice(0, 100)));
route("POST", "/v1/guilds/:guildId/architect/from-backup", async ({ guild, body }) => sessionFromBackup(guild, String(body.userId), String(body.backupId)));
route("POST", "/v1/guilds/:guildId/architect/analyze", async ({ guild }) => analyzeServer(await captureSnapshot(guild), await getGuildConfig(guild.id)));

// ── Backups ──
route("POST", "/v1/guilds/:guildId/backups", async ({ guild, body }) => ({ id: await createBackup(guild, String(body.label ?? "Dashboard backup").slice(0, 100), "manual", String(body.actorId ?? "")) }));
route("POST", "/v1/guilds/:guildId/backups/:backupId/restore-config", async ({ guild, params, body }) => { await restoreMothConfig(guild, params.backupId, String(body.actorId ?? "")); return { ok: true }; });

// ── Tickets, role menus, verification ──
route("POST", "/v1/guilds/:guildId/ticket-panels/:panelId/publish", async ({ guild, params }) => publishPanel(guild, params.panelId));
route("POST", "/v1/guilds/:guildId/tickets/:ticketId/close", async ({ guild, params, body }) => { const a = await guild.members.fetch(String(body.actorId)); await closeTicket(a, params.ticketId, body.reason ? String(body.reason) : "Closed from dashboard"); return { ok: true }; });
route("POST", "/v1/guilds/:guildId/tickets/:ticketId/reopen", async ({ guild, params, body }) => { const a = await guild.members.fetch(String(body.actorId)); await reopenTicket(a, params.ticketId); return { ok: true }; });
route("POST", "/v1/guilds/:guildId/role-menus/:menuId/publish", async ({ guild, params }) => publishRoleMenu(guild, params.menuId));
route("POST", "/v1/guilds/:guildId/verification/publish", async ({ guild }) => ({ messageId: await publishVerification(guild) }));
route("POST", "/v1/guilds/:guildId/messages", async ({ guild, body }) => {
  const { channelId, message } = z.object({ channelId: z.string(), message: messageTemplateSchema }).parse(body);
  const ch = await guild.channels.fetch(channelId);
  if (!ch?.isTextBased() || !("send" in ch)) throw new HttpError(400, "Not a text channel");
  const msg = await ch.send(messagePayload(message, templateContext({ guild, channel: { id: ch.id, name: ch.name } })));
  return { messageId: msg.id };
});

// ── Commands & automations ──
route("POST", "/v1/guilds/:guildId/commands/sync", async ({ guild }) => ({ registered: await syncGuildCommands(guild) }));
route("GET", "/v1/commands/builtin", async () => [...BUILTIN_NAMES], false);
route("POST", "/v1/guilds/:guildId/automations/:automationId/test", async ({ guild, params, body }) => {
  const [row] = await getDb().select().from(automations).where(and(eq(automations.id, params.automationId), eq(automations.guildId, guild.id)));
  if (!row) throw new HttpError(404, "Automation not found");
  const member = body.userId ? await guild.members.fetch(String(body.userId)).catch(() => null) : null;
  return runAutomation({ ...row, def: automationSchema.parse(row.definition) }, guild, { member, user: member?.user, dryRun: body.live !== true }, "test");
});

// ── AI ──
async function aiFor(guild: Guild) {
  const cfg = await getGuildConfig(guild.id);
  const ai = await resolveAIClient(guild.id, cfg.ai.providerId);
  if (!ai) throw new HttpError(400, "No AI provider configured for this server.");
  return ai;
}
function serverIds(guild: Guild) {
  return `Channels: ${guild.channels.cache.filter((c) => c.isTextBased() && !c.isThread()).map((c) => `#${c.name}=${c.id}`).slice(0, 60).join(", ")}\nRoles: ${guild.roles.cache.filter((r) => !r.managed && r.id !== guild.id).map((r) => `@${r.name}=${r.id}`).slice(0, 60).join(", ")}`;
}
route("POST", "/v1/guilds/:guildId/ai/generate-command", async ({ guild, body }) => {
  const ai = await aiFor(guild);
  const { data, usage } = await generateCommand(ai, String(body.prompt).slice(0, 2000), serverIds(guild));
  await recordAIUsage({ guildId: guild.id, userId: String(body.actorId ?? ""), feature: "generate_command", inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, providerKind: ai.config.kind });
  if (BUILTIN_NAMES.has(data.name)) data.name = `${data.name}-custom`.slice(0, 32);
  return data;
});
route("POST", "/v1/guilds/:guildId/ai/generate-automation", async ({ guild, body }) => {
  const ai = await aiFor(guild);
  const byName = <T extends { id: string; name: string }>(list: Iterable<T>, n: string) => { const k = n.replace(/^[#@]/, "").toLowerCase(); for (const x of list) if (x.name.toLowerCase() === k || x.name.toLowerCase().includes(k)) return x.id; return null; };
  const { data, usage } = await generateAutomation(ai, String(body.prompt).slice(0, 2000), serverIds(guild), {
    channel: (n) => byName(guild.channels.cache.filter((c) => c.isTextBased()).values(), n),
    role: (n) => byName(guild.roles.cache.filter((r) => !r.managed && r.editable).values(), n),
  });
  await recordAIUsage({ guildId: guild.id, userId: String(body.actorId ?? ""), feature: "generate_automation", inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, providerKind: ai.config.kind });
  return data;
});
route("POST", "/v1/ai/test-provider", async ({ body }) => {
  const [p] = await getDb().select().from(aiProviders).where(eq(aiProviders.id, String(body.providerId)));
  if (!p) throw new HttpError(404, "Provider not found");
  return new AIClient({ kind: p.kind, model: p.model, baseUrl: p.baseUrl, apiKey: p.apiKeyEnc ? decryptSecret(p.apiKeyEnc) : null, timeoutMs: 30_000 }).test();
}, false);

function send(res: http.ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

export function startInternalApi(): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://internal");
    if (url.pathname === "/healthz") return send(res, runtime.ready ? 200 : 503, { ready: runtime.ready });
    const auth = req.headers.authorization ?? "";
    if (!safeEqual(auth, `Bearer ${env.INTERNAL_API_SECRET}`)) return send(res, 401, { error: "unauthorized" });
    const r = routes.find((x) => x.method === req.method && x.pattern.test(url.pathname));
    if (!r) return send(res, 404, { error: "not found" });
    const m = url.pathname.match(r.pattern)!;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    try {
      let raw = "";
      for await (const chunk of req) { raw += chunk; if (raw.length > 2_000_000) throw new HttpError(413, "payload too large"); }
      const body = raw ? JSON.parse(raw) : {};
      let guild: Guild | undefined;
      if (r.guild) {
        if (!runtime.ready) throw new HttpError(503, "Bot is starting");
        guild = runtime.client!.guilds.cache.get(params.guildId);
        if (!guild) throw new HttpError(404, "MOTH is not in this server");
      }
      const data = await r.handler({ guild: guild!, params, body, query: url.searchParams });
      send(res, 200, data ?? { ok: true });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : err instanceof z.ZodError ? 400 : 500;
      if (status === 500) log.error({ err, path: url.pathname }, "internal api error");
      send(res, status, { error: err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : (err as Error).message });
    }
  });
  server.listen(env.INTERNAL_API_PORT, "0.0.0.0", () => log.info({ port: env.INTERNAL_API_PORT }, "internal API listening"));
  return server;
}

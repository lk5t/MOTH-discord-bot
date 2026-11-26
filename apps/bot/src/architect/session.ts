import type { Guild } from "discord.js";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import {
  analyzeServer, architectSessions, architectSystemPrompt, architectTurnSchema, blueprintSchema, buildPlan, builtinTemplate, channelActivity, configBackups,
  describeSnapshot, designFromPrompt, getDb, getGuildConfig, improveTurnSchema, inferIntent, composeBlueprint, logChange, looksFresh, publishEvent,
  recordAIUsage, resolveAIClient, normaliseName,
  type ArchitectMode, type ArchitectPlan, type Blueprint, type BlueprintInput, type ChatMessage, type GuildSnapshot, type ServerAnalysis,
} from "@moth/core";
import { captureSnapshot, protectedChannelIds } from "../lib/snapshot.js";
import { createBackup, type BackupPayload } from "../modules/backups.js";
import { executePlan, rollbackPlan, type ApplyResult } from "./executor.js";
import { log } from "../context.js";

export type Session = typeof architectSessions.$inferSelect;

export interface SessionOptions { prune?: boolean; resetPermissions?: boolean; reorder?: boolean }

async function activityMap(guildId: string): Promise<Map<string, number>> {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const rows = await getDb().select({ channelId: channelActivity.channelId, n: sql<number>`sum(${channelActivity.messages})` }).from(channelActivity)
    .where(and(eq(channelActivity.guildId, guildId), gte(channelActivity.day, since))).groupBy(channelActivity.channelId);
  const map = new Map(rows.map((r) => [r.channelId, Number(r.n)]));
  // Only report "0 messages" when MOTH has actually been collecting for 30 days.
  return map;
}

async function snapshotFor(guild: Guild): Promise<GuildSnapshot> {
  const activity = await activityMap(guild.id);
  const snap = await captureSnapshot(guild, activity);
  const joined = guild.members.me?.joinedTimestamp ?? Date.now();
  if (Date.now() - joined > 30 * 86_400_000) for (const c of snap.channels) if (c.type === "text" && c.recentMessages === undefined) c.recentMessages = 0;
  return snap;
}

function planFor(snapshot: GuildSnapshot, guild: Guild, mode: ArchitectMode, blueprint: unknown, o: SessionOptions = {}): ArchitectPlan {
  return buildPlan(snapshot, blueprint, {
    mode, prune: o.prune ?? (mode === "create" ? looksFresh(snapshot) : false), resetPermissions: o.resetPermissions ?? false,
    reorder: o.reorder ?? (mode === "create" || mode === "redesign"), protectedChannelIds: protectedChannelIds(guild),
  });
}

/** Rule-based quick edits used when no AI provider is configured. */
function heuristicQuickEdit(prompt: string, snap: GuildSnapshot): { blueprint: BlueprintInput; reply: string } | null {
  const p = prompt.trim();
  const bp: BlueprintInput = { roles: [], categories: [], channels: [], features: {}, removals: { channels: [], roles: [], categories: [] } };
  const did: string[] = [];
  const sec = p.match(/(?:create|add|make|build)\s+(?:a\s+|an\s+)?(?:new\s+)?(.{2,40}?)\s+(?:section|category)/i);
  if (sec) {
    const name = sec[1].replace(/\b(new|the)\b/gi, "").trim();
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const gaming = /gam/i.test(name);
    bp.categories!.push({ name: `━━ ✦ ${name.toUpperCase()} ✦ ━━`, channels: gaming
      ? [{ name: `🎮┃${slug}-chat` }, { name: "🔎┃looking-for-group", slowmode: 30 }, { name: "📸┃clips" }, { name: "🔊 Squad 1", type: "voice", userLimit: 5 }, { name: "🔊 Squad 2", type: "voice", userLimit: 5 }]
      : [{ name: `💬┃${slug}` }, { name: `📌┃${slug}-resources`, readOnly: true }, { name: `🔊 ${name}`, type: "voice" }] });
    did.push(`a new **${name}** section`);
  }
  for (const m of p.matchAll(/(?:create|add|make)\s+(?:a\s+)?(voice\s+|text\s+|forum\s+|announcement\s+)?channel\s+(?:called\s+|named\s+)?#?([\p{L}\p{N}_-]{2,90})/giu)) {
    const type = (m[1]?.trim().toLowerCase() || "text") as "text";
    bp.channels!.push({ name: m[2], type }); did.push(`channel **${m[2]}**`);
  }
  for (const m of p.matchAll(/(?:delete|remove)\s+(?:the\s+)?(?:channel\s+)?#([\p{L}\p{N}_-]{2,90})/giu)) { bp.removals!.channels!.push(m[1]); did.push(`removal of **#${m[1]}**`); }
  for (const m of p.matchAll(/rename\s+#?([\p{L}\p{N}_-]{2,90})\s+to\s+#?([\p{L}\p{N}_-]{2,90})/giu)) { bp.channels!.push({ name: m[2], renameFrom: m[1] }); did.push(`rename **${m[1]}** → **${m[2]}**`); }
  if (/ticket/i.test(p)) {
    const t = composeBlueprint({ ...inferIntent("community with tickets"), emoji: true });
    const support = t.categories.find((c) => c.key === "cat_support"); const tix = t.categories.find((c) => c.key === "cat_tickets");
    const staffCat = { name: "━━ ✦ STAFF ✦ ━━", private: true, visibleTo: ["Moderator", "Admin", "Support"], channels: [{ key: "transcripts", name: "🗂️┃transcripts", readOnly: true, writableBy: [] }] };
    if (support) bp.categories!.push(support as never);
    if (tix) bp.categories!.push({ ...(tix as object as { name: string }), visibleTo: ["Support", "Moderator", "Admin"] });
    bp.categories!.push(staffCat);
    bp.roles!.push({ key: "support", name: "Support", preset: "support", color: "#FB7185", hoist: true });
    bp.features!.tickets = t.features.tickets?.map((x) => ({ ...x, staffRoles: ["support", ...snap.roles.filter((r) => /mod|admin/i.test(r.name)).map((r) => r.name)] })) as never;
    did.push("a professional ticket system (panel, categories, transcripts)");
  }
  if (/secur|raid|protect/i.test(p)) { bp.features!.security = { sensitivity: "high" }; bp.features!.moderation = { preset: "balanced" }; bp.verificationLevel = "medium"; did.push("stronger security (high anti-raid sensitivity, balanced automod, medium verification)"); }
  if (/welcome|onboard/i.test(p)) {
    const welcome = snap.channels.find((c) => /welcome/i.test(c.name));
    if (!welcome) bp.channels!.push({ key: "welcome", name: "👋┃welcome", readOnly: true });
    bp.features!.welcome = { channel: welcome?.name ?? "welcome", title: "Welcome to {server}!", message: "Hey {user.mention}, welcome! You're member **#{server.members}**.\n\n📜 Read the rules\n🎭 Pick your roles\n💬 Say hi!", dm: "Thanks for joining **{server}**, {user.name}! 🦋" };
    did.push("a redesigned welcome experience");
  }
  if (/staff hierarch|staff roles|improve.*staff/i.test(p)) {
    bp.roles!.push({ key: "admin", name: "Admin", preset: "manager", color: "#B91C1C", hoist: true }, { key: "moderator", name: "Moderator", preset: "moderator", color: "#F43F5E", hoist: true }, { key: "support", name: "Support", preset: "support", color: "#FB7185", hoist: true }, { key: "trial", name: "Trial Moderator", preset: "support", color: "#FDA4AF", hoist: true });
    did.push("a clear staff hierarchy (Admin → Moderator → Support → Trial)");
  }
  if (/clean ?up|unnecessary|unused|declutter/i.test(p)) {
    const a = analyzeServer(snap);
    const empty = snap.channels.filter((c) => c.type === "category" && !snap.channels.some((x) => x.parentId === c.id));
    const inactive = snap.channels.filter((c) => c.type === "text" && c.recentMessages === 0);
    bp.removals!.categories!.push(...empty.map((c) => c.name));
    bp.removals!.channels!.push(...inactive.map((c) => c.name));
    did.push(`cleanup of ${empty.length} empty categories and ${inactive.length} inactive channels${a.findings.length ? "" : ""}`);
  }
  if (!did.length) return null;
  return { blueprint: bp, reply: `Here's what I'll do: ${did.join(", ")}.\nReview the preview below — destructive changes stay unchecked until you approve them.` };
}

/** Runs one conversational turn: AI when configured, offline heuristics otherwise. */
export async function architectTurn(guild: Guild, session: Session, userMessage: string): Promise<Session> {
  const db = getDb();
  const cfg = await getGuildConfig(guild.id);
  const snap = await snapshotFor(guild);
  const mode = session.mode;
  const ai = await resolveAIClient(guild.id, cfg.ai.providerId);
  const history = session.messages ?? [];
  let reply = "";
  let blueprint: Blueprint | null = session.blueprint ? blueprintSchema.parse(session.blueprint) : null;
  let analysis: ServerAnalysis | null = (session.analysis as ServerAnalysis | null) ?? null;
  const audit = mode === "improve" || mode === "redesign" ? analyzeServer(snap, cfg) : null;

  if (ai) {
    const context = [
      `CURRENT SERVER:\n${describeSnapshot(snap)}`,
      audit ? `AUTOMATED AUDIT (score ${audit.score}/100):\n${audit.findings.map((f) => `- [${f.severity}] ${f.title}: ${f.detail}`).join("\n")}` : "",
      blueprint ? `CURRENT PROPOSAL (JSON):\n${JSON.stringify(blueprint).slice(0, 24000)}` : "",
    ].filter(Boolean).join("\n\n");
    const messages: ChatMessage[] = [
      { role: "system", content: architectSystemPrompt(mode) },
      { role: "user", content: context },
      { role: "assistant", content: "Understood. I have the current server state." },
      ...history.slice(-8).map((m) => ({ role: m.role, content: m.content.slice(0, 4000) })),
      { role: "user", content: userMessage },
    ];
    try {
      if (mode === "improve") {
        const { data, usage } = await ai.completeJson(messages, improveTurnSchema, { maxTokens: 8000, temperature: 0.3 });
        reply = data.reply; blueprint = data.blueprint;
        analysis = { ...data.analysis, findings: [...(audit?.findings ?? []), ...data.analysis.findings.filter((f) => !audit?.findings.some((a) => normaliseName(a.title) === normaliseName(f.title)))] };
        await recordAIUsage({ guildId: guild.id, userId: session.userId, feature: "architect", inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, providerKind: ai.config.kind });
      } else {
        const { data, usage } = await ai.completeJson(messages, architectTurnSchema, { maxTokens: 8000, temperature: 0.4 });
        reply = data.reply + (data.questions?.length ? `\n\n**Questions:**\n${data.questions.map((q) => `• ${q}`).join("\n")}` : "");
        blueprint = data.blueprint;
        await recordAIUsage({ guildId: guild.id, userId: session.userId, feature: "architect", inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, providerKind: ai.config.kind });
      }
    } catch (err) {
      log.warn({ err }, "architect AI turn failed — falling back to heuristics");
      reply = `⚠️ The AI provider failed (${(err as Error).message.slice(0, 150)}). I used MOTH's built-in designer instead.\n\n`;
    }
  }

  if (!reply || reply.startsWith("⚠️")) {
    const prefix = reply;
    const allPrompts = [...history.filter((m) => m.role === "user").map((m) => m.content), userMessage].join(". ");
    if (mode === "create") {
      const tpl = userMessage.match(/^template:(\w+)/)?.[1];
      const r = tpl ? { blueprint: builtinTemplate(tpl)!, reply: `Loaded the **${tpl}** template. Tell me what to change, or approve it.` } : designFromPrompt(allPrompts);
      blueprint = r.blueprint; reply = prefix + r.reply;
    } else if (mode === "redesign") {
      const intent = inferIntent(`${allPrompts} ${snap.name} ${snap.channels.map((c) => c.name).join(" ")}`);
      blueprint = composeBlueprint(intent);
      reply = prefix + `I've prepared a full redesign as a **${intent.kind}** server with a consistent "${intent.emoji ? "emoji┃name" : "plain"}" naming style. Existing channels with matching names are kept and moved, so message history is preserved. Nothing is deleted unless you enable pruning.`;
      analysis = audit;
    } else if (mode === "improve") {
      analysis = audit;
      blueprint = blueprintSchema.parse(audit!.suggestions);
      reply = prefix + `${audit!.summary}\n\nI've proposed fixes for the issues I can address automatically. Ask me to change anything — e.g. "also add a ticket system".`;
    } else {
      const q = heuristicQuickEdit(userMessage, snap);
      if (q) {
        const merged = blueprint ? mergeBlueprints(blueprint, blueprintSchema.parse(q.blueprint)) : blueprintSchema.parse(q.blueprint);
        blueprint = merged; reply = prefix + q.reply;
      } else {
        reply = prefix + "I couldn't map that request without an AI provider. Try phrasing like: *create a gaming section*, *create channel called clips*, *delete #old-chat*, *rename general to lobby*, *set up a professional ticket system*, *improve server security*, *redesign the welcome experience*, or *clean up unnecessary channels*. Configure an AI provider in the dashboard for free-form requests.";
      }
    }
  }

  const plan = blueprint ? planFor(snap, guild, mode, blueprint) : null;
  const now = new Date().toISOString();
  const messages = [...history, { role: "user" as const, content: userMessage, at: now }, { role: "assistant" as const, content: reply, at: now }];
  const [updated] = await db.update(architectSessions).set({ messages, blueprint, plan, analysis, title: session.title ?? userMessage.slice(0, 80), updatedAt: new Date() }).where(eq(architectSessions.id, session.id)).returning();
  await publishEvent("architect.updated", guild.id, { sessionId: session.id });
  return updated;
}

function mergeBlueprints(a: Blueprint, b: Blueprint): Blueprint {
  return blueprintSchema.parse({
    ...a, ...b,
    roles: [...a.roles.filter((r) => !b.roles.some((x) => x.key === r.key)), ...b.roles],
    channels: [...a.channels, ...b.channels],
    categories: [...a.categories, ...b.categories],
    features: { ...a.features, ...b.features },
    removals: { channels: [...a.removals.channels, ...b.removals.channels], categories: [...a.removals.categories, ...b.removals.categories], roles: [...a.removals.roles, ...b.removals.roles] },
  });
}

export async function createSession(guild: Guild, userId: string, mode: ArchitectMode, prompt?: string): Promise<Session> {
  const [s] = await getDb().insert(architectSessions).values({ guildId: guild.id, userId, mode }).returning();
  if (prompt) return architectTurn(guild, s, prompt);
  return s;
}

/** Starts a session from an existing blueprint (saved templates). */
export async function createSessionFromBlueprint(guild: Guild, userId: string, blueprintInput: unknown, title: string): Promise<Session> {
  const blueprint = blueprintSchema.parse(blueprintInput);
  const plan = planFor(await snapshotFor(guild), guild, "create", blueprint);
  const now = new Date().toISOString();
  const [s] = await getDb().insert(architectSessions).values({ guildId: guild.id, userId, mode: "create", title, blueprint, plan, messages: [{ role: "assistant", content: `Loaded the **${title}** blueprint. Tell me what to change, or approve it to build.`, at: now }] }).returning();
  return s;
}

export async function getSession(guildId: string, id: string): Promise<Session | null> {
  const [s] = await getDb().select().from(architectSessions).where(and(eq(architectSessions.id, id), eq(architectSessions.guildId, guildId)));
  return s ?? null;
}

export async function latestSession(guildId: string, userId: string): Promise<Session | null> {
  const [s] = await getDb().select().from(architectSessions).where(and(eq(architectSessions.guildId, guildId), eq(architectSessions.userId, userId), eq(architectSessions.status, "drafting"))).orderBy(desc(architectSessions.updatedAt)).limit(1);
  return s ?? null;
}

/** Regenerates the plan against the live server (it may have changed since the last turn). */
export async function refreshPlan(guild: Guild, session: Session, opts: SessionOptions = {}): Promise<Session> {
  if (!session.blueprint) return session;
  const plan = planFor(await snapshotFor(guild), guild, session.mode, session.blueprint, opts);
  const [u] = await getDb().update(architectSessions).set({ plan, updatedAt: new Date() }).where(eq(architectSessions.id, session.id)).returning();
  return u;
}

const applying = new Set<string>();

export async function applySession(guild: Guild, session: Session, actorId: string, opts: { excludeOpIds?: string[]; approveDestructive?: string[] } & SessionOptions = {}, onProgress?: (done: number, total: number, description: string) => void): Promise<{ result: ApplyResult; backupId: string }> {
  if (session.status !== "drafting" && session.status !== "failed") throw new Error(`Session is ${session.status}`);
  if (!session.blueprint) throw new Error("Nothing to apply yet");
  if (applying.has(guild.id)) throw new Error("Another Architect change is already being applied to this server");
  applying.add(guild.id);
  const db = getDb();
  try {
    const fresh = await refreshPlan(guild, session, opts);
    const plan = fresh.plan as ArchitectPlan;
    await db.update(architectSessions).set({ status: "applying" }).where(eq(architectSessions.id, session.id));
    const backupId = await createBackup(guild, `Before Architect: ${session.title ?? session.mode}`, "pre-architect", actorId);
    const result = await executePlan(guild, plan, { ...opts, actorId, onProgress: (d, t, op) => onProgress?.(d, t, op.description) });
    const status = result.completed.length === 0 && result.errors.length ? "failed" : "applied";
    await db.update(architectSessions).set({ status, backupId, result, plan, updatedAt: new Date() }).where(eq(architectSessions.id, session.id));
    await logChange({ guildId: guild.id, actorId, source: "architect", action: `architect.apply.${session.mode}`, target: session.id, after: { completed: result.completed.length, errors: result.errors.length, skipped: result.skipped.length } });
    await publishEvent("architect.updated", guild.id, { sessionId: session.id, status });
    return { result, backupId };
  } catch (err) {
    await db.update(architectSessions).set({ status: "failed" }).where(eq(architectSessions.id, session.id));
    throw err;
  } finally {
    applying.delete(guild.id);
  }
}

export async function rollbackSession(guild: Guild, session: Session, actorId: string) {
  if (session.status !== "applied" || !session.backupId || !session.result) throw new Error("Only applied sessions with a backup can be rolled back");
  const [b] = await getDb().select().from(configBackups).where(eq(configBackups.id, session.backupId));
  if (!b) throw new Error("The pre-change backup no longer exists");
  const result = session.result as ApplyResult;
  const out = await rollbackPlan(guild, result, (b.snapshot as BackupPayload).discord, result.configBefore, actorId);
  await getDb().update(architectSessions).set({ status: "rolled_back", updatedAt: new Date() }).where(eq(architectSessions.id, session.id));
  await logChange({ guildId: guild.id, actorId, source: "architect", action: "architect.rollback", target: session.id, after: out });
  await publishEvent("architect.updated", guild.id, { sessionId: session.id, status: "rolled_back" });
  return out;
}

/** Restores Discord structure from any backup by planning a Full Redesign toward it (previewed first). */
export async function sessionFromBackup(guild: Guild, userId: string, backupId: string): Promise<Session> {
  const { snapshotToBlueprint } = await import("@moth/core");
  const [b] = await getDb().select().from(configBackups).where(and(eq(configBackups.id, backupId), eq(configBackups.guildId, guild.id)));
  if (!b) throw new Error("Backup not found");
  const blueprint = blueprintSchema.parse(snapshotToBlueprint((b.snapshot as BackupPayload).discord));
  const snap = await snapshotFor(guild);
  const plan = planFor(snap, guild, "redesign", blueprint, { prune: false, reorder: true });
  const now = new Date().toISOString();
  const [s] = await getDb().insert(architectSessions).values({ guildId: guild.id, userId, mode: "redesign", title: `Restore: ${b.label}`, blueprint, plan, messages: [{ role: "assistant", content: `This plan restores the server structure from the backup **${b.label}**. Review the changes, then apply.`, at: now }] }).returning();
  return s;
}

import {
  ChannelType, GuildFeature, OverwriteType, PermissionFlagsBits, PermissionsBitField, type CategoryChannel, type Guild, type GuildChannel,
  type OverwriteResolvable, type PermissionsString, type Role,
} from "discord.js";
import { and, eq, inArray } from "drizzle-orm";
import {
  automations, getDb, getGuildConfigWithVersion, publishEvent, roleMenus, ticketPanels, updateGuildConfig,
  type ArchitectPlan, type PlanOp, type PlannedOverwrite, type GuildSnapshot, type SnapshotChannel, type TicketCategoryDef,
} from "@moth/core";
import { publishPanel } from "../modules/tickets.js";
import { architectBusy } from "../modules/autopilot.js";
import { idCmp, layoutPositions, type LayoutChannel } from "@moth/core";
import { publishRoleMenu } from "../modules/roleMenus.js";
import { publishVerification } from "../modules/welcome.js";
import { invalidateAutomations } from "../modules/automation.js";
import { toApiEmbed } from "../lib/embeds.js";
import { log } from "../context.js";

export interface ApplyResult {
  completed: string[];
  skipped: string[];
  errors: { opId: string; description: string; error: string }[];
  created: { kind: "role" | "channel"; id: string }[];
  updated: { kind: "role" | "channel"; id: string }[];
  deleted: { kind: "role" | "channel"; id: string; name: string }[];
  /** Other bots removed from the server (can't be re-added automatically). */
  removedBots?: { id: string; name: string }[];
  /** MOTH's own earlier messages that were cleaned up. */
  cleanedMessages?: number;
  messages: { channelId: string; messageId: string }[];
  moth: { ticketPanels: string[]; roleMenus: string[]; automations: string[] };
  configBefore: unknown | null;
  refs: Record<string, string>;
}

export type ApplyProgress = (done: number, total: number, op: PlanOp) => void;

const CHANNEL_TYPES = { text: ChannelType.GuildText, voice: ChannelType.GuildVoice, announcement: ChannelType.GuildAnnouncement, forum: ChannelType.GuildForum, stage: ChannelType.GuildStageVoice } as const;

function validPerms(names: string[], botPerms: Readonly<PermissionsBitField>): PermissionsString[] {
  const valid = names.filter((n): n is PermissionsString => n in PermissionFlagsBits);
  // A bot can only grant permissions it has itself (unless it's an administrator).
  return botPerms.has(PermissionFlagsBits.Administrator) ? valid : valid.filter((p) => botPerms.has(PermissionFlagsBits[p]));
}

/** Executes an architect plan against a guild. Ops are applied in order; failures are recorded and execution continues. */
async function executePlanInner(guild: Guild, plan: ArchitectPlan, opts: { excludeOpIds?: string[]; approveDestructive?: string[]; actorId: string; onProgress?: ApplyProgress; cleanMessages?: boolean }): Promise<ApplyResult> {
  const me = guild.members.me ?? await guild.members.fetchMe();
  const refs: Record<string, string> = { ...plan.refs };
  const exclude = new Set(opts.excludeOpIds ?? []);
  const approved = new Set(opts.approveDestructive ?? []);
  const res: ApplyResult = { completed: [], skipped: [], errors: [], created: [], updated: [], deleted: [], messages: [], moth: { ticketPanels: [], roleMenus: [], automations: [] }, configBefore: null, refs };
  const community = guild.features.includes(GuildFeature.Community);
  res.removedBots = []; res.cleanedMessages = 0;

  /**
   * Deletes MOTH's own earlier posts (old rules embeds, panels, role menus…) in a
   * channel before posting new ones, so re-running the Architect never stacks
   * duplicates. Interaction replies and messages from this run are kept.
   */
  const cleaned = new Set<string>();
  const cleanChannel = async (channelId: string | null) => {
    if (opts.cleanMessages === false || !channelId || cleaned.has(channelId)) return;
    cleaned.add(channelId);
    const ch = guild.channels.cache.get(channelId);
    if (!ch?.isTextBased() || !("bulkDelete" in ch)) return;
    const msgs = await ch.messages.fetch({ limit: 100 }).catch(() => null);
    if (!msgs) return;
    const keep = new Set(res.messages.map((m) => m.messageId));
    const mine = [...msgs.values()].filter((m) => m.author.id === me.id && !m.interactionMetadata && !keep.has(m.id) && !m.reference);
    if (!mine.length) return;
    const recent = mine.filter((m) => Date.now() - m.createdTimestamp < 13 * 86_400_000);
    const old = mine.filter((m) => !recent.includes(m));
    if (recent.length > 1) await ch.bulkDelete(recent, true).catch(() => undefined); else for (const m of recent) await m.delete().catch(() => undefined);
    for (const m of old) await m.delete().catch(() => undefined);
    res.cleanedMessages! += mine.length;
    // Panels and menus whose messages were removed no longer exist in Discord.
    const ids = mine.map((m) => m.id);
    await getDb().update(ticketPanels).set({ messageId: null }).where(and(eq(ticketPanels.guildId, guild.id), inArray(ticketPanels.messageId, ids)));
    await getDb().update(roleMenus).set({ messageId: null }).where(and(eq(roleMenus.guildId, guild.id), inArray(roleMenus.messageId, ids)));
  };

  const resolve = (ref: string | null | undefined): string | null => {
    if (!ref) return null;
    const r = ref.startsWith("ref:") ? ref.slice(4) : ref;
    if (r === "@everyone") return guild.id;
    if (r.startsWith("id:")) return r.slice(3);
    if (refs[r]) return refs[r];
    if (/^\d{15,22}$/.test(r)) return r;
    const name = r.replace(/^(role|chan):/, "");
    const byName = r.startsWith("role:") ? guild.roles.cache.find((x) => x.name.toLowerCase() === name.toLowerCase()) : guild.channels.cache.find((x) => x.name.toLowerCase() === name.toLowerCase());
    return byName?.id ?? null;
  };
  const deepResolve = (v: unknown): unknown => {
    if (typeof v === "string") return v.startsWith("ref:") ? resolve(v) : v;
    if (Array.isArray(v)) return v.map(deepResolve).filter((x) => x !== null);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepResolve(x)]));
    return v;
  };
  const overwrites = (list: PlannedOverwrite[] | null | undefined): OverwriteResolvable[] | undefined => {
    if (!list) return undefined;
    const out: OverwriteResolvable[] = [];
    for (const o of list) {
      const isMember = o.target.startsWith("member:");
      const id = isMember ? o.target.slice(7) : resolve(o.target);
      if (!id) continue;
      out.push({ id, type: isMember ? OverwriteType.Member : OverwriteType.Role, allow: validPerms(o.allow, me.permissions), deny: validPerms(o.deny, me.permissions) });
    }
    // Always keep MOTH able to see/manage channels it creates.
    if (out.some((o) => o.deny && new PermissionsBitField(o.deny as PermissionsString[]).has(PermissionFlagsBits.ViewChannel))) {
      out.push({ id: me.id, type: OverwriteType.Member, allow: ["ViewChannel", "SendMessages", "ManageChannels", "ReadMessageHistory", "EmbedLinks"] });
    }
    return out;
  };
  const channelOf = (ref: string) => { const id = resolve(ref); return id ? guild.channels.cache.get(id) ?? null : null; };

  const ops = plan.ops.filter((o) => {
    if (exclude.has(o.id)) { res.skipped.push(o.id); return false; }
    if (o.destructive && !approved.has(o.id)) { res.skipped.push(o.id); return false; }
    return true;
  });

  let done = 0;
  for (const op of ops) {
    try {
      await runOp(op);
      res.completed.push(op.id);
    } catch (err) {
      log.warn({ err, op: op.id, kind: op.kind, guild: guild.id }, "architect op failed");
      res.errors.push({ opId: op.id, description: op.description, error: (err as Error).message });
    }
    opts.onProgress?.(++done, ops.length, op);
  }
  await publishEvent("guild.updated", guild.id, { architect: true });
  return res;

  async function runOp(op: PlanOp): Promise<void> {
    switch (op.kind) {
      case "guild.update":
        await guild.setVerificationLevel(op.verificationLevel, "MOTH Architect");
        return;
      case "role.create": {
        const role = await guild.roles.create({ name: op.data.name, color: op.data.color, hoist: op.data.hoist, mentionable: op.data.mentionable, permissions: validPerms(op.data.permissions, me.permissions), reason: "MOTH Architect" });
        refs[op.ref] = role.id; res.created.push({ kind: "role", id: role.id });
        return;
      }
      case "role.update": {
        const role = guild.roles.cache.get(op.roleId);
        if (!role) throw new Error("Role no longer exists");
        if (!role.editable && role.id !== guild.id) throw new Error(`@${role.name} is above MOTH in the hierarchy`);
        await role.edit({ name: op.data.name, color: op.data.color, hoist: op.data.hoist, mentionable: op.data.mentionable, permissions: op.data.permissions ? validPerms(op.data.permissions, me.permissions) : undefined, reason: "MOTH Architect" });
        res.updated.push({ kind: "role", id: role.id });
        return;
      }
      case "role.delete": {
        const role = guild.roles.cache.get(op.roleId);
        if (!role) return;
        await role.delete("MOTH Architect"); res.deleted.push({ kind: "role", id: op.roleId, name: op.name });
        return;
      }
      case "roles.reorder": {
        const top = me.roles.highest.position - 1;
        const roles = op.order.map((r) => resolve(r)).map((id) => (id ? guild.roles.cache.get(id) : undefined)).filter((r): r is Role => !!r && r.editable && r.id !== guild.id);
        if (!roles.length) return;
        await guild.roles.setPositions(roles.map((role, i) => ({ role, position: Math.max(1, top - i) })));
        return;
      }
      case "category.create": {
        const cat = await guild.channels.create({ name: op.data.name, type: ChannelType.GuildCategory, permissionOverwrites: overwrites(op.overwrites), reason: "MOTH Architect" });
        refs[op.ref] = cat.id; res.created.push({ kind: "channel", id: cat.id });
        return;
      }
      case "category.update": {
        const cat = guild.channels.cache.get(op.channelId) as CategoryChannel | undefined;
        if (!cat) throw new Error("Category no longer exists");
        await cat.edit({ name: op.data.name, permissionOverwrites: overwrites(op.overwrites), reason: "MOTH Architect" });
        res.updated.push({ kind: "channel", id: cat.id });
        return;
      }
      case "channel.create": {
        let type: ChannelType = CHANNEL_TYPES[op.data.type];
        if (!community && (type === ChannelType.GuildAnnouncement)) type = ChannelType.GuildText;
        if (!community && type === ChannelType.GuildStageVoice) type = ChannelType.GuildVoice;
        const parent = op.parent ? resolve(op.parent) : null;
        const base = { name: op.data.name, parent: parent ?? undefined, permissionOverwrites: overwrites(op.overwrites), reason: "MOTH Architect" };
        const isVoice = type === ChannelType.GuildVoice || type === ChannelType.GuildStageVoice;
        const extra = isVoice ? { userLimit: op.data.userLimit } : { topic: op.data.topic, rateLimitPerUser: op.data.slowmode, nsfw: op.data.nsfw };
        let ch: GuildChannel;
        try { ch = await guild.channels.create({ ...base, ...extra, type } as never); }
        catch (err) {
          // Forums/announcements need the Community feature on some servers — degrade gracefully.
          if (type === ChannelType.GuildForum || type === ChannelType.GuildAnnouncement) ch = await guild.channels.create({ ...base, topic: op.data.topic, type: ChannelType.GuildText } as never);
          else throw err;
        }
        refs[op.ref] = ch.id; res.created.push({ kind: "channel", id: ch.id });
        return;
      }
      case "channel.update": {
        const ch = guild.channels.cache.get(op.channelId) as GuildChannel | undefined;
        if (!ch) throw new Error("Channel no longer exists");
        const edit: Record<string, unknown> = { reason: "MOTH Architect" };
        if (op.data.name) edit.name = op.data.name;
        if (op.data.topic !== undefined) edit.topic = op.data.topic;
        if (op.data.slowmode !== undefined) edit.rateLimitPerUser = op.data.slowmode;
        if (op.data.nsfw !== undefined) edit.nsfw = op.data.nsfw;
        if (op.data.userLimit !== undefined) edit.userLimit = op.data.userLimit;
        if (op.data.type === "announcement" && community) edit.type = ChannelType.GuildAnnouncement;
        if (op.data.type === "text" && ch.type === ChannelType.GuildAnnouncement) edit.type = ChannelType.GuildText;
        if (op.parent !== undefined) { edit.parent = op.parent ? resolve(op.parent) : null; edit.lockPermissions = false; }
        if (op.overwrites) edit.permissionOverwrites = overwrites(op.overwrites);
        await ch.edit(edit as never);
        res.updated.push({ kind: "channel", id: ch.id });
        return;
      }
      case "channel.delete": {
        const ch = guild.channels.cache.get(op.channelId);
        if (!ch) return;
        await ch.delete("MOTH Architect"); res.deleted.push({ kind: "channel", id: op.channelId, name: op.name });
        return;
      }
      case "bot.remove": {
        const m = await guild.members.fetch(op.userId).catch(() => null);
        if (!m) return;
        if (!m.kickable) throw new Error(`${op.name}'s role is above MOTH's`);
        await m.kick("MOTH Architect: Full Redesign");
        res.removedBots!.push({ id: op.userId, name: op.name });
        return;
      }
      case "channels.reorder": {
        const order = op.order.map((o) => ({ id: resolve(o.ref), parent: o.parent ? resolve(o.parent) : null })).filter((o): o is { id: string; parent: string | null } => !!o.id);
        await applyLayout(guild, order);
        return;
      }
      case "message.post": {
        const ch = channelOf(op.channel);
        if (!ch?.isTextBased() || !("send" in ch)) throw new Error("Target channel not found");
        await cleanChannel(ch.id);
        const msg = await ch.send({ content: op.content, embeds: op.embed ? [toApiEmbed(op.embed)] : [], allowedMentions: { parse: [] } });
        if (op.pin) await msg.pin().catch(() => undefined);
        res.messages.push({ channelId: ch.id, messageId: msg.id });
        return;
      }
      case "config.update": {
        if (res.configBefore === null) res.configBefore = (await getGuildConfigWithVersion(guild.id)).config;
        await updateGuildConfig(guild.id, deepResolve(op.patch) as Record<string, unknown>, { actorId: opts.actorId, source: "architect" });
        return;
      }
      case "verification.publish": {
        await cleanChannel(resolve(op.channel));
        const msgId = await publishVerification(guild);
        const chId = resolve(op.channel); if (chId) res.messages.push({ channelId: chId, messageId: msgId });
        return;
      }
      case "ticketpanel.create": {
        const p = op.panel;
        const channelId = resolve(p.channel);
        if (!channelId) throw new Error("Ticket panel channel not found");
        const staff = p.staffRoles.map(resolve).filter((x): x is string => !!x);
        const parent = p.parentCategory ? resolve(p.parentCategory) : null;
        const categories: TicketCategoryDef[] = p.categories.map((c, n) => ({
          id: `c${n + 1}`, label: c.label, emoji: c.emoji, description: c.description, parentCategoryId: parent,
          staffRoleIds: c.staffRoles.map(resolve).filter((x): x is string => !!x), questions: c.questions,
        }));
        await cleanChannel(channelId);
        // Replace an earlier panel with the same name instead of keeping a duplicate.
        await getDb().delete(ticketPanels).where(and(eq(ticketPanels.guildId, guild.id), eq(ticketPanels.name, p.name)));
        const [row] = await getDb().insert(ticketPanels).values({ guildId: guild.id, name: p.name, channelId, style: categories.length > 5 ? "select" : "buttons", embed: { title: p.title ?? "Support", description: p.description ?? "Open a ticket below." }, categories, staffRoleIds: staff, parentCategoryId: parent }).returning();
        res.moth.ticketPanels.push(row.id);
        const pub = await publishPanel(guild, row.id);
        res.messages.push(pub);
        return;
      }
      case "rolemenu.create": {
        const m = op.menu;
        const channelId = resolve(m.channel);
        if (!channelId) throw new Error("Role menu channel not found");
        const options = m.options.map((o) => ({ roleId: resolve(o.role), label: o.label, emoji: o.emoji, description: o.description })).filter((o): o is typeof o & { roleId: string } => !!o.roleId);
        await cleanChannel(channelId);
        await getDb().delete(roleMenus).where(and(eq(roleMenus.guildId, guild.id), eq(roleMenus.name, m.name)));
        const [row] = await getDb().insert(roleMenus).values({ guildId: guild.id, name: m.name, channelId, style: m.style, mode: m.mode, embed: { title: m.title, description: m.description }, options }).returning();
        res.moth.roleMenus.push(row.id);
        const pub = await publishRoleMenu(guild, row.id);
        res.messages.push({ channelId, messageId: pub.messageId });
        return;
      }
      case "automation.create": {
        await getDb().delete(automations).where(and(eq(automations.guildId, guild.id), eq(automations.name, op.name)));
        const [row] = await getDb().insert(automations).values({ guildId: guild.id, name: op.name, description: op.about, definition: deepResolve(op.definition), createdBy: opts.actorId }).returning();
        res.moth.automations.push(row.id);
        invalidateAutomations(guild.id);
        return;
      }
    }
  }
}

/**
 * Best-effort rollback of an applied plan using the pre-apply backup:
 * removes created entities, restores updated ones and recreates deleted ones.
 */
export async function rollbackPlan(guild: Guild, result: ApplyResult, backup: GuildSnapshot, configBefore: unknown | null, actorId: string): Promise<{ restored: number; errors: string[] }> {
  const errors: string[] = [];
  let restored = 0;
  const db = getDb();
  const attempt = async (label: string, fn: () => Promise<unknown>) => { try { await fn(); restored++; } catch (err) { errors.push(`${label}: ${(err as Error).message}`); } };

  for (const m of result.messages) {
    const ch = guild.channels.cache.get(m.channelId);
    if (ch?.isTextBased()) await ch.messages.delete(m.messageId).catch(() => undefined);
  }
  if (result.moth.ticketPanels.length) await db.delete(ticketPanels).where(inArray(ticketPanels.id, result.moth.ticketPanels));
  if (result.moth.roleMenus.length) await db.delete(roleMenus).where(inArray(roleMenus.id, result.moth.roleMenus));
  if (result.moth.automations.length) { await db.delete(automations).where(inArray(automations.id, result.moth.automations)); invalidateAutomations(guild.id); }
  if (configBefore) await attempt("config", () => updateGuildConfig(guild.id, configBefore as Record<string, unknown>, { actorId, source: "architect", replaceSections: true }));

  // Delete created channels (children first), then roles.
  const created = result.created.filter((c) => c.kind === "channel").map((c) => guild.channels.cache.get(c.id)).filter((c): c is NonNullable<typeof c> => !!c);
  for (const ch of created.sort((a, b) => Number(a.type === ChannelType.GuildCategory) - Number(b.type === ChannelType.GuildCategory))) await attempt(`delete #${ch.name}`, () => ch.delete("MOTH Architect rollback"));
  for (const r of result.created.filter((c) => c.kind === "role")) { const role = guild.roles.cache.get(r.id); if (role) await attempt(`delete @${role.name}`, () => role.delete("MOTH Architect rollback")); }

  // Recreate deleted entities from the backup snapshot.
  const idMap = new Map<string, string>();
  for (const d of result.deleted.filter((x) => x.kind === "role")) {
    const snap = backup.roles.find((r) => r.id === d.id); if (!snap) continue;
    await attempt(`recreate @${snap.name}`, async () => { const role = await guild.roles.create({ name: snap.name, color: snap.color, hoist: snap.hoist, mentionable: snap.mentionable, permissions: BigInt(snap.permissions), reason: "MOTH Architect rollback" }); idMap.set(d.id, role.id); });
  }
  const mapOw = (c: SnapshotChannel) => c.overwrites.map((o) => ({ id: idMap.get(o.id) ?? o.id, type: o.type === "role" ? OverwriteType.Role : OverwriteType.Member, allow: BigInt(o.allow), deny: BigInt(o.deny) })).filter((o) => o.type === OverwriteType.Member || guild.roles.cache.has(o.id) || o.id === guild.id);
  const deletedChannels = result.deleted.filter((x) => x.kind === "channel").map((d) => backup.channels.find((c) => c.id === d.id)).filter((c): c is SnapshotChannel => !!c);
  for (const c of [...deletedChannels].sort((a, b) => Number(b.type === "category") - Number(a.type === "category"))) {
    const type = c.type === "category" ? ChannelType.GuildCategory : c.type === "voice" ? ChannelType.GuildVoice : c.type === "stage" ? ChannelType.GuildStageVoice : c.type === "forum" ? ChannelType.GuildForum : c.type === "announcement" ? ChannelType.GuildAnnouncement : ChannelType.GuildText;
    await attempt(`recreate #${c.name}`, async () => {
      const ch = await guild.channels.create({ name: c.name, type, parent: c.parentId ? idMap.get(c.parentId) ?? (guild.channels.cache.has(c.parentId) ? c.parentId : undefined) : undefined, topic: c.topic ?? undefined, nsfw: c.nsfw, permissionOverwrites: mapOw(c), reason: "MOTH Architect rollback" } as never);
      idMap.set(c.id, ch.id);
    });
  }

  // Restore updated entities to their backed-up state.
  for (const u of result.updated) {
    if (u.kind === "role") {
      const snap = backup.roles.find((r) => r.id === u.id); const role = guild.roles.cache.get(u.id);
      if (snap && role) await attempt(`restore @${snap.name}`, () => role.edit({ name: role.id === guild.id ? undefined : snap.name, color: snap.color, hoist: snap.hoist, mentionable: snap.mentionable, permissions: BigInt(snap.permissions), reason: "MOTH Architect rollback" }));
    } else {
      const snap = backup.channels.find((c) => c.id === u.id); const ch = guild.channels.cache.get(u.id) as GuildChannel | undefined;
      if (snap && ch) await attempt(`restore #${snap.name}`, () => ch.edit({ name: snap.name, ...(snap.type === "category" ? {} : { parent: snap.parentId ? idMap.get(snap.parentId) ?? snap.parentId : null, lockPermissions: false }), ...(["text", "announcement", "forum"].includes(snap.type) ? { topic: snap.topic ?? "", rateLimitPerUser: snap.rateLimitPerUser ?? 0, nsfw: !!snap.nsfw } : {}), permissionOverwrites: mapOw(snap), reason: "MOTH Architect rollback" } as never));
    }
  }
  if (result.removedBots?.length) errors.push(`Removed bots can't be re-added automatically — re-invite them: ${result.removedBots.map((b) => b.name).join(", ")}`);
  if (backup.verificationLevel !== guild.verificationLevel) await attempt("verification level", () => guild.setVerificationLevel(backup.verificationLevel, "MOTH Architect rollback"));
  await publishEvent("guild.updated", guild.id, { rollback: true });
  return { restored, errors };
}


/**
 * Applies a layout so Discord shows exactly what the preview showed. Every
 * channel in the server gets a unique position (Discord breaks ties by ID,
 * which is why partial updates came out scrambled): categories in the given
 * order with untouched ones after them, and inside each parent the listed
 * channels first, then the rest in their current order. Verified afterwards
 * and retried once.
 */
export async function applyLayout(guild: Guild, order: { id: string; parent: string | null }[]): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await guild.channels.fetch();
    const all = [...guild.channels.cache.values()].filter((c) => !c.isThread()) as GuildChannel[];
    const kind = (c: GuildChannel): LayoutChannel["kind"] => (c.type === ChannelType.GuildCategory ? "category" : c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice ? "voice" : "text");
    const layout: LayoutChannel[] = all.map((c) => ({ id: c.id, kind: kind(c), parentId: c.parentId ?? null, position: c.rawPosition }));
    const positions = layoutPositions(layout, order).map((p) => ("parent" in p ? { ...p, lockPermissions: false } : p));
    const catOrder = positions.filter((p) => layout.find((c) => c.id === p.channel)?.kind === "category").map((p) => p.channel);
    await guild.channels.setPositions(positions);

    // Check Discord really shows that order.
    await guild.channels.fetch();
    const now = guild.channels.cache.filter((c) => c.type === ChannelType.GuildCategory).sort((a, b) => a.rawPosition - b.rawPosition || idCmp(a.id, b.id)).map((c) => c.id);
    if (now.join() === catOrder.join()) return;
  }
}


/** Applies an Architect plan (Autopilot pauses while this runs so they never fight over the layout). */
export async function executePlan(guild: Guild, plan: ArchitectPlan, opts: Parameters<typeof executePlanInner>[2]): Promise<ApplyResult> {
  architectBusy.add(guild.id);
  try { return await executePlanInner(guild, plan, opts); }
  finally { architectBusy.delete(guild.id); }
}

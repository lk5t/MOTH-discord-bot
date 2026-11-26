import { ChannelType, OverwriteType, PermissionFlagsBits, type Guild, type GuildBasedChannel, type OverwriteResolvable, type Role } from "discord.js";
import { eq } from "drizzle-orm";
import { getDb, getGuildConfig, normaliseName, setupPack, ticketPanels, updateGuildConfig, type PackChannel, type PackIds, type SetupPack } from "@moth/core";
import { publishVerification } from "./welcome.js";
import { publishPanel } from "./tickets.js";
import { createBackup } from "./backups.js";
import { refreshStickies, updateStatsChannels } from "./channelTools.js";
import { log } from "../context.js";

/**
 * Applies one-click setup packs. Everything is idempotent: configured or
 * same-named channels/roles are reused, only missing ones are created.
 */

export type SetupItem = { pack: string; kind: "channel" | "role" | "config" | "panel"; name: string; action: "create" | "reuse" | "configure" | "publish" };
export interface SetupResult { items: SetupItem[]; notes: string[]; errors: string[]; backupId?: string }

const TYPE = { text: ChannelType.GuildText, voice: ChannelType.GuildVoice, category: ChannelType.GuildCategory } as const;
const same = (a: string, b: string) => normaliseName(a).replace(/[^a-z0-9]/g, "") === normaliseName(b).replace(/[^a-z0-9]/g, "");

function staffRoles(guild: Guild, extra: string[]): Role[] {
  const ids = new Set(extra);
  return guild.roles.cache.filter((r) => !r.managed && r.id !== guild.id && (ids.has(r.id) || r.permissions.any([PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ModerateMembers]))).map((r) => r);
}

function findChannel(guild: Guild, c: PackChannel, ids: PackIds, existing: PackIds): GuildBasedChannel | undefined {
  const byId = existing[c.key] ? guild.channels.cache.get(existing[c.key]) : undefined;
  if (byId && byId.type === TYPE[c.type]) return byId;
  const parentId = c.parent ? ids[c.parent] : undefined;
  // Stats channels have changing names — match on the label before the colon.
  const label = c.noConnect ? c.name.split(":")[0] : c.name;
  return guild.channels.cache.find((ch) => ch.type === TYPE[c.type] && (c.noConnect ? ch.name.startsWith(label) : same(ch.name, label)) && (!parentId || ch.parentId === parentId || !ch.parentId));
}

async function runPack(guild: Guild, pack: SetupPack, actorId: string | null, dry: boolean, out: SetupResult) {
  const cfg = await getGuildConfig(guild.id);
  const existing = pack.existing(cfg);
  const ids: PackIds = {};
  const me = guild.client.user.id;

  for (const r of pack.roles) {
    const found = (existing[r.key] && guild.roles.cache.get(existing[r.key])) || guild.roles.cache.find((x) => same(x.name, r.name) && !x.managed);
    if (found) { ids[r.key] = found.id; out.items.push({ pack: pack.key, kind: "role", name: found.name, action: "reuse" }); continue; }
    out.items.push({ pack: pack.key, kind: "role", name: r.name, action: "create" });
    if (dry) { ids[r.key] = `new:${r.key}`; continue; }
    const role = await guild.roles.create({ name: r.name, color: r.color ? Number.parseInt(r.color.slice(1), 16) : undefined, permissions: [], reason: `MOTH quick setup (${pack.name})` });
    ids[r.key] = role.id;
  }

  const staff = staffRoles(guild, [...cfg.moderation.moderatorRoleIds, ...cfg.moderation.adminRoleIds, ...pack.roles.filter((r) => r.staff).map((r) => ids[r.key]).filter((x) => !x.startsWith("new:"))]);
  for (const c of pack.channels) {
    const found = findChannel(guild, c, ids, existing);
    if (found) { ids[c.key] = found.id; out.items.push({ pack: pack.key, kind: "channel", name: found.name, action: "reuse" }); continue; }
    out.items.push({ pack: pack.key, kind: "channel", name: c.type === "category" ? `📁 ${c.name}` : c.type === "voice" ? `🔊 ${c.name}` : `#${c.name}`, action: "create" });
    if (dry) { ids[c.key] = `new:${c.key}`; continue; }
    const overwrites: OverwriteResolvable[] = [{ id: me, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.Connect, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageThreads, PermissionFlagsBits.CreatePublicThreads] }];
    if (c.staffOnly) {
      overwrites.push({ id: guild.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] });
      for (const r of staff) overwrites.push({ id: r.id, type: OverwriteType.Role, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] });
    }
    if (c.readOnly) overwrites.push({ id: guild.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.SendMessagesInThreads, PermissionFlagsBits.CreatePublicThreads] });
    if (c.noConnect) overwrites.push({ id: guild.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.Connect] });
    // Inherit the parent category's overwrites unless the channel is restricted on its own.
    const parent = c.parent ? guild.channels.cache.get(ids[c.parent]) : undefined;
    const inherit = !c.staffOnly && !c.readOnly && !c.noConnect && parent && "permissionOverwrites" in parent;
    const ch = await guild.channels.create({
      name: c.type === "text" ? normaliseName(c.name) : c.name, type: TYPE[c.type], parent: parent?.id,
      topic: c.type === "text" ? c.topic : undefined,
      permissionOverwrites: inherit ? undefined : overwrites,
      position: c.type === "category" && pack.key === "stats" ? 0 : undefined,
      reason: `MOTH quick setup (${pack.name})`,
    });
    if (inherit) await ch.lockPermissions().catch(() => undefined);
    ids[c.key] = ch.id;
  }

  out.items.push({ pack: pack.key, kind: "config", name: pack.name, action: "configure" });
  if (pack.note) out.notes.push(pack.note);
  if (dry) {
    for (const e of pack.extras ?? []) out.items.push({ pack: pack.key, kind: "panel", name: e === "ticket-panel" ? "Ticket panel" : "Verification panel", action: "publish" });
    return;
  }
  await updateGuildConfig(guild.id, pack.config(ids, cfg), { actorId, source: "system" });

  for (const extra of pack.extras ?? []) {
    try {
      if (extra === "publish-verification") { await publishVerification(guild); out.items.push({ pack: pack.key, kind: "panel", name: "Verification panel", action: "publish" }); }
      if (extra === "ticket-panel") {
        const db = getDb();
        const panels = await db.select().from(ticketPanels).where(eq(ticketPanels.guildId, guild.id));
        let panel = panels.find((p) => p.channelId === ids.panel) ?? panels[0];
        if (!panel) {
          const staffIds = [ids.staff].filter(Boolean);
          [panel] = await db.insert(ticketPanels).values({
            guildId: guild.id, name: "Support", channelId: ids.panel, style: "buttons", staffRoleIds: staffIds, parentCategoryId: ids.cat,
            embed: { title: "🎫 Need help?", description: "Pick a category below and a private channel will be opened with our team.", color: "#DC143C" },
            categories: [
              { id: "support", label: "Support", emoji: "💬", description: "Questions and help", staffRoleIds: staffIds, questions: [{ label: "What do you need help with?", long: true, required: true }] },
              { id: "report", label: "Report a member", emoji: "🚩", description: "Report rule breaking", staffRoleIds: staffIds, questions: [{ label: "Who are you reporting?", required: true }, { label: "What happened?", long: true, required: true }], defaultPriority: "high" },
              { id: "appeal", label: "Appeal", emoji: "⚖️", description: "Appeal a punishment", staffRoleIds: staffIds, questions: [{ label: "Which punishment are you appealing?", required: true }, { label: "Why should it be lifted?", long: true, required: true }] },
            ],
          }).returning();
        } else if (!panel.channelId) {
          [panel] = await db.update(ticketPanels).set({ channelId: ids.panel }).where(eq(ticketPanels.id, panel.id)).returning();
        }
        await publishPanel(guild, panel.id);
        out.items.push({ pack: pack.key, kind: "panel", name: `Ticket panel “${panel.name}”`, action: "publish" });
      }
    } catch (err) { out.errors.push(`${pack.name}: ${(err as Error).message}`); }
  }
  if (pack.key === "stats") await updateStatsChannels(guild).catch(() => undefined);
}

/** Preview (dry) or apply setup packs. */
export async function runSetup(guild: Guild, packKeys: string[], opts: { actorId?: string | null; dry?: boolean } = {}): Promise<SetupResult> {
  const out: SetupResult = { items: [], notes: [], errors: [] };
  const packs = [...new Set(packKeys)].map((k) => setupPack(k)).filter((p): p is SetupPack => !!p);
  if (!packs.length) throw new Error("Choose at least one setup pack.");
  const me = guild.members.me;
  if (!opts.dry && !me?.permissions.has([PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles])) throw new Error("MOTH needs the Manage Channels and Manage Roles permissions to run setup.");
  if (!opts.dry) out.backupId = await createBackup(guild, "Before Quick Setup", "manual", opts.actorId ?? null).catch(() => undefined);
  for (const pack of packs) {
    try { await runPack(guild, pack, opts.actorId ?? null, !!opts.dry, out); }
    catch (err) { log.warn({ err, guild: guild.id, pack: pack.key }, "setup pack failed"); out.errors.push(`${pack.name}: ${(err as Error).message}`); }
  }
  if (!opts.dry) await refreshStickies(guild).catch(() => undefined);
  return out;
}

import {
  AttachmentBuilder, AuditLogEvent, ChannelType, EmbedBuilder, PermissionFlagsBits, PermissionsBitField,
  type ReadonlyCollection, type Guild, type GuildBan, type GuildBasedChannel, type GuildMember, type Invite, type Message,
  type PartialGuildMember, type PartialMessage, type Role, type Snowflake, type VoiceState, type NonThreadGuildBasedChannel, type DMChannel,
} from "discord.js";
import { and, eq, sql } from "drizzle-orm";
import { getDb, getGuildConfig, memberInvites, truncate, type GuildConfig } from "@moth/core";
import { BRAND } from "../lib/embeds.js";
import { log } from "../context.js";

/**
 * Server event logging + invite tracking. Every handler is best-effort and
 * never throws: logging must never break the bot.
 */

type Kind = "message" | "member" | "server" | "voice";
type EventKey = keyof GuildConfig["logging"]["events"];

const COLORS = { delete: BRAND.danger, edit: 0xf59e0b, join: BRAND.success, leave: 0x71717a, update: 0x3b82f6, voice: 0x8b5cf6 };
const ts = (d: Date | number | null | undefined) => (d ? `<t:${Math.floor(new Date(d).getTime() / 1000)}:R>` : "unknown");

async function target(guild: Guild, kind: Kind, event: EventKey, channelId?: string | null, isBot = false): Promise<{ send: (o: { embeds: EmbedBuilder[]; files?: AttachmentBuilder[] }) => Promise<unknown> } | null> {
  const cfg = await getGuildConfig(guild.id);
  const L = cfg.logging;
  if (!L.enabled || !L.events[event]) return null;
  if (channelId && L.ignoredChannelIds.includes(channelId)) return null;
  if (isBot && L.ignoreBots) return null;
  const id = { message: L.messageChannelId, member: L.memberChannelId, server: L.serverChannelId, voice: L.voiceChannelId }[kind] ?? cfg.general.logChannelId;
  if (!id || id === channelId) return null; // never log the log channel itself
  const ch = guild.channels.cache.get(id) ?? (await guild.channels.fetch(id).catch(() => null));
  if (!ch?.isTextBased() || !("send" in ch)) return null;
  return { send: (o) => ch.send({ ...o, allowedMentions: { parse: [] } }) };
}

async function emit(guild: Guild, kind: Kind, event: EventKey, build: () => EmbedBuilder | Promise<EmbedBuilder>, channelId?: string | null, files?: AttachmentBuilder[], isBot = false) {
  try {
    const t = await target(guild, kind, event, channelId, isBot);
    if (!t) return;
    const e = await build();
    await t.send({ embeds: [e.setTimestamp()], files });
  } catch (err) { log.debug({ err, guild: guild.id, event }, "server log failed"); }
}

/** Who did it, from the audit log (only if the entry is fresh and about this target). */
async function executor(guild: Guild, type: AuditLogEvent, targetId?: string): Promise<string | null> {
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) return null;
  const logs = await guild.fetchAuditLogs({ type, limit: 3 }).catch(() => null);
  const entry = logs?.entries.find((e) => Date.now() - e.createdTimestamp < 8000 && (!targetId || (e.targetId ?? (e.target as { id?: string } | null)?.id) === targetId));
  return entry?.executorId ? `<@${entry.executorId}>` : null;
}

const embed = (title: string, color: number) => new EmbedBuilder().setTitle(title).setColor(color);

// ───────── Messages ─────────
export function logMessageDelete(m: Message | PartialMessage) {
  if (!m.guild || m.author?.id === m.client.user.id) return;
  {
    void emit(m.guild!, "message", "messageDelete", async () => {
      const e = embed("🗑️ Message deleted", COLORS.delete).setDescription(m.partial && !m.content ? "*Message was not cached — content unknown.*" : truncate(m.content || "*no text*", 3800))
        .addFields({ name: "Channel", value: `<#${m.channelId}>`, inline: true });
      if (m.author) e.setAuthor({ name: m.author.username, iconURL: m.author.displayAvatarURL() }).addFields({ name: "Author", value: `<@${m.author.id}> \`${m.author.id}\``, inline: true });
      if (m.attachments?.size) e.addFields({ name: "Attachments", value: truncate(m.attachments.map((a) => a.name).join("\n"), 1000) });
      const by = m.author ? await executor(m.guild!, AuditLogEvent.MessageDelete, m.author.id) : null;
      if (by) e.addFields({ name: "Deleted by", value: by, inline: true });
      return e.setFooter({ text: `Message ID ${m.id}` });
    }, m.channelId, undefined, !!m.author?.bot);
  }
}

export function logBulkDelete(messages: ReadonlyCollection<Snowflake, Message | PartialMessage>, channel: GuildBasedChannel) {
  const guild = channel.guild;
  const lines = [...messages.values()].reverse().map((m) => `[${m.createdAt?.toISOString() ?? "?"}] ${m.author?.username ?? "unknown"}: ${m.content ?? ""}`);
  const file = new AttachmentBuilder(Buffer.from(lines.join("\n"), "utf8"), { name: `deleted-${channel.id}.txt` });
  void emit(guild, "message", "bulkDelete", () => embed("🧹 Messages bulk-deleted", COLORS.delete).setDescription(`**${messages.size}** messages deleted in <#${channel.id}>. Cached content attached.`), channel.id, [file]);
}

export function logMessageEdit(before: Message | PartialMessage, after: Message) {
  if (!after.guild || before.partial || before.content === after.content || after.author.bot) return;
  void emit(after.guild, "message", "messageEdit", () => embed("✏️ Message edited", COLORS.edit)
    .setAuthor({ name: after.author.username, iconURL: after.author.displayAvatarURL() })
    .setDescription(`[Jump to message](${after.url}) in <#${after.channelId}>`)
    .addFields({ name: "Before", value: truncate(before.content || "*empty*", 1024) }, { name: "After", value: truncate(after.content || "*empty*", 1024) })
    .setFooter({ text: `User ID ${after.author.id}` }), after.channelId);
}

// ───────── Members ─────────
export function logMemberJoin(member: GuildMember, invite: JoinInvite | null) {
  const ageDays = (Date.now() - member.user.createdTimestamp) / 86_400_000;
  void emit(member.guild, "member", "memberJoin", () => {
    const e = embed("📥 Member joined", COLORS.join).setAuthor({ name: member.user.username, iconURL: member.user.displayAvatarURL() }).setThumbnail(member.user.displayAvatarURL())
      .setDescription(`<@${member.id}> \`${member.id}\`${member.user.bot ? " · 🤖 bot" : ""}`)
      .addFields({ name: "Account created", value: `${ts(member.user.createdAt)}${ageDays < 7 ? " ⚠️ **new account**" : ""}`, inline: true }, { name: "Member #", value: `${member.guild.memberCount}`, inline: true });
    if (invite) e.addFields({ name: "Invite", value: invite.code === "vanity" ? "Vanity URL" : `\`${invite.code}\`${invite.inviterId ? ` by <@${invite.inviterId}>` : ""}${invite.uses ? ` (${invite.uses} uses)` : ""}`, inline: true });
    return e.setFooter({ text: `User ID ${member.id}` });
  });
}

export function logMemberLeave(member: GuildMember | PartialGuildMember) {
  void emit(member.guild, "member", "memberLeave", async () => {
    const roles = member.roles?.cache.filter((r) => r.id !== member.guild.id).map((r) => `<@&${r.id}>`) ?? [];
    const kickedBy = await executor(member.guild, AuditLogEvent.MemberKick, member.id);
    const e = embed(kickedBy ? "👢 Member kicked" : "📤 Member left", COLORS.leave).setAuthor({ name: member.user.username, iconURL: member.user.displayAvatarURL() })
      .setDescription(`<@${member.id}> \`${member.id}\``)
      .addFields({ name: "Joined", value: ts(member.joinedAt), inline: true }, { name: "Members now", value: `${member.guild.memberCount}`, inline: true });
    if (kickedBy) e.addFields({ name: "Kicked by", value: kickedBy, inline: true });
    if (roles.length) e.addFields({ name: `Roles (${roles.length})`, value: truncate(roles.join(" "), 1024) });
    return e;
  });
}

export function logMemberUpdate(before: GuildMember | PartialGuildMember, after: GuildMember) {
  if (before.partial) return;
  const added = after.roles.cache.filter((r) => !before.roles.cache.has(r.id));
  const removed = before.roles.cache.filter((r) => !after.roles.cache.has(r.id));
  if (added.size || removed.size) {
    void emit(after.guild, "member", "memberRoles", async () => {
      const e = embed("🎭 Roles updated", COLORS.update).setAuthor({ name: after.user.username, iconURL: after.user.displayAvatarURL() }).setDescription(`<@${after.id}>`);
      if (added.size) e.addFields({ name: "Added", value: truncate(added.map((r) => `<@&${r.id}>`).join(" "), 1024) });
      if (removed.size) e.addFields({ name: "Removed", value: truncate(removed.map((r) => `<@&${r.id}>`).join(" "), 1024) });
      const by = await executor(after.guild, AuditLogEvent.MemberRoleUpdate, after.id);
      if (by) e.addFields({ name: "By", value: by, inline: true });
      return e;
    });
  }
  if (before.nickname !== after.nickname) {
    void emit(after.guild, "member", "nickname", () => embed("🏷️ Nickname changed", COLORS.update).setAuthor({ name: after.user.username, iconURL: after.user.displayAvatarURL() })
      .setDescription(`<@${after.id}>`).addFields({ name: "Before", value: before.nickname ?? "*none*", inline: true }, { name: "After", value: after.nickname ?? "*none*", inline: true }));
  }
}

export function logBan(ban: GuildBan, added: boolean) {
  void emit(ban.guild, "member", "bans", async () => {
    const by = await executor(ban.guild, added ? AuditLogEvent.MemberBanAdd : AuditLogEvent.MemberBanRemove, ban.user.id);
    const e = embed(added ? "🔨 Member banned" : "♻️ Member unbanned", added ? BRAND.danger : COLORS.join).setAuthor({ name: ban.user.username, iconURL: ban.user.displayAvatarURL() }).setDescription(`<@${ban.user.id}> \`${ban.user.id}\``);
    if (by) e.addFields({ name: "By", value: by, inline: true });
    if (added && ban.reason) e.addFields({ name: "Reason", value: truncate(ban.reason, 1024) });
    return e;
  });
}

// ───────── Channels & roles ─────────
const chType = (c: GuildBasedChannel) => ChannelType[c.type].replace("Guild", "").toLowerCase();

export function logChannel(ch: NonThreadGuildBasedChannel | DMChannel, action: "created" | "deleted") {
  if (!("guild" in ch) || !ch.guild) return;
  const c = ch as NonThreadGuildBasedChannel;
  void emit(c.guild, "server", "channels", async () => {
    const by = await executor(c.guild, action === "created" ? AuditLogEvent.ChannelCreate : AuditLogEvent.ChannelDelete, c.id);
    const e = embed(`${action === "created" ? "➕" : "➖"} Channel ${action}`, action === "created" ? COLORS.join : COLORS.delete)
      .setDescription(`${action === "created" ? `<#${c.id}>` : `**#${c.name}**`} · ${chType(c)}${c.parent ? ` in **${c.parent.name}**` : ""}`);
    if (by) e.addFields({ name: "By", value: by, inline: true });
    return e.setFooter({ text: `Channel ID ${c.id}` });
  });
}

export function logChannelUpdate(before: NonThreadGuildBasedChannel | DMChannel, after: NonThreadGuildBasedChannel | DMChannel) {
  if (!("guild" in after) || !after.guild || !("guild" in before)) return;
  const a = after as NonThreadGuildBasedChannel, b = before as NonThreadGuildBasedChannel;
  const changes: string[] = [];
  if (a.name !== b.name) changes.push(`**Name:** ${b.name} → ${a.name}`);
  if (a.parentId !== b.parentId) changes.push(`**Category:** ${b.parent?.name ?? "none"} → ${a.parent?.name ?? "none"}`);
  if ("topic" in a && "topic" in b && a.topic !== b.topic) changes.push(`**Topic:** ${truncate(b.topic ?? "none", 200)} → ${truncate(a.topic ?? "none", 200)}`);
  if ("rateLimitPerUser" in a && "rateLimitPerUser" in b && a.rateLimitPerUser !== b.rateLimitPerUser) changes.push(`**Slowmode:** ${b.rateLimitPerUser ?? 0}s → ${a.rateLimitPerUser ?? 0}s`);
  if ("nsfw" in a && "nsfw" in b && a.nsfw !== b.nsfw) changes.push(`**NSFW:** ${b.nsfw} → ${a.nsfw}`);
  const permsChanged = a.permissionOverwrites.cache.size !== b.permissionOverwrites.cache.size
    || a.permissionOverwrites.cache.some((o) => { const p = b.permissionOverwrites.cache.get(o.id); return !p || p.allow.bitfield !== o.allow.bitfield || p.deny.bitfield !== o.deny.bitfield; });
  if (permsChanged) changes.push("**Permissions** were changed");
  if (!changes.length) return;
  void emit(a.guild, "server", "channels", async () => {
    const e = embed("🛠️ Channel updated", COLORS.update).setDescription(`<#${a.id}>\n${changes.join("\n")}`);
    const by = await executor(a.guild, permsChanged && changes.length === 1 ? AuditLogEvent.ChannelOverwriteUpdate : AuditLogEvent.ChannelUpdate, a.id);
    if (by) e.addFields({ name: "By", value: by, inline: true });
    return e;
  }, a.id);
}

export function logRole(role: Role, action: "created" | "deleted") {
  void emit(role.guild, "server", "roles", async () => {
    const by = await executor(role.guild, action === "created" ? AuditLogEvent.RoleCreate : AuditLogEvent.RoleDelete, role.id);
    const e = embed(`${action === "created" ? "➕" : "➖"} Role ${action}`, action === "created" ? COLORS.join : COLORS.delete).setDescription(`${action === "created" ? `<@&${role.id}>` : `**@${role.name}**`} · ${role.hexColor}`);
    if (by) e.addFields({ name: "By", value: by, inline: true });
    return e.setFooter({ text: `Role ID ${role.id}` });
  });
}

export function logRoleUpdate(before: Role, after: Role) {
  const changes: string[] = [];
  if (before.name !== after.name) changes.push(`**Name:** ${before.name} → ${after.name}`);
  if (before.color !== after.color) changes.push(`**Colour:** ${before.hexColor} → ${after.hexColor}`);
  if (before.hoist !== after.hoist) changes.push(`**Shown separately:** ${before.hoist} → ${after.hoist}`);
  if (before.mentionable !== after.mentionable) changes.push(`**Mentionable:** ${before.mentionable} → ${after.mentionable}`);
  if (before.permissions.bitfield !== after.permissions.bitfield) {
    const gained = new PermissionsBitField(after.permissions.bitfield & ~before.permissions.bitfield).toArray();
    const lost = new PermissionsBitField(before.permissions.bitfield & ~after.permissions.bitfield).toArray();
    if (gained.length) changes.push(`**Permissions added:** ${gained.join(", ")}`);
    if (lost.length) changes.push(`**Permissions removed:** ${lost.join(", ")}`);
  }
  if (!changes.length) return;
  void emit(after.guild, "server", "roles", async () => {
    const e = embed("🛠️ Role updated", after.permissions.has(PermissionFlagsBits.Administrator) && !before.permissions.has(PermissionFlagsBits.Administrator) ? BRAND.danger : COLORS.update).setDescription(`<@&${after.id}>\n${truncate(changes.join("\n"), 3800)}`);
    const by = await executor(after.guild, AuditLogEvent.RoleUpdate, after.id);
    if (by) e.addFields({ name: "By", value: by, inline: true });
    return e;
  });
}

// ───────── Voice ─────────
export function logVoice(before: VoiceState, after: VoiceState) {
  const m = after.member ?? before.member;
  if (!m || m.user.bot || before.channelId === after.channelId) return;
  const [title, desc] = !before.channelId ? ["🔊 Joined voice", `<@${m.id}> joined <#${after.channelId}>`]
    : !after.channelId ? ["🔇 Left voice", `<@${m.id}> left <#${before.channelId}>`]
    : ["🔀 Moved voice", `<@${m.id}> <#${before.channelId}> → <#${after.channelId}>`];
  void emit(after.guild, "voice", "voice", () => embed(title, COLORS.voice).setDescription(desc));
}

// ───────── Invites & invite tracking ─────────
const inviteCache = new Map<string, Map<string, { uses: number; inviterId: string | null }>>();
export type JoinInvite = { code: string; inviterId: string | null; uses?: number };

export async function cacheInvites(guild: Guild): Promise<void> {
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuild)) return;
  const invites = await guild.invites.fetch().catch(() => null);
  if (!invites) return;
  inviteCache.set(guild.id, new Map(invites.map((i) => [i.code, { uses: i.uses ?? 0, inviterId: i.inviterId }])));
  if (guild.vanityURLCode) inviteCache.get(guild.id)!.set("vanity", { uses: (await guild.fetchVanityData().catch(() => null))?.uses ?? 0, inviterId: null });
}

export function onInviteCreate(inv: Invite) {
  if (!inv.guild || !("members" in inv.guild)) return;
  const guild = inv.guild as Guild;
  inviteCache.get(guild.id)?.set(inv.code, { uses: inv.uses ?? 0, inviterId: inv.inviterId });
  void emit(guild, "server", "invites", () => embed("🔗 Invite created", COLORS.update)
    .setDescription(`\`${inv.code}\` → <#${inv.channelId}>${inv.inviterId ? ` by <@${inv.inviterId}>` : ""}`)
    .addFields({ name: "Expires", value: inv.expiresAt ? ts(inv.expiresAt) : "never", inline: true }, { name: "Max uses", value: inv.maxUses ? String(inv.maxUses) : "∞", inline: true }));
}
export function onInviteDelete(inv: Invite) {
  if (inv.guild) inviteCache.get(inv.guild.id)?.delete(inv.code);
}

/** Works out which invite a new member used by diffing invite use counts. */
export async function resolveJoinInvite(member: GuildMember): Promise<JoinInvite | null> {
  const cfg = await getGuildConfig(member.guild.id);
  if (!cfg.logging.inviteTracking) return null;
  const before = inviteCache.get(member.guild.id);
  await cacheInvites(member.guild);
  const after = inviteCache.get(member.guild.id);
  if (!before || !after) return null;
  let found: JoinInvite | null = null;
  for (const [code, v] of after) {
    const prev = before.get(code)?.uses ?? 0;
    if (v.uses > prev) { found = { code, inviterId: v.inviterId, uses: v.uses }; break; }
  }
  // A single-use invite disappears once used.
  if (!found) for (const [code, v] of before) if (!after.has(code)) { found = { code, inviterId: v.inviterId, uses: v.uses + 1 }; break; }
  await getDb().insert(memberInvites).values({ guildId: member.guild.id, userId: member.id, code: found?.code ?? null, inviterId: found?.inviterId ?? null })
    .onConflictDoUpdate({ target: [memberInvites.guildId, memberInvites.userId], set: { code: found?.code ?? null, inviterId: found?.inviterId ?? null, left: false, joinedAt: new Date() } }).catch(() => undefined);
  return found;
}

export async function markInviteLeft(guildId: string, userId: string) {
  await getDb().update(memberInvites).set({ left: true }).where(and(eq(memberInvites.guildId, guildId), eq(memberInvites.userId, userId))).catch(() => undefined);
}

export async function inviteLeaderboard(guildId: string, limit = 10) {
  return getDb().select({ inviterId: memberInvites.inviterId, total: sql<number>`count(*)::int`, active: sql<number>`count(*) filter (where not ${memberInvites.left})::int` })
    .from(memberInvites).where(and(eq(memberInvites.guildId, guildId), sql`${memberInvites.inviterId} is not null`))
    .groupBy(memberInvites.inviterId).orderBy(sql`3 desc`).limit(limit);
}

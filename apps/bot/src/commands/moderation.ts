import { PermissionFlagsBits, SlashCommandBuilder, type ChatInputCommandInteraction, type GuildMember, type TextChannel } from "discord.js";
import { and, desc, eq } from "drizzle-orm";
import { createCase, formatDuration, getDb, getGuildConfig, modCases, parseDuration, userHistory } from "@moth/core";
import type { SlashCommand } from "./types.js";
import { executeModAction } from "../modules/moderation.js";
import { setLockdown, disableRaidMode } from "../modules/security.js";
import { hierarchyError } from "../lib/permissions.js";
import { brandEmbed, BRAND, ok, fail, info } from "../lib/embeds.js";
import { relTime } from "../lib/util.js";
import { sendLog } from "../lib/logs.js";

async function reasonOrFail(i: ChatInputCommandInteraction<"cached">): Promise<string | null | false> {
  const reason = i.options.getString("reason");
  const cfg = await getGuildConfig(i.guildId);
  if (cfg.moderation.requireReason && !reason) { await i.reply({ embeds: [fail("A reason is required on this server.")], ephemeral: true }); return false; }
  return reason;
}

async function targetMember(i: ChatInputCommandInteraction<"cached">): Promise<GuildMember | null> {
  const m = i.options.getMember("user");
  if (!m) { await i.reply({ embeds: [fail("That user isn't in this server.")], ephemeral: true }); return null; }
  const err = hierarchyError(i.member, m);
  if (err) { await i.reply({ embeds: [fail(err)], ephemeral: true }); return null; }
  return m;
}

const userOpt = (b: SlashCommandBuilder, desc = "Member") => b.addUserOption((o) => o.setName("user").setDescription(desc).setRequired(true));
const reasonOpt = <T extends { addStringOption: SlashCommandBuilder["addStringOption"] }>(b: T) => b.addStringOption((o) => o.setName("reason").setDescription("Reason").setMaxLength(500));

function simple(type: "warn" | "kick" | "untimeout", name: string, description: string, perm: bigint): SlashCommand {
  const b = userOpt(new SlashCommandBuilder().setName(name).setDescription(description).setDefaultMemberPermissions(perm).setDMPermission(false));
  reasonOpt(b);
  return {
    data: b.toJSON(), access: "moderator",
    async execute(i) {
      const m = await targetMember(i); if (!m) return;
      const reason = await reasonOrFail(i); if (reason === false) return;
      await i.deferReply();
      const r = await executeModAction({ guild: i.guild, target: m, moderator: i.user, type, reason });
      await i.editReply({ embeds: [ok(`**${m.user.username}** was ${type === "warn" ? "warned" : type === "kick" ? "kicked" : "un-timed-out"} · case #${r.caseNumber}${r.escalated ? `\n⚠️ Escalation applied: **${r.escalated}**` : ""}`)] });
    },
  };
}

export const moderationCommands: SlashCommand[] = [
  simple("warn", "warn", "Warn a member", PermissionFlagsBits.ModerateMembers),
  simple("kick", "kick", "Kick a member", PermissionFlagsBits.KickMembers),
  simple("untimeout", "untimeout", "Remove a member's timeout", PermissionFlagsBits.ModerateMembers),
  {
    data: reasonOpt(userOpt(new SlashCommandBuilder().setName("timeout").setDescription("Timeout a member").setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers).setDMPermission(false))
      .addStringOption((o) => o.setName("duration").setDescription("e.g. 10m, 1h, 1d (max 28d)").setRequired(true))).toJSON(),
    access: "moderator",
    async execute(i) {
      const m = await targetMember(i); if (!m) return;
      const ms = parseDuration(i.options.getString("duration", true));
      if (!ms || ms > 28 * 86_400_000) return void i.reply({ embeds: [fail("Invalid duration (use e.g. 10m, 2h, 1d; max 28d).")], ephemeral: true });
      const reason = await reasonOrFail(i); if (reason === false) return;
      await i.deferReply();
      const r = await executeModAction({ guild: i.guild, target: m, moderator: i.user, type: "timeout", reason, durationMs: ms });
      await i.editReply({ embeds: [ok(`**${m.user.username}** timed out for ${formatDuration(ms)} · case #${r.caseNumber}`)] });
    },
  },
  {
    data: reasonOpt(new SlashCommandBuilder().setName("ban").setDescription("Ban a user").setDefaultMemberPermissions(PermissionFlagsBits.BanMembers).setDMPermission(false)
      .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true))
      .addStringOption((o) => o.setName("duration").setDescription("Temporary ban, e.g. 7d"))
      .addIntegerOption((o) => o.setName("delete_messages").setDescription("Delete recent messages").addChoices({ name: "Don't delete", value: 0 }, { name: "Last hour", value: 3600 }, { name: "Last 24h", value: 86400 }, { name: "Last 7 days", value: 604800 }))).toJSON(),
    access: "moderator",
    async execute(i) {
      const user = i.options.getUser("user", true);
      const m = i.options.getMember("user");
      if (m) { const err = hierarchyError(i.member, m); if (err) return void i.reply({ embeds: [fail(err)], ephemeral: true }); }
      const d = i.options.getString("duration"); const ms = d ? parseDuration(d) : null;
      if (d && !ms) return void i.reply({ embeds: [fail("Invalid duration.")], ephemeral: true });
      const reason = await reasonOrFail(i); if (reason === false) return;
      await i.deferReply();
      const r = await executeModAction({ guild: i.guild, target: m ?? user, moderator: i.user, type: "ban", reason, durationMs: ms, deleteMessageSeconds: i.options.getInteger("delete_messages") ?? 0 });
      await i.editReply({ embeds: [ok(`**${user.username}** was banned${ms ? ` for ${formatDuration(ms)}` : ""} · case #${r.caseNumber}`)] });
    },
  },
  {
    data: reasonOpt(new SlashCommandBuilder().setName("unban").setDescription("Unban a user").setDefaultMemberPermissions(PermissionFlagsBits.BanMembers).setDMPermission(false)
      .addStringOption((o) => o.setName("user_id").setDescription("User ID").setRequired(true))).toJSON(),
    access: "moderator",
    async execute(i) {
      const id = i.options.getString("user_id", true).replace(/\D/g, "");
      const user = await i.client.users.fetch(id).catch(() => null);
      if (!user) return void i.reply({ embeds: [fail("Unknown user ID.")], ephemeral: true });
      await i.deferReply();
      const r = await executeModAction({ guild: i.guild, target: user, moderator: i.user, type: "unban", reason: i.options.getString("reason") });
      await i.editReply({ embeds: [ok(`**${user.username}** was unbanned · case #${r.caseNumber}`)] });
    },
  },
  {
    data: new SlashCommandBuilder().setName("case").setDescription("Manage moderation cases").setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers).setDMPermission(false)
      .addSubcommand((s) => s.setName("view").setDescription("View a case").addIntegerOption((o) => o.setName("number").setDescription("Case number").setRequired(true)))
      .addSubcommand((s) => s.setName("reason").setDescription("Update a case reason").addIntegerOption((o) => o.setName("number").setDescription("Case number").setRequired(true)).addStringOption((o) => o.setName("reason").setDescription("New reason").setRequired(true)))
      .addSubcommand((s) => s.setName("void").setDescription("Void a case (warnings stop counting)").addIntegerOption((o) => o.setName("number").setDescription("Case number").setRequired(true)))
      .addSubcommand((s) => s.setName("recent").setDescription("Recent cases")).toJSON(),
    access: "moderator",
    async execute(i) {
      const db = getDb();
      const sub = i.options.getSubcommand();
      if (sub === "recent") {
        const rows = await db.select().from(modCases).where(eq(modCases.guildId, i.guildId)).orderBy(desc(modCases.createdAt)).limit(15);
        return void i.reply({ embeds: [brandEmbed("Recent cases", rows.map((c) => `\`#${c.caseNumber}\` **${c.type}** <@${c.targetId}> — ${(c.reason ?? "").slice(0, 60)} ${relTime(c.createdAt)}${c.automated ? " 🤖" : ""}`).join("\n") || "No cases yet.")], ephemeral: true });
      }
      const n = i.options.getInteger("number", true);
      const [c] = await db.select().from(modCases).where(and(eq(modCases.guildId, i.guildId), eq(modCases.caseNumber, n)));
      if (!c) return void i.reply({ embeds: [fail(`Case #${n} not found.`)], ephemeral: true });
      if (sub === "view") {
        const e = brandEmbed(`Case #${c.caseNumber} · ${c.type.toUpperCase()}`).addFields(
          { name: "User", value: `<@${c.targetId}> (${c.targetId})`, inline: true }, { name: "Moderator", value: c.automated ? "MOTH AutoMod" : `<@${c.moderatorId}>`, inline: true },
          { name: "Status", value: c.active ? "Active" : "Void/expired", inline: true }, { name: "Reason", value: c.reason ?? "—" },
          ...(c.durationMs ? [{ name: "Duration", value: formatDuration(c.durationMs), inline: true }] : []),
          ...(c.explanation && (c.explanation as { summary?: string }).summary ? [{ name: "Explanation", value: String((c.explanation as { summary: string }).summary).slice(0, 1024) }] : []),
        ).setTimestamp(c.createdAt);
        return void i.reply({ embeds: [e], ephemeral: true });
      }
      if (sub === "reason") { await db.update(modCases).set({ reason: i.options.getString("reason", true) }).where(eq(modCases.id, c.id)); return void i.reply({ embeds: [ok(`Case #${n} reason updated.`)], ephemeral: true }); }
      if (sub === "void") { await db.update(modCases).set({ active: false }).where(eq(modCases.id, c.id)); return void i.reply({ embeds: [ok(`Case #${n} voided.`)], ephemeral: true }); }
    },
  },
  {
    data: new SlashCommandBuilder().setName("history").setDescription("View a user's moderation history").setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers).setDMPermission(false)
      .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true)).toJSON(),
    access: "moderator",
    async execute(i) {
      const u = i.options.getUser("user", true);
      const rows = await userHistory(i.guildId, u.id, 20);
      const counts = rows.reduce<Record<string, number>>((a, c) => ({ ...a, [c.type]: (a[c.type] ?? 0) + 1 }), {});
      const e = brandEmbed(`History · ${u.username}`, rows.map((c) => `\`#${c.caseNumber}\` **${c.type}**${c.active ? "" : " ~~void~~"} — ${(c.reason ?? "").slice(0, 70)} ${relTime(c.createdAt)}`).join("\n") || "Clean record ✨")
        .setThumbnail(u.displayAvatarURL()).setFooter({ text: Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(" · ") || "No cases" });
      await i.reply({ embeds: [e], ephemeral: true });
    },
  },
  {
    data: new SlashCommandBuilder().setName("note").setDescription("Add a private moderator note to a user").setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers).setDMPermission(false)
      .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true)).addStringOption((o) => o.setName("note").setDescription("Note").setRequired(true).setMaxLength(1000)).toJSON(),
    access: "moderator",
    async execute(i) {
      const u = i.options.getUser("user", true);
      const c = await createCase({ guildId: i.guildId, type: "note", targetId: u.id, targetTag: u.username, moderatorId: i.user.id, reason: i.options.getString("note", true) });
      await i.reply({ embeds: [ok(`Note added to **${u.username}** · case #${c.caseNumber}`)], ephemeral: true });
    },
  },
  {
    data: new SlashCommandBuilder().setName("purge").setDescription("Bulk delete messages").setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages).setDMPermission(false)
      .addIntegerOption((o) => o.setName("amount").setDescription("1–100").setMinValue(1).setMaxValue(100).setRequired(true))
      .addUserOption((o) => o.setName("user").setDescription("Only messages from this user"))
      .addStringOption((o) => o.setName("contains").setDescription("Only messages containing text"))
      .addBooleanOption((o) => o.setName("bots").setDescription("Only bot messages")).toJSON(),
    access: "moderator",
    async execute(i) {
      if (!i.channel || !("bulkDelete" in i.channel)) return void i.reply({ embeds: [fail("Can't purge here.")], ephemeral: true });
      await i.deferReply({ ephemeral: true });
      const amount = i.options.getInteger("amount", true); const user = i.options.getUser("user"); const contains = i.options.getString("contains")?.toLowerCase(); const bots = i.options.getBoolean("bots");
      const msgs = await i.channel.messages.fetch({ limit: 100 });
      const filtered = [...msgs.values()].filter((m) => (!user || m.author.id === user.id) && (!contains || m.content.toLowerCase().includes(contains)) && (!bots || m.author.bot) && Date.now() - m.createdTimestamp < 14 * 86_400_000).slice(0, amount);
      const deleted = await (i.channel as TextChannel).bulkDelete(filtered, true);
      await createCase({ guildId: i.guildId, type: "purge", targetId: user?.id ?? i.channelId, moderatorId: i.user.id, reason: `Purged ${deleted.size} messages in #${(i.channel as TextChannel).name}` });
      await sendLog(i.guild, "mod", brandEmbed("Messages purged", `<@${i.user.id}> deleted **${deleted.size}** messages in <#${i.channelId}>${user ? ` from <@${user.id}>` : ""}.`, BRAND.info));
      await i.editReply({ embeds: [ok(`Deleted ${deleted.size} messages.`)] });
    },
  },
  {
    data: new SlashCommandBuilder().setName("slowmode").setDescription("Set channel slowmode").setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels).setDMPermission(false)
      .addStringOption((o) => o.setName("duration").setDescription("e.g. 5s, 1m, off").setRequired(true)).toJSON(),
    access: "moderator",
    async execute(i) {
      const v = i.options.getString("duration", true);
      const ms = v === "off" || v === "0" ? 0 : parseDuration(v);
      if (ms === null || ms > 21_600_000 || !i.channel || !("setRateLimitPerUser" in i.channel)) return void i.reply({ embeds: [fail("Invalid duration (max 6h).")], ephemeral: true });
      await i.channel.setRateLimitPerUser(Math.round(ms / 1000), `Slowmode by ${i.user.username}`);
      await i.reply({ embeds: [ok(ms ? `Slowmode set to ${formatDuration(ms)}.` : "Slowmode disabled.")] });
    },
  },
  {
    data: new SlashCommandBuilder().setName("lock").setDescription("Lock or unlock the current channel").setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels).setDMPermission(false)
      .addBooleanOption((o) => o.setName("unlock").setDescription("Unlock instead")).addStringOption((o) => o.setName("reason").setDescription("Reason")).toJSON(),
    access: "moderator",
    async execute(i) {
      const ch = i.channel;
      if (!ch || ch.isThread() || !("permissionOverwrites" in ch)) return void i.reply({ embeds: [fail("Can't lock this channel.")], ephemeral: true });
      const unlock = !!i.options.getBoolean("unlock");
      await ch.permissionOverwrites.edit(i.guild.roles.everyone, { SendMessages: unlock ? null : false, AddReactions: unlock ? null : false, CreatePublicThreads: unlock ? null : false }, { reason: i.options.getString("reason") ?? `By ${i.user.username}` });
      await i.reply({ embeds: [unlock ? ok("🔓 Channel unlocked.") : brandEmbed(undefined, `🔒 Channel locked${i.options.getString("reason") ? `: ${i.options.getString("reason")}` : ""}.`, BRAND.danger)] });
    },
  },
  {
    data: new SlashCommandBuilder().setName("lockdown").setDescription("Emergency server lockdown").setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setDMPermission(false)
      .addSubcommand((s) => s.setName("on").setDescription("Lock every public channel").addStringOption((o) => o.setName("reason").setDescription("Reason")))
      .addSubcommand((s) => s.setName("off").setDescription("Lift the lockdown and restore permissions"))
      .addSubcommand((s) => s.setName("status").setDescription("Show lockdown / raid status")).toJSON(),
    access: "admin",
    async execute(i) {
      const sub = i.options.getSubcommand();
      if (sub === "status") {
        const { guildState } = await import("@moth/core");
        const [s] = await getDb().select().from(guildState).where(eq(guildState.guildId, i.guildId));
        return void i.reply({ embeds: [info(`**Lockdown:** ${s?.lockdown ? "🔒 active" : "off"}\n**Raid mode:** ${s?.raidMode ? `🚨 active until ${s.raidModeUntil ? relTime(s.raidModeUntil) : "manual"}` : "off"}`)], ephemeral: true });
      }
      await i.deferReply();
      if (sub === "on") {
        const r = await setLockdown(i.guild, true, i.options.getString("reason") ?? `Manual lockdown by ${i.user.username}`);
        await sendLog(i.guild, "security", brandEmbed("🔒 Server lockdown", `Enabled by <@${i.user.id}>. ${r.channels} channels locked.`, BRAND.danger));
        await i.editReply({ embeds: [brandEmbed("🔒 Server locked down", `${r.channels} channels locked. Use \`/lockdown off\` to restore permissions exactly as they were.`, BRAND.danger)] });
      } else {
        await disableRaidMode(i.guild, `Lifted by ${i.user.username}`);
        const r = await setLockdown(i.guild, false, `Lifted by ${i.user.username}`);
        await i.editReply({ embeds: [ok(`Lockdown lifted. ${r.channels} channels restored.`)] });
      }
    },
  },
];


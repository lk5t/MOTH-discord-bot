import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { desc, eq } from "drizzle-orm";
import { configBackups, getDb, getGuildConfig, moderationPreset, updateGuildConfig } from "@moth/core";
import type { SlashCommand, ComponentHandler } from "./types.js";
import { cid } from "./types.js";
import { brandEmbed, ok, fail, BRAND } from "../lib/embeds.js";
import { createBackup, restoreMothConfig } from "../modules/backups.js";
import { publishVerification } from "../modules/welcome.js";
import { env } from "../env.js";
import { runtime } from "../context.js";
import { hasAccess } from "../lib/permissions.js";
import { respond } from "../lib/util.js";

const MODULES = { welcome: "Welcome messages", goodbye: "Goodbye messages", autorole: "Auto-roles", verification: "Verification", automod: "Auto-moderation", security: "Anti-raid security", tickets: "Tickets", leveling: "Leveling", economy: "Economy", achievements: "Achievements", ai: "AI assistant" } as const;

export const adminCommands: SlashCommand[] = [
  {
    data: new SlashCommandBuilder().setName("moth").setDescription("About MOTH, status and dashboard link").toJSON(),
    async execute(i) {
      const c = i.client;
      const cfg = await getGuildConfig(i.guildId);
      const enabled = (Object.keys(MODULES) as (keyof typeof MODULES)[]).filter((k) => (cfg[k] as { enabled: boolean }).enabled).map((k) => MODULES[k]);
      await i.reply({
        embeds: [brandEmbed("🦋 MOTH", "AI-powered server management — architecture, moderation, security, tickets, automation and community.")
          .addFields(
            { name: "Latency", value: `${c.ws.ping}ms`, inline: true }, { name: "Uptime", value: `<t:${Math.floor(runtime.startedAt.getTime() / 1000)}:R>`, inline: true }, { name: "Servers", value: `${c.guilds.cache.size}`, inline: true },
            { name: "Enabled here", value: enabled.join(" · ") || "Nothing yet — try `/architect` or the dashboard" },
          )],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Open dashboard").setURL(`${env.DASHBOARD_URL.replace(/\/$/, "")}/dashboard/${i.guildId}`))],
        ephemeral: true,
      });
    },
  },
  {
    data: new SlashCommandBuilder().setName("config").setDescription("Configure MOTH").setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setDMPermission(false)
      .addSubcommand((s) => s.setName("module").setDescription("Enable or disable a module")
        .addStringOption((o) => o.setName("module").setDescription("Module").setRequired(true).addChoices(...Object.entries(MODULES).map(([value, name]) => ({ name, value }))))
        .addBooleanOption((o) => o.setName("enabled").setDescription("Enabled?").setRequired(true)))
      .addSubcommand((s) => s.setName("logs").setDescription("Set log channels")
        .addChannelOption((o) => o.setName("moderation").setDescription("Moderation log").addChannelTypes(ChannelType.GuildText))
        .addChannelOption((o) => o.setName("security").setDescription("Security log").addChannelTypes(ChannelType.GuildText))
        .addChannelOption((o) => o.setName("general").setDescription("General log").addChannelTypes(ChannelType.GuildText)))
      .addSubcommand((s) => s.setName("welcome").setDescription("Set the welcome channel and message")
        .addChannelOption((o) => o.setName("channel").setDescription("Channel").setRequired(true).addChannelTypes(ChannelType.GuildText))
        .addStringOption((o) => o.setName("message").setDescription("Use {user}, {server}, {server.members}").setMaxLength(2000)))
      .addSubcommand((s) => s.setName("automod").setDescription("Apply an auto-moderation preset")
        .addStringOption((o) => o.setName("preset").setDescription("Preset").setRequired(true).addChoices({ name: "Relaxed", value: "relaxed" }, { name: "Balanced", value: "balanced" }, { name: "Strict", value: "strict" })))
      .addSubcommand((s) => s.setName("security").setDescription("Set anti-raid sensitivity")
        .addStringOption((o) => o.setName("sensitivity").setDescription("How aggressive").setRequired(true).addChoices({ name: "Low — few interventions", value: "low" }, { name: "Medium", value: "medium" }, { name: "High", value: "high" }, { name: "Paranoid", value: "paranoid" })))
      .addSubcommand((s) => s.setName("modroles").setDescription("Set the moderator role").addRoleOption((o) => o.setName("role").setDescription("Moderator role").setRequired(true)))
      .addSubcommand((s) => s.setName("verification").setDescription("Set up verification")
        .addChannelOption((o) => o.setName("channel").setDescription("Verification channel").setRequired(true).addChannelTypes(ChannelType.GuildText))
        .addRoleOption((o) => o.setName("role").setDescription("Role granted on verify").setRequired(true))
        .addStringOption((o) => o.setName("mode").setDescription("Mode").addChoices({ name: "Button", value: "button" }, { name: "Captcha", value: "captcha" }))).toJSON(),
    access: "admin",
    async execute(i) {
      const sub = i.options.getSubcommand();
      const opts = { actorId: i.user.id, source: "discord" as const };
      if (sub === "module") {
        const m = i.options.getString("module", true) as keyof typeof MODULES; const enabled = i.options.getBoolean("enabled", true);
        await updateGuildConfig(i.guildId, { [m]: { enabled } }, opts);
        return void i.reply({ embeds: [ok(`${MODULES[m]} ${enabled ? "enabled" : "disabled"}.`)], ephemeral: true });
      }
      if (sub === "logs") {
        const patch: Record<string, string> = {};
        const m = i.options.getChannel("moderation"); const s = i.options.getChannel("security"); const g = i.options.getChannel("general");
        if (m) patch.modLogChannelId = m.id; if (s) patch.securityLogChannelId = s.id; if (g) patch.logChannelId = g.id;
        if (!Object.keys(patch).length) return void i.reply({ embeds: [fail("Pick at least one channel.")], ephemeral: true });
        await updateGuildConfig(i.guildId, { general: patch }, opts);
        return void i.reply({ embeds: [ok("Log channels updated.")], ephemeral: true });
      }
      if (sub === "welcome") {
        const msg = i.options.getString("message");
        await updateGuildConfig(i.guildId, { welcome: { enabled: true, channelId: i.options.getChannel("channel", true).id, ...(msg ? { message: { content: undefined, embed: { title: "Welcome!", description: msg, color: "#DC143C" } } } : {}) } }, opts);
        return void i.reply({ embeds: [ok("Welcome messages configured.")], ephemeral: true });
      }
      if (sub === "automod") {
        const p = moderationPreset(i.options.getString("preset", true) as "balanced");
        await updateGuildConfig(i.guildId, { automod: p.automod, moderation: p.moderation }, opts);
        return void i.reply({ embeds: [ok(`Auto-moderation set to **${i.options.getString("preset", true)}**.`)], ephemeral: true });
      }
      if (sub === "security") {
        await updateGuildConfig(i.guildId, { security: { enabled: true, sensitivity: i.options.getString("sensitivity", true) } }, opts);
        return void i.reply({ embeds: [ok(`Security sensitivity set to **${i.options.getString("sensitivity", true)}**.`)], ephemeral: true });
      }
      if (sub === "modroles") {
        const cfg = await getGuildConfig(i.guildId);
        const r = i.options.getRole("role", true).id;
        await updateGuildConfig(i.guildId, { moderation: { moderatorRoleIds: [...new Set([...cfg.moderation.moderatorRoleIds, r])] } }, opts);
        return void i.reply({ embeds: [ok(`<@&${r}> can now use moderation commands.`)], ephemeral: true });
      }
      if (sub === "verification") {
        await i.deferReply({ ephemeral: true });
        await updateGuildConfig(i.guildId, { verification: { enabled: true, channelId: i.options.getChannel("channel", true).id, verifiedRoleId: i.options.getRole("role", true).id, mode: i.options.getString("mode") ?? "button" } }, opts);
        try { await publishVerification(i.guild); await i.editReply({ embeds: [ok("Verification panel posted.")] }); }
        catch (err) { await i.editReply({ embeds: [fail((err as Error).message)] }); }
      }
    },
  },
  {
    data: new SlashCommandBuilder().setName("backup").setDescription("Configuration backups").setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setDMPermission(false)
      .addSubcommand((s) => s.setName("create").setDescription("Back up server structure and MOTH config").addStringOption((o) => o.setName("label").setDescription("Label").setMaxLength(100)))
      .addSubcommand((s) => s.setName("list").setDescription("List backups"))
      .addSubcommand((s) => s.setName("restore").setDescription("Restore MOTH configuration from a backup").addStringOption((o) => o.setName("backup").setDescription("Backup").setRequired(true).setAutocomplete(true))).toJSON(),
    access: "admin",
    async autocomplete(i) {
      const rows = await getDb().select().from(configBackups).where(eq(configBackups.guildId, i.guildId)).orderBy(desc(configBackups.createdAt)).limit(25);
      await i.respond(rows.map((b) => ({ name: `${b.label} · ${b.kind} · ${b.createdAt.toISOString().slice(0, 16).replace("T", " ")}`.slice(0, 100), value: b.id })));
    },
    async execute(i) {
      const sub = i.options.getSubcommand();
      if (sub === "create") {
        await i.deferReply({ ephemeral: true });
        await createBackup(i.guild, i.options.getString("label") ?? `Manual backup by ${i.user.username}`, "manual", i.user.id);
        return void i.editReply({ embeds: [ok("Backup created.")] });
      }
      if (sub === "list") {
        const rows = await getDb().select().from(configBackups).where(eq(configBackups.guildId, i.guildId)).orderBy(desc(configBackups.createdAt)).limit(15);
        return void i.reply({ embeds: [brandEmbed("Backups", rows.map((b) => `**${b.label}** · ${b.kind} · ${(b.sizeBytes / 1024).toFixed(0)} KB · <t:${Math.floor(b.createdAt.getTime() / 1000)}:R>`).join("\n") || "No backups yet.")], ephemeral: true });
      }
      const id = i.options.getString("backup", true);
      await i.reply({
        embeds: [brandEmbed("Restore MOTH configuration?", "This replaces settings, automations, custom commands, ticket panels and role menus with the backup's versions. A backup of the current state is taken first.\n\nTo restore channels and roles, use the dashboard (Server Settings → Backups → Restore structure) which shows a full preview.", BRAND.warning)],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(cid("backup", "restore", id)).setLabel("Restore configuration").setStyle(ButtonStyle.Danger))],
        ephemeral: true,
      });
    },
  },
];

export const backupComponents: ComponentHandler = {
  prefix: "backup",
  async handle(i, [action, id]) {
    if (action !== "restore") return;
    if (!(await hasAccess(i.member, "admin"))) return respond(i, { embeds: [fail("Admins only.")], ephemeral: true });
    if (i.isButton()) await i.update({ embeds: [brandEmbed(undefined, "Restoring…", BRAND.info)], components: [] });
    try { await restoreMothConfig(i.guild, id, i.user.id); await i.editReply({ embeds: [ok("Configuration restored.")] }); }
    catch (err) { await i.editReply({ embeds: [fail((err as Error).message)] }); }
  },
};

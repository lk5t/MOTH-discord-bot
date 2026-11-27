import { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, SlashCommandBuilder, StringSelectMenuBuilder } from "discord.js";
import { and, eq } from "drizzle-orm";
import { getDb, getGuildConfig, memberInvites, SETUP_PACKS, setupRecommendations } from "@moth/core";
import { cid, type ComponentHandler, type SlashCommand } from "./types.js";
import { brandEmbed, fail, ok, BRAND } from "../lib/embeds.js";
import { hasAccess } from "../lib/permissions.js";
import { runSetup, type SetupResult } from "../modules/setup.js";
import { createSuggestion, isSuggestionStaff, reviewSuggestion, type SuggestionStatus } from "../modules/suggestions.js";
import { inviteLeaderboard } from "../modules/serverLogs.js";
import { env } from "../env.js";

function setupMenu(selected: string[] = []) {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId(cid("setup", "pick")).setPlaceholder("Choose what to set up…").setMinValues(1).setMaxValues(SETUP_PACKS.length)
    .addOptions(SETUP_PACKS.map((p) => ({ label: p.name, value: p.key, description: p.description.slice(0, 100), emoji: p.icon, default: selected.includes(p.key) }))));
}

function summarise(r: SetupResult, dry: boolean): string {
  const by = (a: string) => r.items.filter((x) => x.action === a);
  const lines: string[] = [];
  const create = by("create"), reuse = by("reuse"), publish = by("publish");
  if (create.length) lines.push(`**${dry ? "Will create" : "Created"}:** ${create.map((x) => x.name).join(", ")}`);
  if (reuse.length) lines.push(`**${dry ? "Will reuse" : "Reused"}:** ${reuse.map((x) => x.name).join(", ")}`);
  if (publish.length) lines.push(`**${dry ? "Will post" : "Posted"}:** ${publish.map((x) => x.name).join(", ")}`);
  lines.push(`**${dry ? "Will configure" : "Configured"}:** ${by("configure").map((x) => x.name).join(", ")}`);
  if (r.notes.length) lines.push("", ...r.notes.map((n) => `ℹ️ ${n}`));
  if (r.errors.length) lines.push("", ...r.errors.map((e) => `⚠️ ${e}`));
  return lines.join("\n").slice(0, 4000);
}

async function setupIntro(guildId: string) {
  const cfg = await getGuildConfig(guildId);
  const recs = setupRecommendations(cfg);
  const icon = { high: "🔴", medium: "🟠", low: "⚪" };
  const e = brandEmbed("⚡ Quick setup", "Pick one or more packs. MOTH reuses channels and roles you already have, creates only what's missing, and takes a backup first.")
    .addFields({ name: recs.length ? "Recommended for this server" : "Looking good", value: recs.length ? recs.slice(0, 8).map((r) => `${icon[r.severity]} **${r.title}** — ${r.detail}`).join("\n") : "Everything essential is already set up. ✨" });
  return { embeds: [e], components: [setupMenu([...new Set(recs.filter((r) => r.severity !== "low").map((r) => r.pack))])] };
}

export const toolCommands: SlashCommand[] = [
  {
    data: new SlashCommandBuilder().setName("setup").setDescription("One-click setup: logs, protection, welcome, tickets, voice rooms and more")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setDMPermission(false).toJSON(),
    access: "admin",
    async execute(i) {
      await i.reply({ ...(await setupIntro(i.guildId)), ephemeral: true });
    },
  },
  {
    data: new SlashCommandBuilder().setName("suggest").setDescription("Suggest an idea for the server").setDMPermission(false)
      .addStringOption((o) => o.setName("idea").setDescription("Your suggestion").setRequired(true).setMinLength(5).setMaxLength(1500)).toJSON(),
    async execute(i) {
      try {
        const s = await createSuggestion(i.member, i.options.getString("idea", true));
        await i.reply({ embeds: [ok(`Suggestion **#${s.number}** posted in <#${s.channelId}>.`)], ephemeral: true });
      } catch (err) { await i.reply({ embeds: [fail((err as Error).message)], ephemeral: true }); }
    },
  },
  {
    data: new SlashCommandBuilder().setName("suggestion").setDescription("Review a suggestion").setDMPermission(false)
      .addStringOption((o) => o.setName("status").setDescription("New status").setRequired(true).addChoices({ name: "Approve", value: "approved" }, { name: "Deny", value: "denied" }, { name: "Considering", value: "considering" }, { name: "Implemented", value: "implemented" }, { name: "Re-open", value: "open" }))
      .addIntegerOption((o) => o.setName("number").setDescription("Suggestion number").setRequired(true).setMinValue(1))
      .addStringOption((o) => o.setName("reason").setDescription("Response to the member").setMaxLength(1000)).toJSON(),
    async execute(i) {
      if (!(await isSuggestionStaff(i.member))) return void i.reply({ embeds: [fail("Only suggestion staff can review suggestions.")], ephemeral: true });
      try {
        const s = await reviewSuggestion(i.member, i.options.getInteger("number", true), i.options.getString("status", true) as SuggestionStatus, i.options.getString("reason"));
        await i.reply({ embeds: [ok(`Suggestion **#${s.number}** updated.`)], ephemeral: true });
      } catch (err) { await i.reply({ embeds: [fail((err as Error).message)], ephemeral: true }); }
    },
  },
  {
    data: new SlashCommandBuilder().setName("invites").setDescription("Invite tracking").setDMPermission(false)
      .addSubcommand((s) => s.setName("leaderboard").setDescription("Top inviters"))
      .addSubcommand((s) => s.setName("who").setDescription("Who invited a member").addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true))).toJSON(),
    async execute(i) {
      if (i.options.getSubcommand() === "who") {
        const u = i.options.getUser("user", true);
        const [row] = await getDb().select().from(memberInvites).where(and(eq(memberInvites.guildId, i.guildId), eq(memberInvites.userId, u.id)));
        const text = !row ? "No invite was recorded for this member (they may have joined before tracking started)."
          : row.code === "vanity" ? `<@${u.id}> joined with the server's vanity link.`
          : `<@${u.id}> joined with \`${row.code ?? "unknown"}\`${row.inviterId ? ` from <@${row.inviterId}>` : ""} <t:${Math.floor(row.joinedAt.getTime() / 1000)}:R>.`;
        return void i.reply({ embeds: [brandEmbed("🔗 Invite info", text)], allowedMentions: { parse: [] }, ephemeral: true });
      }
      const rows = await inviteLeaderboard(i.guildId);
      const medal = (n: number) => ["🥇", "🥈", "🥉"][n] ?? `**${n + 1}.**`;
      await i.reply({ embeds: [brandEmbed("🔗 Top inviters", rows.map((r, n) => `${medal(n)} <@${r.inviterId}> — **${r.active}** still here · ${r.total} total`).join("\n") || "No tracked invites yet.")], allowedMentions: { parse: [] } });
    },
  },
];

export const setupComponents: ComponentHandler = {
  prefix: "setup",
  async handle(i, [action, packs]) {
    if (!(await hasAccess(i.member, "admin"))) return i.reply({ embeds: [fail("You need admin access to run setup.")], ephemeral: true });
    if (action === "open" && i.isButton()) return i.reply({ ...(await setupIntro(i.guildId)), ephemeral: true });
    if (action === "pick" && i.isStringSelectMenu()) {
      await i.deferUpdate();
      const preview = await runSetup(i.guild, i.values, { dry: true });
      return i.editReply({
        embeds: [brandEmbed("⚡ Quick setup — preview", summarise(preview, true), BRAND.info)],
        components: [setupMenu(i.values), new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(cid("setup", "apply", i.values.join(","))).setLabel("Apply setup").setEmoji("⚡").setStyle(ButtonStyle.Success))],
      });
    }
    if (action === "apply" && i.isButton()) {
      await i.update({ embeds: [brandEmbed("⚡ Setting things up…", "Creating channels and roles and configuring MOTH. This takes a few seconds.", BRAND.info)], components: [] });
      try {
        const result = await runSetup(i.guild, (packs ?? "").split(",").filter(Boolean), { actorId: i.user.id });
        return i.editReply({
          embeds: [brandEmbed(result.errors.length ? "⚡ Setup finished with warnings" : "✅ Setup complete", summarise(result, false), result.errors.length ? BRAND.warning : BRAND.success)],
          components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Fine-tune in the dashboard").setURL(`${env.DASHBOARD_URL.replace(/\/$/, "")}/dashboard/${i.guildId}/tools`))],
        });
      } catch (err) { return i.editReply({ embeds: [fail((err as Error).message)] }); }
    }
  },
};

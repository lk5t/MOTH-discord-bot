import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, PermissionFlagsBits, SlashCommandBuilder, TextInputBuilder, TextInputStyle,
  type ButtonInteraction, type ChatInputCommandInteraction, type EmbedBuilder, type ModalSubmitInteraction,
} from "discord.js";
import { and, desc, eq } from "drizzle-orm";
import { architectSessions, BUILTIN_TEMPLATES, getDb, type ArchitectPlan, type ServerAnalysis, truncate } from "@moth/core";
import { cid, type ComponentHandler, type SlashCommand } from "./types.js";
import { applySession, createSession, architectTurn, getSession, rollbackSession, type Session } from "../architect/session.js";
import { brandEmbed, BRAND, fail, ok } from "../lib/embeds.js";
import { hasAccess } from "../lib/permissions.js";
import { respond } from "../lib/util.js";
import { env } from "../env.js";

const MODE_LABEL = { create: "New server", quick: "Quick edit", improve: "Smart improve", redesign: "Full redesign" } as const;

export function previewEmbeds(s: Session): EmbedBuilder[] {
  const plan = s.plan as ArchitectPlan | null;
  const last = [...(s.messages ?? [])].reverse().find((m) => m.role === "assistant");
  const head = brandEmbed(`🦋 MOTH Architect · ${MODE_LABEL[s.mode]}`, truncate(last?.content ?? "Describe what you want.", 4000));
  const out = [head];
  const analysis = s.analysis as ServerAnalysis | null;
  if (analysis) out.push(brandEmbed(`Server health: ${analysis.score}/100`, analysis.findings.slice(0, 10).map((f) => `${{ critical: "🔴", high: "🟠", medium: "🟡", low: "🔵", info: "⚪" }[f.severity]} **${f.title}** — ${truncate(f.detail, 140)}`).join("\n") || "No issues found.", BRAND.info));
  if (plan) {
    const lines = plan.ops.map((o) => `${o.destructive ? "⚠️" : "•"} ${o.description}`);
    const e = brandEmbed(`Preview · ${plan.summary.creates} create · ${plan.summary.updates} update · ${plan.summary.deletes} delete · ${plan.summary.features} features`, truncate(lines.join("\n"), 3900), BRAND.dark);
    if (plan.summary.destructive) e.addFields({ name: "⚠️ Destructive changes", value: `${plan.summary.destructive} change(s) delete or restrict things. Use **Apply all** to include them, or **Apply safe** to skip them.` });
    if (plan.warnings.length) e.addFields({ name: "Notes", value: truncate(plan.warnings.slice(0, 6).join("\n"), 1024) });
    e.setFooter({ text: `Full interactive preview: ${env.DASHBOARD_URL} · a backup is taken before applying` });
    out.push(e);
  }
  return out;
}

function controls(s: Session) {
  const plan = s.plan as ArchitectPlan | null;
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(cid("arch", "refine", s.id)).setLabel("Refine").setEmoji("💬").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(cid("arch", "apply", s.id, "safe")).setLabel("Apply safe").setEmoji("✅").setStyle(ButtonStyle.Success).setDisabled(!plan?.ops.length),
  );
  if (plan?.summary.destructive) row.addComponents(new ButtonBuilder().setCustomId(cid("arch", "confirm", s.id)).setLabel("Apply all").setEmoji("⚠️").setStyle(ButtonStyle.Danger));
  row.addComponents(new ButtonBuilder().setCustomId(cid("arch", "cancel", s.id)).setLabel("Cancel").setStyle(ButtonStyle.Secondary));
  return [row];
}

async function startWith(i: ChatInputCommandInteraction<"cached">, mode: Session["mode"], prompt: string) {
  await i.deferReply({ ephemeral: true });
  try {
    const s = await createSession(i.guild, i.user.id, mode, prompt);
    await i.editReply({ embeds: previewEmbeds(s), components: controls(s) });
  } catch (err) { await i.editReply({ embeds: [fail(`Architect failed: ${(err as Error).message}`)] }); }
}

export const architectCommands: SlashCommand[] = [{
  data: new SlashCommandBuilder().setName("architect").setDescription("MOTH Architect — AI server design & editing").setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setDMPermission(false)
    .addSubcommand((s) => s.setName("create").setDescription("Design this server from a description").addStringOption((o) => o.setName("description").setDescription("Describe the server you want").setRequired(true).setMaxLength(2000)))
    .addSubcommand((s) => s.setName("template").setDescription("Start from a built-in blueprint").addStringOption((o) => o.setName("template").setDescription("Template").setRequired(true).addChoices(...BUILTIN_TEMPLATES.map((t) => ({ name: t.name, value: t.id })))))
    .addSubcommand((s) => s.setName("edit").setDescription("Quick edit with natural language").addStringOption((o) => o.setName("request").setDescription("e.g. Create a new gaming section").setRequired(true).setMaxLength(2000)))
    .addSubcommand((s) => s.setName("improve").setDescription("Analyse the server and recommend improvements").addStringOption((o) => o.setName("focus").setDescription("Optional focus, e.g. security").setMaxLength(500)))
    .addSubcommand((s) => s.setName("redesign").setDescription("Prepare a full structural & visual redesign").addStringOption((o) => o.setName("direction").setDescription("Describe the new direction").setMaxLength(2000)))
    .addSubcommand((s) => s.setName("history").setDescription("Recent Architect sessions"))
    .addSubcommand((s) => s.setName("rollback").setDescription("Roll back the most recently applied Architect change")).toJSON(),
  access: "admin",
  async execute(i) {
    const sub = i.options.getSubcommand();
    if (sub === "create") return startWith(i, "create", i.options.getString("description", true));
    if (sub === "template") return startWith(i, "create", `template:${i.options.getString("template", true)}`);
    if (sub === "edit") return startWith(i, "quick", i.options.getString("request", true));
    if (sub === "improve") return startWith(i, "improve", i.options.getString("focus") ?? "Analyse my server and recommend improvements.");
    if (sub === "redesign") return startWith(i, "redesign", i.options.getString("direction") ?? "Completely reorganise my server with a clean, consistent, professional structure.");
    const db = getDb();
    if (sub === "history") {
      const rows = await db.select().from(architectSessions).where(eq(architectSessions.guildId, i.guildId)).orderBy(desc(architectSessions.createdAt)).limit(10);
      return void i.reply({ embeds: [brandEmbed("Architect history", rows.map((r) => `\`${r.status}\` **${MODE_LABEL[r.mode]}** — ${truncate(r.title ?? "untitled", 60)} <t:${Math.floor(r.createdAt.getTime() / 1000)}:R>`).join("\n") || "No sessions yet.")], ephemeral: true });
    }
    if (sub === "rollback") {
      const [last] = await db.select().from(architectSessions).where(and(eq(architectSessions.guildId, i.guildId), eq(architectSessions.status, "applied"))).orderBy(desc(architectSessions.updatedAt)).limit(1);
      if (!last) return void i.reply({ embeds: [fail("No applied Architect change to roll back.")], ephemeral: true });
      return void i.reply({
        embeds: [brandEmbed("Roll back Architect change?", `**${truncate(last.title ?? last.mode, 100)}** applied <t:${Math.floor(last.updatedAt.getTime() / 1000)}:R>.\nCreated roles/channels will be deleted, edited ones restored and deleted ones recreated from the backup.`, BRAND.warning)],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(cid("arch", "rollback", last.id)).setLabel("Roll back").setStyle(ButtonStyle.Danger))], ephemeral: true,
      });
    }
  },
}];

export const architectComponents: ComponentHandler = {
  prefix: "arch",
  async handle(i, [action, id, flag]) {
    if (!(await hasAccess(i.member, "admin"))) return respond(i, { embeds: [fail("Only server admins can use the Architect.")], ephemeral: true });
    const s = await getSession(i.guildId, id);
    if (!s) return respond(i, { embeds: [fail("Session not found.")], ephemeral: true });
    if (action === "refine") {
      return (i as ButtonInteraction).showModal(new ModalBuilder().setCustomId(cid("arch", "refined", s.id)).setTitle("Refine the proposal").addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("msg").setLabel("What should change?").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(2000))));
    }
    if (action === "refined" && i.isModalSubmit()) {
      await i.deferUpdate();
      const u = await architectTurn(i.guild, s, (i as ModalSubmitInteraction).fields.getTextInputValue("msg"));
      await i.editReply({ embeds: previewEmbeds(u), components: controls(u) });
      return;
    }
    if (action === "cancel") {
      await getDb().update(architectSessions).set({ status: "cancelled" }).where(eq(architectSessions.id, s.id));
      if (i.isButton()) await i.update({ embeds: [brandEmbed(undefined, "Architect session cancelled. Nothing was changed.", BRAND.info)], components: [] });
      return;
    }
    if (action === "confirm" && i.isButton()) {
      const plan = s.plan as ArchitectPlan;
      return i.update({
        embeds: [brandEmbed("⚠️ Confirm destructive changes", plan.ops.filter((o) => o.destructive).map((o) => `• ${o.description}`).join("\n").slice(0, 3800) + "\n\nA full backup is taken first and you can roll back with `/architect rollback`.", BRAND.danger)],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(cid("arch", "apply", s.id, "all")).setLabel("Yes, apply everything").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(cid("arch", "apply", s.id, "safe")).setLabel("Apply safe only").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(cid("arch", "cancel", s.id)).setLabel("Cancel").setStyle(ButtonStyle.Secondary))],
      });
    }
    if (action === "apply" && i.isButton()) {
      const plan = s.plan as ArchitectPlan;
      await i.update({ embeds: [brandEmbed("🦋 Building…", "Taking a backup and applying changes. This can take a minute on large plans.", BRAND.info)], components: [] });
      let last = 0;
      try {
        const { result } = await applySession(i.guild, s, i.user.id, { approveDestructive: flag === "all" ? plan.ops.filter((o) => o.destructive).map((o) => o.id) : [] }, (d, t, desc) => {
          if (Date.now() - last > 2500) { last = Date.now(); void i.editReply({ embeds: [brandEmbed("🦋 Building…", `${d}/${t} · ${desc}`, BRAND.info)] }).catch(() => undefined); }
        });
        const e = brandEmbed("✅ Architect changes applied", `**${result.completed.length}** changes applied, **${result.skipped.length}** skipped, **${result.errors.length}** failed.\nUse \`/architect rollback\` to undo.`, result.errors.length ? BRAND.warning : BRAND.success);
        if (result.errors.length) e.addFields({ name: "Errors", value: truncate(result.errors.map((x) => `• ${x.description}: ${x.error}`).join("\n"), 1024) });
        await i.editReply({ embeds: [e] }).catch(() => undefined);
      } catch (err) { await i.editReply({ embeds: [fail(`Apply failed: ${(err as Error).message}`)] }).catch(() => undefined); }
      return;
    }
    if (action === "rollback" && i.isButton()) {
      await i.update({ embeds: [brandEmbed("Rolling back…", "Restoring from backup.", BRAND.info)], components: [] });
      try {
        const r = await rollbackSession(i.guild, s, i.user.id);
        await i.editReply({ embeds: [r.errors.length ? brandEmbed("Rollback finished with issues", `${r.restored} items restored.\n${truncate(r.errors.join("\n"), 3000)}`, BRAND.warning) : ok(`Rollback complete — ${r.restored} items restored.`)] }).catch(() => undefined);
      } catch (err) { await i.editReply({ embeds: [fail((err as Error).message)] }).catch(() => undefined); }
    }
  },
};

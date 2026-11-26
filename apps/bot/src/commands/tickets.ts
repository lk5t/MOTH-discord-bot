import { PermissionFlagsBits, SlashCommandBuilder, type TextChannel } from "discord.js";
import { and, eq, sql } from "drizzle-orm";
import { getDb, ticketPanels, tickets } from "@moth/core";
import type { SlashCommand } from "./types.js";
import { closeTicket, claimTicket, publishPanel, reopenTicket, setPriority, ticketForChannel } from "../modules/tickets.js";
import { brandEmbed, ok, fail } from "../lib/embeds.js";
import { env } from "../env.js";

export const ticketCommands: SlashCommand[] = [{
  data: new SlashCommandBuilder().setName("ticket").setDescription("Ticket tools").setDMPermission(false)
    .addSubcommand((s) => s.setName("close").setDescription("Close this ticket").addStringOption((o) => o.setName("reason").setDescription("Reason")))
    .addSubcommand((s) => s.setName("reopen").setDescription("Reopen this ticket"))
    .addSubcommand((s) => s.setName("claim").setDescription("Claim / unclaim this ticket"))
    .addSubcommand((s) => s.setName("add").setDescription("Add a member to this ticket").addUserOption((o) => o.setName("user").setDescription("User").setRequired(true)))
    .addSubcommand((s) => s.setName("remove").setDescription("Remove a member from this ticket").addUserOption((o) => o.setName("user").setDescription("User").setRequired(true)))
    .addSubcommand((s) => s.setName("rename").setDescription("Rename this ticket").addStringOption((o) => o.setName("name").setDescription("New name").setRequired(true).setMaxLength(90)))
    .addSubcommand((s) => s.setName("priority").setDescription("Set priority").addStringOption((o) => o.setName("level").setDescription("Priority").setRequired(true).addChoices(...["low", "normal", "high", "urgent"].map((v) => ({ name: v, value: v })))))
    .addSubcommand((s) => s.setName("assign").setDescription("Assign a staff member").addUserOption((o) => o.setName("user").setDescription("Staff member").setRequired(true)))
    .addSubcommand((s) => s.setName("panel").setDescription("Publish a ticket panel").addStringOption((o) => o.setName("name").setDescription("Panel name (create panels in the dashboard)").setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName("stats").setDescription("Ticket statistics")).toJSON(),
  subAccess: { panel: "admin", stats: "moderator" },
  async autocomplete(i) {
    const rows = await getDb().select({ id: ticketPanels.id, name: ticketPanels.name }).from(ticketPanels).where(eq(ticketPanels.guildId, i.guildId));
    const q = i.options.getFocused().toLowerCase();
    await i.respond(rows.filter((r) => r.name.toLowerCase().includes(q)).slice(0, 25).map((r) => ({ name: r.name, value: r.id })));
  },
  async execute(i) {
    const sub = i.options.getSubcommand();
    const db = getDb();
    if (sub === "panel") {
      await i.deferReply({ ephemeral: true });
      try { const r = await publishPanel(i.guild, i.options.getString("name", true)); await i.editReply({ embeds: [ok(`Panel published in <#${r.channelId}>.`)] }); }
      catch (err) { await i.editReply({ embeds: [fail(`${(err as Error).message}. Create panels at ${env.DASHBOARD_URL}.`)] }); }
      return;
    }
    if (sub === "stats") {
      const [s] = await db.select({
        open: sql<number>`count(*) filter (where status = 'open')`, closed: sql<number>`count(*) filter (where status <> 'open')`,
        avgFirst: sql<number>`avg(extract(epoch from (first_response_at - created_at))) filter (where first_response_at is not null)`,
        avgResolve: sql<number>`avg(extract(epoch from (closed_at - created_at))) filter (where closed_at is not null)`,
        week: sql<number>`count(*) filter (where created_at > now() - interval '7 days')`,
      }).from(tickets).where(eq(tickets.guildId, i.guildId));
      const fmt = (sec: number | null) => (sec ? `${Math.round(Number(sec) / 60)} min` : "—");
      return void i.reply({ embeds: [brandEmbed("🎫 Ticket statistics", `**Open:** ${s.open}\n**Closed:** ${s.closed}\n**Opened this week:** ${s.week}\n**Avg first response:** ${fmt(s.avgFirst)}\n**Avg resolution:** ${fmt(s.avgResolve)}`)], ephemeral: true });
    }
    const t = await ticketForChannel(i.channelId);
    if (!t) return void i.reply({ embeds: [fail("This isn't a ticket channel.")], ephemeral: true });
    const ch = i.channel as TextChannel;
    const staffish = i.member.permissions.has(PermissionFlagsBits.ManageMessages) || t.openerId !== i.user.id;
    try {
      switch (sub) {
        case "close": await i.deferReply({ ephemeral: true }); await closeTicket(i.member, t.id, i.options.getString("reason") ?? undefined); return void i.editReply({ embeds: [ok("Ticket closed.")] });
        case "reopen": await i.deferReply({ ephemeral: true }); await reopenTicket(i.member, t.id); return void i.editReply({ embeds: [ok("Ticket reopened.")] });
        case "claim": { const c = await claimTicket(i.member, t.id); return void i.reply({ embeds: [ok(c ? "You claimed this ticket." : "Ticket unclaimed.")] }); }
        case "add": { const u = i.options.getUser("user", true); await ch.permissionOverwrites.edit(u.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }); return void i.reply({ embeds: [ok(`Added <@${u.id}>.`)] }); }
        case "remove": { if (!staffish) throw new Error("Only staff can remove members"); const u = i.options.getUser("user", true); await ch.permissionOverwrites.delete(u.id); return void i.reply({ embeds: [ok(`Removed <@${u.id}>.`)] }); }
        case "rename": await ch.setName(i.options.getString("name", true)); return void i.reply({ embeds: [ok("Ticket renamed.")] });
        case "priority": { if (!staffish) throw new Error("Only staff can set priority"); const p = i.options.getString("level", true) as "low"; await setPriority(t.id, p, ch); return void i.reply({ embeds: [ok(`Priority set to **${p}**.`)] }); }
        case "assign": {
          if (!staffish) throw new Error("Only staff can assign tickets");
          const u = i.options.getUser("user", true);
          await db.update(tickets).set({ assigneeIds: [...new Set([...t.assigneeIds, u.id])] }).where(and(eq(tickets.id, t.id)));
          await ch.permissionOverwrites.edit(u.id, { ViewChannel: true, SendMessages: true });
          return void i.reply({ embeds: [ok(`Assigned <@${u.id}> to this ticket.`)] });
        }
      }
    } catch (err) { await (i.deferred ? i.editReply({ embeds: [fail((err as Error).message)] }) : i.reply({ embeds: [fail((err as Error).message)], ephemeral: true })); }
  },
}];

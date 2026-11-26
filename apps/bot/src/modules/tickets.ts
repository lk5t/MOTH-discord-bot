import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelType, ModalBuilder, OverwriteType, PermissionFlagsBits,
  StringSelectMenuBuilder, TextInputBuilder, TextInputStyle, type Guild, type GuildMember, type Message, type TextChannel,
  type MessageComponentInteraction, type ModalSubmitInteraction,
} from "discord.js";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  getDb, getGuildConfig, publishEvent, ticketPanels, tickets, ticketTranscripts, scheduledJobs, resolveAIClient, buildPersonalityPrompt, recordAIUsage,
  type TicketCategoryDef, type EmbedData,
} from "@moth/core";
import { brandEmbed, BRAND, toApiEmbed, ok, fail } from "../lib/embeds.js";
import { cid, type ComponentHandler } from "../commands/types.js";
import { sendLog } from "../lib/logs.js";
import { respond } from "../lib/util.js";
import { log } from "../context.js";
import { fireAutomations } from "./automation.js";

const PRIORITY_EMOJI = { low: "🟢", normal: "🔵", high: "🟠", urgent: "🔴" } as const;
type Priority = keyof typeof PRIORITY_EMOJI;
type Panel = typeof ticketPanels.$inferSelect;
type Ticket = typeof tickets.$inferSelect;

/** Publishes (or re-publishes) a ticket panel message. */
export async function publishPanel(guild: Guild, panelId: string): Promise<{ channelId: string; messageId: string }> {
  const db = getDb();
  const [panel] = await db.select().from(ticketPanels).where(and(eq(ticketPanels.id, panelId), eq(ticketPanels.guildId, guild.id)));
  if (!panel) throw new Error("Panel not found");
  if (!panel.channelId) throw new Error("Panel has no channel");
  const channel = await guild.channels.fetch(panel.channelId).catch(() => null);
  if (!channel?.isTextBased() || !("send" in channel)) throw new Error("Panel channel not found or not a text channel");
  const embed = toApiEmbed({ color: "#DC143C", ...(panel.embed as EmbedData) });
  const cats = panel.categories;
  const components = panel.style === "select" || cats.length > 5
    ? [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId(cid("ticket", "open", panel.id)).setPlaceholder("Choose a ticket category…")
        .addOptions(cats.slice(0, 25).map((c) => ({ label: c.label.slice(0, 100), value: c.id, description: c.description?.slice(0, 100), emoji: c.emoji || undefined }))))]
    : [new ActionRowBuilder<ButtonBuilder>().addComponents(cats.map((c) => { const b = new ButtonBuilder().setCustomId(cid("ticket", "open", panel.id, c.id)).setLabel(c.label.slice(0, 80)).setStyle(ButtonStyle.Secondary); if (c.emoji) b.setEmoji(c.emoji); return b; }))];
  let message: Message | null = null;
  if (panel.messageId) {
    message = await channel.messages.fetch(panel.messageId).catch(() => null);
    if (message) await message.edit({ embeds: [embed], components });
  }
  if (!message) message = await channel.send({ embeds: [embed], components });
  await db.update(ticketPanels).set({ messageId: message.id, updatedAt: new Date() }).where(eq(ticketPanels.id, panel.id));
  return { channelId: channel.id, messageId: message.id };
}

function ticketControls(t: Pick<Ticket, "id" | "status" | "claimedById">) {
  const row = new ActionRowBuilder<ButtonBuilder>();
  if (t.status === "open") {
    row.addComponents(
      new ButtonBuilder().setCustomId(cid("ticket", "claim", t.id)).setLabel(t.claimedById ? "Unclaim" : "Claim").setEmoji("🙋").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(cid("ticket", "close", t.id)).setLabel("Close").setEmoji("🔒").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(cid("ticket", "transcript", t.id)).setLabel("Transcript").setEmoji("📄").setStyle(ButtonStyle.Secondary),
    );
  } else {
    row.addComponents(
      new ButtonBuilder().setCustomId(cid("ticket", "reopen", t.id)).setLabel("Reopen").setEmoji("🔓").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(cid("ticket", "delete", t.id)).setLabel("Delete").setEmoji("🗑️").setStyle(ButtonStyle.Danger),
    );
  }
  const prio = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId(cid("ticket", "priority", t.id)).setPlaceholder("Set priority")
    .addOptions((Object.keys(PRIORITY_EMOJI) as Priority[]).map((p) => ({ label: p[0].toUpperCase() + p.slice(1), value: p, emoji: PRIORITY_EMOJI[p] }))));
  return t.status === "open" ? [row, prio] : [row];
}

async function isStaff(member: GuildMember, panel: Panel | undefined, cat?: TicketCategoryDef): Promise<boolean> {
  if (member.permissions.has(PermissionFlagsBits.ManageChannels) || member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  const roles = new Set([...(panel?.staffRoleIds ?? []), ...(cat?.staffRoleIds ?? [])]);
  const cfg = await getGuildConfig(member.guild.id);
  cfg.moderation.moderatorRoleIds.forEach((r) => roles.add(r));
  return member.roles.cache.some((r) => roles.has(r.id));
}

async function loadTicket(id: string) {
  const [t] = await getDb().select().from(tickets).where(eq(tickets.id, id));
  if (!t) return null;
  const [panel] = t.panelId ? await getDb().select().from(ticketPanels).where(eq(ticketPanels.id, t.panelId)) : [];
  const cat = panel?.categories.find((c) => c.id === t.categoryId);
  return { t, panel, cat };
}

export async function ticketForChannel(channelId: string) {
  const [t] = await getDb().select().from(tickets).where(eq(tickets.channelId, channelId)).orderBy(desc(tickets.createdAt)).limit(1);
  return t ?? null;
}

/** Opens a ticket channel for a member. */
export async function openTicket(member: GuildMember, panel: Panel, cat: TicketCategoryDef, answers: { question: string; answer: string }[] = []): Promise<TextChannel> {
  const guild = member.guild;
  const cfg = await getGuildConfig(guild.id);
  const db = getDb();
  const [{ open }] = await db.select({ open: sql<number>`count(*)` }).from(tickets).where(and(eq(tickets.guildId, guild.id), eq(tickets.openerId, member.id), eq(tickets.status, "open")));
  if (Number(open) >= cfg.tickets.maxOpenPerUser) throw new Error(`You already have ${open} open ticket(s). Please use your existing ticket.`);

  const number = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"ticket:" + guild.id}))`);
    const [{ n }] = await tx.select({ n: sql<number>`coalesce(max(${tickets.number}), 0) + 1` }).from(tickets).where(eq(tickets.guildId, guild.id));
    return Number(n);
  });
  const staffRoles = [...new Set([...panel.staffRoleIds, ...cat.staffRoleIds])].filter((id) => guild.roles.cache.has(id));
  const name = cfg.tickets.namingPattern.replace("{number}", String(number).padStart(4, "0")).replace("{user}", member.user.username).replace("{category}", cat.label).toLowerCase().replace(/[^a-z0-9-_]+/g, "-").slice(0, 90);
  const parentId = cat.parentCategoryId ?? panel.parentCategoryId ?? undefined;
  const parent = parentId ? guild.channels.cache.get(parentId) : undefined;
  const me = guild.members.me!;
  const channel = await guild.channels.create({
    name, type: ChannelType.GuildText, parent: parent?.type === ChannelType.GuildCategory ? parent.id : undefined,
    topic: `Ticket #${number} · ${cat.label} · opened by ${member.user.username} (${member.id})`,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
      { id: me.id, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles] },
      { id: member.id, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks] },
      ...staffRoles.map((id) => ({ id, type: OverwriteType.Role, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ManageMessages] })),
    ],
    reason: `Ticket #${number} opened by ${member.user.username}`,
  });
  const [t] = await db.insert(tickets).values({
    guildId: guild.id, panelId: panel.id, categoryId: cat.id, categoryLabel: cat.label, number, channelId: channel.id,
    openerId: member.id, openerTag: member.user.username, priority: cat.defaultPriority ?? "normal", answers: answers.length ? answers : null,
    subject: answers[0]?.answer?.slice(0, 200) ?? null,
  }).returning();

  const embed = brandEmbed(`${cat.emoji ? cat.emoji + " " : ""}${cat.label} · Ticket #${number}`, (cat.openMessage ?? "Thanks for reaching out, {user}! A member of staff will be with you shortly. Please describe your issue in as much detail as possible.").replace(/\{user\}/g, `<@${member.id}>`))
    .addFields({ name: "Priority", value: `${PRIORITY_EMOJI[t.priority]} ${t.priority}`, inline: true }, { name: "Status", value: "Open", inline: true });
  for (const a of answers) embed.addFields({ name: a.question.slice(0, 256), value: a.answer.slice(0, 1024) || "—" });
  await channel.send({ content: `<@${member.id}> ${staffRoles.map((r) => `<@&${r}>`).join(" ")}`, embeds: [embed], components: ticketControls(t), allowedMentions: { users: [member.id], roles: staffRoles } });
  await publishEvent("ticket.updated", guild.id, { id: t.id, number, status: "open" });
  void fireAutomations(guild, "ticket_opened", { member, channel });
  if (cfg.tickets.aiFirstResponse && answers.length) void aiFirstResponse(channel, cat, answers).catch(() => undefined);
  return channel;
}

async function aiFirstResponse(channel: TextChannel, cat: TicketCategoryDef, answers: { question: string; answer: string }[]) {
  const cfg = await getGuildConfig(channel.guildId);
  const ai = await resolveAIClient(channel.guildId, cfg.ai.providerId);
  if (!ai) return;
  const r = await ai.complete([
    { role: "system", content: buildPersonalityPrompt(cfg.ai, channel.guild.name) + "\n\nYou are drafting a first response in a support ticket. Acknowledge the issue, ask for any missing details, and offer general guidance. Make clear a human staff member will follow up." },
    { role: "user", content: `Ticket category: ${cat.label}\n${answers.map((a) => `${a.question}: ${a.answer}`).join("\n")}` },
  ], { maxTokens: 400 });
  await recordAIUsage({ guildId: channel.guildId, feature: "ticket_first_response", inputTokens: r.inputTokens, outputTokens: r.outputTokens, providerKind: ai.config.kind });
  await channel.send({ embeds: [brandEmbed("🤖 Automated first response", r.text.slice(0, 4000), BRAND.info).setFooter({ text: "AI-generated · a staff member will follow up" })] });
}

/** Generates a self-contained HTML transcript of a ticket channel. */
export async function generateTranscript(channel: TextChannel, t: Ticket): Promise<{ html: string; count: number }> {
  const all: Message[] = [];
  let before: string | undefined;
  for (let i = 0; i < 20; i++) { // up to 2000 messages
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (!batch.size) break;
    all.push(...batch.values()); before = batch.last()!.id;
    if (batch.size < 100) break;
  }
  all.reverse();
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  const rows = all.map((m) => `<div class="m"><img src="${esc(m.author.displayAvatarURL({ size: 64 }))}" alt=""><div><div class="h"><b>${esc(m.member?.displayName ?? m.author.username)}</b>${m.author.bot ? '<span class="bot">BOT</span>' : ""}<time>${m.createdAt.toISOString().replace("T", " ").slice(0, 19)} UTC</time></div>${m.content ? `<p>${esc(m.content).replace(/\n/g, "<br>")}</p>` : ""}${m.embeds.map((e) => `<div class="e">${e.title ? `<b>${esc(e.title)}</b><br>` : ""}${e.description ? esc(e.description).replace(/\n/g, "<br>") : ""}${e.fields.map((f) => `<div><b>${esc(f.name)}</b><br>${esc(f.value)}</div>`).join("")}</div>`).join("")}${[...m.attachments.values()].map((a) => `<a href="${esc(a.url)}">📎 ${esc(a.name)}</a>`).join(" ")}</div></div>`).join("\n");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Ticket #${t.number} transcript</title><style>body{background:#0a0a0a;color:#e5e5e5;font:14px/1.5 system-ui,sans-serif;margin:0;padding:24px}header{border-bottom:1px solid #262626;margin-bottom:16px;padding-bottom:12px}h1{color:#dc143c;margin:0 0 4px;font-size:20px}.m{display:flex;gap:12px;padding:8px 0}.m img{width:36px;height:36px;border-radius:50%}.h time{color:#737373;font-size:12px;margin-left:8px}.bot{background:#dc143c;color:#fff;font-size:10px;padding:1px 4px;border-radius:3px;margin-left:6px}p{margin:2px 0}.e{border-left:3px solid #dc143c;background:#171717;padding:8px 12px;margin:4px 0;border-radius:4px}a{color:#fb7185}</style></head><body><header><h1>Ticket #${t.number} · ${esc(t.categoryLabel ?? "")}</h1><div>Opened by ${esc(t.openerTag ?? t.openerId)} · ${t.createdAt.toISOString()} · ${all.length} messages</div></header>${rows}</body></html>`;
  return { html, count: all.length };
}

export async function closeTicket(actor: GuildMember, ticketId: string, reason?: string): Promise<void> {
  const loaded = await loadTicket(ticketId);
  if (!loaded) throw new Error("Ticket not found");
  const { t } = loaded;
  if (t.status !== "open") throw new Error("Ticket is already closed");
  const guild = actor.guild;
  const cfg = await getGuildConfig(guild.id);
  const channel = t.channelId ? (await guild.channels.fetch(t.channelId).catch(() => null)) as TextChannel | null : null;
  const db = getDb();
  await db.update(tickets).set({ status: "closed", closedAt: new Date(), closedById: actor.id, closeReason: reason ?? null }).where(eq(tickets.id, t.id));
  if (channel) {
    const { html, count } = await generateTranscript(channel, t);
    await db.insert(ticketTranscripts).values({ ticketId: t.id, html, messageCount: count });
    const file = () => new AttachmentBuilder(Buffer.from(html, "utf8"), { name: `ticket-${t.number}.html` });
    const summary = brandEmbed(`Ticket #${t.number} closed`, `**Category:** ${t.categoryLabel}\n**Opened by:** <@${t.openerId}>\n**Closed by:** <@${actor.id}>\n**Claimed by:** ${t.claimedById ? `<@${t.claimedById}>` : "—"}\n**Reason:** ${reason ?? "—"}\n**Messages:** ${count}`, BRAND.info).setTimestamp();
    if (cfg.tickets.transcriptChannelId) {
      const tc = await guild.channels.fetch(cfg.tickets.transcriptChannelId).catch(() => null);
      if (tc?.isTextBased() && "send" in tc) await tc.send({ embeds: [summary], files: [file()] }).catch(() => undefined);
    }
    if (cfg.tickets.dmTranscript) {
      const opener = await guild.client.users.fetch(t.openerId).catch(() => null);
      await opener?.send({ embeds: [summary.setTitle(`Your ticket #${t.number} in ${guild.name} was closed`)], files: [file()] }).catch(() => undefined);
    }
    await channel.permissionOverwrites.edit(t.openerId, { SendMessages: false }).catch(() => undefined);
    await channel.send({ embeds: [brandEmbed("🔒 Ticket closed", `Closed by <@${actor.id}>${reason ? `: ${reason}` : ""}.`, BRAND.info)], components: ticketControls({ ...t, status: "closed" }) });
    if (cfg.tickets.deleteOnClose) {
      await db.insert(scheduledJobs).values({ guildId: guild.id, kind: "ticket-delete", runAt: new Date(Date.now() + cfg.tickets.deleteDelaySeconds * 1000), payload: { ticketId: t.id, channelId: channel.id } });
    } else if (cfg.tickets.archiveCategoryId && guild.channels.cache.has(cfg.tickets.archiveCategoryId)) {
      await channel.setParent(cfg.tickets.archiveCategoryId, { lockPermissions: false }).catch(() => undefined);
      await db.update(tickets).set({ status: "archived" }).where(eq(tickets.id, t.id));
    }
  }
  await sendLog(guild, "general", brandEmbed(`Ticket #${t.number} closed`, `By <@${actor.id}> · ${reason ?? "no reason"}`, BRAND.info));
  await publishEvent("ticket.updated", guild.id, { id: t.id, number: t.number, status: "closed" });
  void fireAutomations(guild, "ticket_closed", { member: actor, channel: channel ?? undefined });
}

export async function reopenTicket(actor: GuildMember, ticketId: string): Promise<void> {
  const loaded = await loadTicket(ticketId);
  if (!loaded) throw new Error("Ticket not found");
  const { t } = loaded;
  const channel = t.channelId ? (await actor.guild.channels.fetch(t.channelId).catch(() => null)) as TextChannel | null : null;
  if (!channel) throw new Error("The ticket channel no longer exists");
  await channel.permissionOverwrites.edit(t.openerId, { ViewChannel: true, SendMessages: true }).catch(() => undefined);
  if (loaded.panel) {
    const parent = loaded.cat?.parentCategoryId ?? loaded.panel.parentCategoryId;
    if (parent && channel.parentId !== parent) await channel.setParent(parent, { lockPermissions: false }).catch(() => undefined);
  }
  await getDb().update(tickets).set({ status: "open", closedAt: null, closedById: null, closeReason: null, lastActivityAt: new Date() }).where(eq(tickets.id, t.id));
  await channel.send({ embeds: [brandEmbed("🔓 Ticket reopened", `Reopened by <@${actor.id}>.`, BRAND.success)], components: ticketControls({ ...t, status: "open" }) });
  await publishEvent("ticket.updated", actor.guild.id, { id: t.id, number: t.number, status: "open" });
}

export async function setPriority(ticketId: string, priority: Priority, channel?: TextChannel | null) {
  await getDb().update(tickets).set({ priority }).where(eq(tickets.id, ticketId));
  if (channel && priority === "urgent" && !channel.name.startsWith("🔴")) await channel.setName(`🔴${channel.name}`.slice(0, 100)).catch(() => undefined);
  const [t] = await getDb().select().from(tickets).where(eq(tickets.id, ticketId));
  if (t) await publishEvent("ticket.updated", t.guildId, { id: t.id, priority });
}

export async function claimTicket(member: GuildMember, ticketId: string): Promise<boolean> {
  const loaded = await loadTicket(ticketId);
  if (!loaded) throw new Error("Ticket not found");
  const claimed = loaded.t.claimedById === member.id ? null : member.id;
  if (loaded.t.claimedById && loaded.t.claimedById !== member.id && !member.permissions.has(PermissionFlagsBits.ManageGuild)) throw new Error(`Already claimed by <@${loaded.t.claimedById}>.`);
  await getDb().update(tickets).set({ claimedById: claimed, assigneeIds: claimed ? [...new Set([...loaded.t.assigneeIds, claimed])] : loaded.t.assigneeIds }).where(eq(tickets.id, ticketId));
  await publishEvent("ticket.updated", member.guild.id, { id: ticketId, claimedById: claimed });
  return !!claimed;
}

/** Marks first staff response & last activity, used for statistics and auto-close. */
export async function trackTicketActivity(message: Message<true>): Promise<void> {
  if (message.author.bot) return;
  const t = await ticketForChannel(message.channelId);
  if (!t || t.status !== "open") return;
  const set: Partial<Ticket> = { lastActivityAt: new Date() };
  if (!t.firstResponseAt && message.author.id !== t.openerId) set.firstResponseAt = new Date();
  await getDb().update(tickets).set(set).where(eq(tickets.id, t.id));
}

export const ticketComponents: ComponentHandler = {
  prefix: "ticket",
  async handle(i, [action, id, extra]) {
    const db = getDb();
    if (action === "open") {
      const [panel] = await db.select().from(ticketPanels).where(and(eq(ticketPanels.id, id), eq(ticketPanels.guildId, i.guildId)));
      if (!panel?.enabled) return respond(i, { embeds: [fail("This ticket panel is no longer active.")], ephemeral: true });
      const catId = extra ?? (i.isStringSelectMenu() ? i.values[0] : undefined);
      const cat = panel.categories.find((c) => c.id === catId);
      if (!cat) return respond(i, { embeds: [fail("Unknown ticket category.")], ephemeral: true });
      if (cat.questions?.length && !i.isModalSubmit()) {
        const modal = new ModalBuilder().setCustomId(cid("ticket", "form", panel.id, cat.id)).setTitle(`${cat.label}`.slice(0, 45));
        cat.questions.slice(0, 5).forEach((q, n) => modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId(`q${n}`).setLabel(q.label.slice(0, 45)).setStyle(q.long ? TextInputStyle.Paragraph : TextInputStyle.Short).setRequired(q.required ?? true).setPlaceholder(q.placeholder?.slice(0, 100) ?? "").setMaxLength(q.long ? 2000 : 200))));
        return (i as MessageComponentInteraction).showModal(modal);
      }
      await i.deferReply({ ephemeral: true });
      try {
        const ch = await openTicket(i.member, panel, cat);
        await i.editReply({ embeds: [ok(`Your ticket has been created: ${ch}`)] });
      } catch (err) { await i.editReply({ embeds: [fail((err as Error).message)] }); }
      return;
    }
    if (action === "form" && i.isModalSubmit()) {
      const [panel] = await db.select().from(ticketPanels).where(eq(ticketPanels.id, id));
      const cat = panel?.categories.find((c) => c.id === extra);
      if (!panel || !cat) return respond(i, { embeds: [fail("Unknown ticket category.")], ephemeral: true });
      const answers = (cat.questions ?? []).slice(0, 5).map((q, n) => ({ question: q.label, answer: (i as ModalSubmitInteraction).fields.getTextInputValue(`q${n}`) }));
      await i.deferReply({ ephemeral: true });
      try {
        const ch = await openTicket(i.member, panel, cat, answers);
        await i.editReply({ embeds: [ok(`Your ticket has been created: ${ch}`)] });
      } catch (err) { await i.editReply({ embeds: [fail((err as Error).message)] }); }
      return;
    }

    const loaded = await loadTicket(id);
    if (!loaded) return respond(i, { embeds: [fail("Ticket not found.")], ephemeral: true });
    const staff = await isStaff(i.member, loaded.panel, loaded.cat);
    const isOpener = loaded.t.openerId === i.user.id;
    const channel = i.channel as TextChannel | null;
    try {
      switch (action) {
        case "claim": {
          if (!staff) return respond(i, { embeds: [fail("Only staff can claim tickets.")], ephemeral: true });
          const claimed = await claimTicket(i.member, id);
          await (i as MessageComponentInteraction).update({ components: ticketControls({ ...loaded.t, claimedById: claimed ? i.user.id : null }) });
          await channel?.send({ embeds: [brandEmbed(undefined, claimed ? `🙋 <@${i.user.id}> claimed this ticket.` : `<@${i.user.id}> unclaimed this ticket.`, BRAND.info)] });
          return;
        }
        case "close": {
          if (!staff && !isOpener) return respond(i, { embeds: [fail("You can't close this ticket.")], ephemeral: true });
          const modal = new ModalBuilder().setCustomId(cid("ticket", "closeconfirm", id)).setTitle("Close ticket")
            .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("reason").setLabel("Reason (optional)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(300)));
          return (i as MessageComponentInteraction).showModal(modal);
        }
        case "closeconfirm": {
          await i.deferReply({ ephemeral: true });
          await closeTicket(i.member, id, (i as ModalSubmitInteraction).fields.getTextInputValue("reason") || undefined);
          await i.editReply({ embeds: [ok("Ticket closed.")] });
          return;
        }
        case "reopen": {
          if (!staff) return respond(i, { embeds: [fail("Only staff can reopen tickets.")], ephemeral: true });
          await i.deferUpdate();
          await reopenTicket(i.member, id);
          return;
        }
        case "delete": {
          if (!staff) return respond(i, { embeds: [fail("Only staff can delete tickets.")], ephemeral: true });
          await respond(i, { embeds: [info5("🗑️ This channel will be deleted in 5 seconds.")] });
          setTimeout(() => void channel?.delete("Ticket deleted").catch(() => undefined), 5000);
          await db.update(tickets).set({ status: "archived", channelId: null }).where(eq(tickets.id, id));
          return;
        }
        case "transcript": {
          if (!staff && !isOpener) return respond(i, { embeds: [fail("Not allowed.")], ephemeral: true });
          await i.deferReply({ ephemeral: true });
          const { html, count } = await generateTranscript(channel!, loaded.t);
          await i.editReply({ content: `Transcript (${count} messages):`, files: [new AttachmentBuilder(Buffer.from(html), { name: `ticket-${loaded.t.number}.html` })] });
          return;
        }
        case "priority": {
          if (!staff) return respond(i, { embeds: [fail("Only staff can change priority.")], ephemeral: true });
          const p = (i as MessageComponentInteraction & { values: string[] }).values[0] as Priority;
          await setPriority(id, p, channel);
          await respond(i, { embeds: [brandEmbed(undefined, `Priority set to ${PRIORITY_EMOJI[p]} **${p}** by <@${i.user.id}>.`, BRAND.info)] });
          return;
        }
      }
    } catch (err) {
      log.warn({ err }, "ticket action failed");
      await respond(i, { embeds: [fail((err as Error).message)], ephemeral: true }).catch(() => undefined);
    }
  },
};

const info5 = (d: string) => brandEmbed(undefined, d, BRAND.info);

/** Auto-closes inactive tickets (scheduler). */
export async function autoCloseInactive(guild: Guild): Promise<void> {
  const cfg = await getGuildConfig(guild.id);
  if (!cfg.tickets.enabled || !cfg.tickets.autoCloseHours) return;
  const cutoff = new Date(Date.now() - cfg.tickets.autoCloseHours * 3_600_000);
  const stale = await getDb().select().from(tickets).where(and(eq(tickets.guildId, guild.id), eq(tickets.status, "open"), sql`${tickets.lastActivityAt} < ${cutoff}`)).limit(20);
  const me = guild.members.me;
  if (!me) return;
  for (const t of stale) await closeTicket(me, t.id, `Automatically closed after ${cfg.tickets.autoCloseHours}h of inactivity`).catch(() => undefined);
}

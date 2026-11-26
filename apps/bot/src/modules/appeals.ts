import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, type Interaction, type ModalSubmitInteraction, type ButtonInteraction } from "discord.js";
import { and, desc, eq, gte } from "drizzle-orm";
import { appeals, getDb, getGuildConfig, modCases } from "@moth/core";
import { brandEmbed, BRAND, ok, fail } from "../lib/embeds.js";
import { cid, type ComponentHandler } from "../commands/types.js";
import { respond } from "../lib/util.js";
import { executeModAction } from "./moderation.js";
import { hasAccess } from "../lib/permissions.js";

/**
 * Ban appeals work from DMs (banned users can't use guild commands):
 * the ban notice has an "Appeal" button → modal → posted to the appeals
 * channel with Accept/Deny for staff.
 */
export async function handleDmAppeal(i: Interaction): Promise<boolean> {
  if (!(i.isButton() || i.isModalSubmit()) || i.inGuild()) return false;
  const [, mod, action, guildId] = i.customId.split(":");
  if (mod !== "appeal") return false;
  const guild = i.client.guilds.cache.get(guildId);
  if (!guild) { await respond(i as ButtonInteraction, { embeds: [fail("That server is no longer available.")] }); return true; }
  const cfg = await getGuildConfig(guild.id);
  if (!cfg.moderation.appeals.enabled || !cfg.moderation.appeals.channelId) { await respond(i as ButtonInteraction, { embeds: [fail("Appeals are not enabled for this server.")] }); return true; }
  const db = getDb();
  if (action === "open" && i.isButton()) {
    const since = new Date(Date.now() - cfg.moderation.appeals.cooldownDays * 86_400_000);
    const [recent] = await db.select().from(appeals).where(and(eq(appeals.guildId, guild.id), eq(appeals.userId, i.user.id), gte(appeals.createdAt, since))).limit(1);
    if (recent) { await respond(i, { embeds: [fail(`You've already appealed recently (status: ${recent.status}).`)] }); return true; }
    await i.showModal(new ModalBuilder().setCustomId(cid("appeal", "submit", guild.id)).setTitle(`Appeal — ${guild.name}`.slice(0, 45)).addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("why").setLabel("Why should your ban be lifted?").setStyle(TextInputStyle.Paragraph).setMinLength(20).setMaxLength(1500).setRequired(true)),
    ));
    return true;
  }
  if (action === "submit" && i.isModalSubmit()) {
    const content = i.fields.getTextInputValue("why");
    const [lastBan] = await db.select().from(modCases).where(and(eq(modCases.guildId, guild.id), eq(modCases.targetId, i.user.id), eq(modCases.type, "ban"))).orderBy(desc(modCases.createdAt)).limit(1);
    const [row] = await db.insert(appeals).values({ guildId: guild.id, userId: i.user.id, userTag: i.user.username, content, caseId: lastBan?.id ?? null }).returning();
    const ch = await guild.channels.fetch(cfg.moderation.appeals.channelId).catch(() => null);
    if (ch?.isTextBased() && "send" in ch) {
      await ch.send({
        embeds: [brandEmbed(`Ban appeal #${row.id}`, `**User:** <@${i.user.id}> \`${i.user.username}\` (${i.user.id})\n**Case:** ${lastBan ? `#${lastBan.caseNumber} — ${lastBan.reason}` : "unknown"}\n\n${content}`, BRAND.warning).setTimestamp()],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(cid("appealreview", "accept", row.id)).setLabel("Accept & unban").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(cid("appealreview", "deny", row.id)).setLabel("Deny").setStyle(ButtonStyle.Danger),
        )],
      });
    }
    await respond(i as ModalSubmitInteraction, { embeds: [ok("Your appeal has been submitted. You'll receive a DM when it's reviewed.")] });
    return true;
  }
  return false;
}

export const appealReviewComponents: ComponentHandler = {
  prefix: "appealreview",
  async handle(i, [action, idStr]) {
    if (!(await hasAccess(i.member, "moderator"))) return respond(i, { embeds: [fail("Only moderators can review appeals.")], ephemeral: true });
    const db = getDb();
    const [a] = await db.select().from(appeals).where(and(eq(appeals.id, Number(idStr)), eq(appeals.guildId, i.guildId)));
    if (!a || a.status !== "pending") return respond(i, { embeds: [fail("This appeal was already reviewed.")], ephemeral: true });
    const accepted = action === "accept";
    await db.update(appeals).set({ status: accepted ? "accepted" : "denied", reviewerId: i.user.id, reviewedAt: new Date() }).where(eq(appeals.id, a.id));
    if (accepted) await executeModAction({ guild: i.guild, target: await i.client.users.fetch(a.userId), moderator: i.user, type: "unban", reason: `Appeal #${a.id} accepted` }).catch(() => undefined);
    const user = await i.client.users.fetch(a.userId).catch(() => null);
    await user?.send({ embeds: [brandEmbed(`Your appeal in ${i.guild.name} was ${accepted ? "accepted" : "denied"}`, accepted ? "You have been unbanned and may rejoin the server." : "Your ban remains in place.", accepted ? BRAND.success : BRAND.danger)] }).catch(() => undefined);
    if (i.isButton()) await i.update({ components: [], embeds: [brandEmbed(i.message.embeds[0]?.title ?? "Appeal", `${i.message.embeds[0]?.description ?? ""}\n\n**${accepted ? "✅ Accepted" : "❌ Denied"}** by <@${i.user.id}>`, accepted ? BRAND.success : BRAND.danger)] });
  },
};

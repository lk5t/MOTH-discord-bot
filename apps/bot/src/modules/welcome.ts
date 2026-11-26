import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, type Guild, type GuildMember, type PartialGuildMember } from "discord.js";
import { getGuildConfig, renderTemplate } from "@moth/core";
import { messagePayload, templateContext, ok, fail } from "../lib/embeds.js";
import { cid, type ComponentHandler } from "../commands/types.js";
import { respond } from "../lib/util.js";
import { log } from "../context.js";

async function sendTo(guild: Guild, channelId: string | null, payload: Parameters<typeof messagePayload>[0], member: GuildMember | PartialGuildMember) {
  if (!channelId) return;
  const ch = guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId).catch(() => null);
  if (!ch?.isTextBased() || !("send" in ch)) return;
  await ch.send(messagePayload(payload, templateContext({ member: member as GuildMember, user: member.user, guild, channel: { id: ch.id, name: ch.name } }))).catch((err) => log.debug({ err }, "welcome send failed"));
}

export async function onJoin(member: GuildMember): Promise<void> {
  const cfg = await getGuildConfig(member.guild.id);
  if (cfg.welcome.enabled) {
    await sendTo(member.guild, cfg.welcome.channelId, cfg.welcome.message, member);
    if (cfg.welcome.dm.enabled && !member.user.bot) await member.send(messagePayload(cfg.welcome.dm.message, templateContext({ member, guild: member.guild }))).catch(() => undefined);
  }
  if (cfg.verification.enabled && cfg.verification.unverifiedRoleId) await member.roles.add(cfg.verification.unverifiedRoleId, "Awaiting verification").catch(() => undefined);
  if (cfg.autorole.enabled) {
    const roles = (member.user.bot ? cfg.autorole.botRoleIds : cfg.autorole.roleIds).filter((r) => member.guild.roles.cache.get(r)?.editable);
    const apply = () => roles.length && member.roles.add(roles, "MOTH auto-role").catch(() => undefined);
    if (cfg.autorole.delaySeconds) setTimeout(apply, cfg.autorole.delaySeconds * 1000); else await apply();
  }
  const m = cfg.community.milestones;
  if (m.enabled && m.channelId && member.guild.memberCount % m.every === 0) {
    const ch = member.guild.channels.cache.get(m.channelId);
    if (ch?.isTextBased() && "send" in ch) await ch.send(renderTemplate(m.message, templateContext({ member, guild: member.guild }))).catch(() => undefined);
  }
}

export async function onLeave(member: GuildMember | PartialGuildMember): Promise<void> {
  const cfg = await getGuildConfig(member.guild.id);
  if (cfg.goodbye.enabled) await sendTo(member.guild, cfg.goodbye.channelId, cfg.goodbye.message, member);
}

/** Posts the verification panel in the configured channel. */
export async function publishVerification(guild: Guild): Promise<string> {
  const cfg = await getGuildConfig(guild.id);
  if (!cfg.verification.channelId) throw new Error("No verification channel configured");
  const ch = await guild.channels.fetch(cfg.verification.channelId).catch(() => null);
  if (!ch?.isTextBased() || !("send" in ch)) throw new Error("Verification channel not found");
  const payload = messagePayload(cfg.verification.message, templateContext({ guild }));
  const msg = await ch.send({ ...payload, components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(cid("verify", "start")).setLabel("Verify").setEmoji("✅").setStyle(ButtonStyle.Success))] });
  return msg.id;
}

const captchas = new Map<string, { answer: number; at: number }>();

async function grant(member: GuildMember): Promise<string | null> {
  const cfg = await getGuildConfig(member.guild.id);
  if (!cfg.verification.verifiedRoleId) return "Verification isn't fully configured (no verified role).";
  if (member.roles.cache.has(cfg.verification.verifiedRoleId)) return "You're already verified.";
  await member.roles.add(cfg.verification.verifiedRoleId, "Verified");
  if (cfg.verification.unverifiedRoleId) await member.roles.remove(cfg.verification.unverifiedRoleId, "Verified").catch(() => undefined);
  return null;
}

export const verifyComponents: ComponentHandler = {
  prefix: "verify",
  async handle(i, [action]) {
    const cfg = await getGuildConfig(i.guildId);
    if (!cfg.verification.enabled) return respond(i, { embeds: [fail("Verification is disabled.")], ephemeral: true });
    if (action === "start") {
      if (cfg.verification.mode === "captcha" && !i.isModalSubmit()) {
        const a = 2 + Math.floor(Math.random() * 9), b = 2 + Math.floor(Math.random() * 9);
        captchas.set(`${i.guildId}:${i.user.id}`, { answer: a + b, at: Date.now() });
        const modal = new ModalBuilder().setCustomId(cid("verify", "answer")).setTitle("Quick check")
          .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("a").setLabel(`What is ${a} + ${b}?`).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(3)));
        return (i as Parameters<ComponentHandler["handle"]>[0] & { showModal: Function }).showModal(modal);
      }
      const err = await grant(i.member).catch((e) => (e as Error).message);
      return respond(i, { embeds: [err ? fail(err) : ok("You're verified — welcome!")], ephemeral: true });
    }
    if (action === "answer" && i.isModalSubmit()) {
      const key = `${i.guildId}:${i.user.id}`;
      const c = captchas.get(key); captchas.delete(key);
      if (!c || Date.now() - c.at > 300_000 || Number(i.fields.getTextInputValue("a").trim()) !== c.answer) return respond(i, { embeds: [fail("That's not right — press Verify to try again.")], ephemeral: true });
      const err = await grant(i.member).catch((e) => (e as Error).message);
      return respond(i, { embeds: [err ? fail(err) : ok("You're verified — welcome!")], ephemeral: true });
    }
  },
};

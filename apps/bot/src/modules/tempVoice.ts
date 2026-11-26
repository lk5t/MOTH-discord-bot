import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, ModalBuilder, PermissionFlagsBits, TextInputBuilder, TextInputStyle,
  type Guild, type GuildMember, type VoiceChannel, type VoiceState,
} from "discord.js";
import { eq } from "drizzle-orm";
import { getDb, getGuildConfig, tempVoiceChannels } from "@moth/core";
import { cid, type ComponentHandler } from "../commands/types.js";
import { brandEmbed, fail, ok } from "../lib/embeds.js";
import { log, runtime } from "../context.js";

/** Join-to-create voice rooms with owner controls. */

const owners = new Map<string, string>(); // channelId → ownerId
const lastCreate = new Map<string, number>();

export async function loadTempVoice(): Promise<void> {
  const rows = await getDb().select().from(tempVoiceChannels);
  for (const r of rows) {
    const guild = runtime.client?.guilds.cache.get(r.guildId);
    const ch = guild?.channels.cache.get(r.channelId);
    if (!guild || !ch || ch.type !== ChannelType.GuildVoice || ch.members.size === 0) {
      await ch?.delete("Empty temporary voice channel").catch(() => undefined);
      await getDb().delete(tempVoiceChannels).where(eq(tempVoiceChannels.channelId, r.channelId));
    } else owners.set(r.channelId, r.ownerId);
  }
}

export const isTempVoice = (channelId: string) => owners.has(channelId);

function panel(ownerId: string) {
  const b = (id: string, label: string, emoji: string, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(cid("tvc", id)).setLabel(label).setEmoji(emoji).setStyle(style);
  return {
    embeds: [brandEmbed("🔊 Your voice room", `<@${ownerId}> owns this room. Use the buttons to control it — it's deleted automatically when everyone leaves.`)],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(b("lock", "Lock", "🔒"), b("unlock", "Unlock", "🔓"), b("hide", "Hide", "🙈"), b("show", "Show", "👁️")),
      new ActionRowBuilder<ButtonBuilder>().addComponents(b("rename", "Rename", "✏️"), b("limit", "Limit", "👥"), b("claim", "Claim", "👑", ButtonStyle.Primary)),
    ],
    allowedMentions: { parse: [] as never[] },
  };
}

async function create(member: GuildMember, hub: VoiceChannel) {
  const cfg = (await getGuildConfig(member.guild.id)).tempVoice;
  const key = `${member.guild.id}:${member.id}`;
  if ((lastCreate.get(key) ?? 0) > Date.now() - 10_000) return;
  lastCreate.set(key, Date.now());
  // Already owns a room? Move them back into it instead of creating another.
  for (const [chId, owner] of owners) {
    const existing = owner === member.id ? member.guild.channels.cache.get(chId) : undefined;
    if (existing?.type === ChannelType.GuildVoice) { await member.voice.setChannel(existing).catch(() => undefined); return; }
  }
  const name = cfg.nameTemplate.replace(/\{user(?:\.name)?\}/g, member.displayName).replace("{user.username}", member.user.username).slice(0, 100);
  const parent = cfg.categoryId ?? hub.parentId;
  const parentCh = parent ? member.guild.channels.cache.get(parent) : null;
  // Inherit the category's permissions so private/verified-only setups keep working.
  const inherited = parentCh && "permissionOverwrites" in parentCh
    ? parentCh.permissionOverwrites.cache.filter((o) => o.id !== member.id && o.id !== member.client.user.id).map((o) => ({ id: o.id, allow: o.allow, deny: o.deny, type: o.type }))
    : [];
  const ch = await member.guild.channels.create({
    name, type: ChannelType.GuildVoice, parent: parent ?? undefined, userLimit: cfg.defaultLimit || undefined, bitrate: hub.bitrate,
    permissionOverwrites: [
      ...inherited,
      { id: member.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak, PermissionFlagsBits.MoveMembers, PermissionFlagsBits.PrioritySpeaker] },
      { id: member.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MoveMembers, PermissionFlagsBits.SendMessages] },
    ],
    reason: `Temporary voice room for ${member.user.username}`,
  }).catch((err) => { log.warn({ err, guild: member.guild.id }, "temp voice create failed"); return null; });
  if (!ch) return;
  owners.set(ch.id, member.id);
  await getDb().insert(tempVoiceChannels).values({ channelId: ch.id, guildId: member.guild.id, ownerId: member.id });
  const moved = await member.voice.setChannel(ch).then(() => true).catch(() => false);
  if (!moved) { await cleanup(ch); return; }
  if (cfg.controlPanel) {
    const msg = await ch.send(panel(member.id)).catch(() => null);
    if (msg) await getDb().update(tempVoiceChannels).set({ panelMessageId: msg.id }).where(eq(tempVoiceChannels.channelId, ch.id));
  }
}

async function cleanup(ch: VoiceChannel) {
  owners.delete(ch.id);
  await getDb().delete(tempVoiceChannels).where(eq(tempVoiceChannels.channelId, ch.id)).catch(() => undefined);
  await ch.delete("Temporary voice room is empty").catch(() => undefined);
}

export async function onTempVoiceState(before: VoiceState, after: VoiceState): Promise<void> {
  if (before.channelId === after.channelId) return;
  const guild = after.guild;
  if (before.channel?.type === ChannelType.GuildVoice && owners.has(before.channel.id) && before.channel.members.filter((m) => !m.user.bot).size === 0) await cleanup(before.channel);
  if (!after.channel || after.channel.type !== ChannelType.GuildVoice || !after.member || after.member.user.bot) return;
  const cfg = (await getGuildConfig(guild.id)).tempVoice;
  if (cfg.enabled && cfg.hubChannelIds.includes(after.channel.id)) await create(after.member, after.channel);
}

export async function onTempVoiceDeleted(channelId: string) {
  if (!owners.delete(channelId)) return;
  await getDb().delete(tempVoiceChannels).where(eq(tempVoiceChannels.channelId, channelId)).catch(() => undefined);
}

/** Owner (or a member with Manage Channels) controls. */
export const tempVoiceComponents: ComponentHandler = {
  prefix: "tvc",
  async handle(i, [action]) {
    const ch = i.channel;
    if (!ch || ch.type !== ChannelType.GuildVoice || !owners.has(ch.id)) return i.reply({ embeds: [fail("This isn't an active voice room.")], ephemeral: true });
    const ownerId = owners.get(ch.id)!;
    const isOwner = i.user.id === ownerId || i.member.permissions.has(PermissionFlagsBits.ManageChannels);
    const everyone = (ch.guild as Guild).roles.everyone.id;

    if (action === "claim") {
      if (i.user.id === ownerId) return i.reply({ embeds: [fail("You already own this room.")], ephemeral: true });
      if (ch.members.has(ownerId) && !i.member.permissions.has(PermissionFlagsBits.ManageChannels)) return i.reply({ embeds: [fail("The owner is still here.")], ephemeral: true });
      if (!ch.members.has(i.user.id)) return i.reply({ embeds: [fail("Join the room first.")], ephemeral: true });
      owners.set(ch.id, i.user.id);
      await getDb().update(tempVoiceChannels).set({ ownerId: i.user.id }).where(eq(tempVoiceChannels.channelId, ch.id));
      await ch.permissionOverwrites.delete(ownerId).catch(() => undefined);
      await ch.permissionOverwrites.edit(i.user.id, { ViewChannel: true, Connect: true, Speak: true, MoveMembers: true, PrioritySpeaker: true });
      if (i.isButton()) await i.message.edit(panel(i.user.id)).catch(() => undefined);
      return i.reply({ embeds: [ok(`<@${i.user.id}> now owns this room.`)], allowedMentions: { parse: [] } });
    }
    if (!isOwner) return i.reply({ embeds: [fail("Only the room owner can do that.")], ephemeral: true });

    if (i.isModalSubmit()) {
      if (action === "rename") {
        const name = i.fields.getTextInputValue("name").trim().slice(0, 100);
        await ch.setName(name || ch.name);
        return i.reply({ embeds: [ok(`Renamed to **${name}**.`)], ephemeral: true });
      }
      if (action === "limit") {
        const n = Math.max(0, Math.min(99, Number.parseInt(i.fields.getTextInputValue("limit"), 10) || 0));
        await ch.setUserLimit(n);
        return i.reply({ embeds: [ok(n ? `Limit set to **${n}**.` : "Limit removed.")], ephemeral: true });
      }
      return;
    }
    switch (action) {
      case "lock": await ch.permissionOverwrites.edit(everyone, { Connect: false }); return i.reply({ embeds: [ok("Room locked — only people already here (or moved in) can join.")], ephemeral: true });
      case "unlock": await ch.permissionOverwrites.edit(everyone, { Connect: null }); return i.reply({ embeds: [ok("Room unlocked.")], ephemeral: true });
      case "hide": await ch.permissionOverwrites.edit(everyone, { ViewChannel: false }); return i.reply({ embeds: [ok("Room hidden from the channel list.")], ephemeral: true });
      case "show": await ch.permissionOverwrites.edit(everyone, { ViewChannel: null }); return i.reply({ embeds: [ok("Room visible again.")], ephemeral: true });
      case "rename": if (i.isButton()) return i.showModal(new ModalBuilder().setCustomId(cid("tvc", "rename")).setTitle("Rename room").addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("name").setLabel("New name").setStyle(TextInputStyle.Short).setMaxLength(100).setValue(ch.name)))); return;
      case "limit": if (i.isButton()) return i.showModal(new ModalBuilder().setCustomId(cid("tvc", "limit")).setTitle("User limit").addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("limit").setLabel("Max members (0 = no limit)").setStyle(TextInputStyle.Short).setMaxLength(2).setValue(String(ch.userLimit))))); return;
    }
  },
};

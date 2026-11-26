import { ChannelType, type Guild, type GuildBasedChannel } from "discord.js";
import type { GuildSnapshot, SnapshotChannelType } from "@moth/core";

const TYPE_MAP: Partial<Record<ChannelType, SnapshotChannelType>> = {
  [ChannelType.GuildText]: "text", [ChannelType.GuildVoice]: "voice", [ChannelType.GuildCategory]: "category",
  [ChannelType.GuildAnnouncement]: "announcement", [ChannelType.GuildForum]: "forum", [ChannelType.GuildStageVoice]: "stage",
};

export function channelKind(c: GuildBasedChannel): SnapshotChannelType {
  return TYPE_MAP[c.type] ?? "other";
}

/** Captures a serialisable snapshot of the guild's roles and channels. */
export async function captureSnapshot(guild: Guild, activity?: Map<string, number>): Promise<GuildSnapshot> {
  await Promise.all([guild.roles.fetch(), guild.channels.fetch()]);
  const me = guild.members.me ?? (await guild.members.fetchMe());
  return {
    id: guild.id, name: guild.name, iconUrl: guild.iconURL(), ownerId: guild.ownerId, memberCount: guild.memberCount,
    verificationLevel: guild.verificationLevel, botRoleId: me.roles.botRole?.id ?? null, botHighestPosition: me.roles.highest.position,
    roles: guild.roles.cache.map((r) => ({
      id: r.id, name: r.name, color: r.color, hoist: r.hoist, mentionable: r.mentionable, permissions: r.permissions.bitfield.toString(),
      position: r.position, managed: r.managed, everyone: r.id === guild.id,
    })),
    channels: guild.channels.cache.filter((c) => !c.isThread()).map((c) => {
      const gc = c as GuildBasedChannel & { topic?: string | null; nsfw?: boolean; rateLimitPerUser?: number; userLimit?: number; rawPosition?: number; permissionOverwrites?: { cache: Map<string, { id: string; type: number; allow: { bitfield: bigint }; deny: { bitfield: bigint } }> } };
      return {
        id: c.id, name: c.name, type: channelKind(c), parentId: c.parentId ?? null, position: gc.rawPosition ?? 0,
        topic: gc.topic ?? null, nsfw: gc.nsfw ?? false, rateLimitPerUser: gc.rateLimitPerUser ?? 0, userLimit: gc.userLimit ?? 0,
        overwrites: gc.permissionOverwrites ? [...gc.permissionOverwrites.cache.values()].map((o) => ({ id: o.id, type: o.type === 0 ? "role" as const : "member" as const, allow: o.allow.bitfield.toString(), deny: o.deny.bitfield.toString() })) : [],
        recentMessages: activity?.get(c.id),
      };
    }),
    capturedAt: new Date().toISOString(),
  };
}

export function protectedChannelIds(guild: Guild): string[] {
  return [guild.rulesChannelId, guild.publicUpdatesChannelId, guild.safetyAlertsChannelId, guild.systemChannelId && guild.features.includes("COMMUNITY") ? guild.systemChannelId : null].filter((x): x is string => !!x);
}

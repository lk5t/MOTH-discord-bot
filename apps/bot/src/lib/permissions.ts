import { PermissionFlagsBits, type GuildMember, type PermissionResolvable } from "discord.js";
import { getGuildConfig, ownerIds } from "@moth/core";
import { env } from "../env.js";

export type AccessLevel = "owner" | "admin" | "moderator" | "member";

/** Resolves a member's MOTH access level from Discord permissions + configured roles. */
export async function accessLevel(member: GuildMember): Promise<AccessLevel> {
  if (member.id === member.guild.ownerId || ownerIds(env).has(member.id)) return "owner";
  if (member.permissions.has(PermissionFlagsBits.Administrator) || member.permissions.has(PermissionFlagsBits.ManageGuild)) return "admin";
  const cfg = await getGuildConfig(member.guild.id);
  if (cfg.moderation.adminRoleIds.some((r) => member.roles.cache.has(r))) return "admin";
  if (cfg.moderation.moderatorRoleIds.some((r) => member.roles.cache.has(r))) return "moderator";
  if (member.permissions.any([PermissionFlagsBits.ModerateMembers, PermissionFlagsBits.KickMembers, PermissionFlagsBits.BanMembers])) return "moderator";
  return "member";
}

const RANK: Record<AccessLevel, number> = { member: 0, moderator: 1, admin: 2, owner: 3 };
export async function hasAccess(member: GuildMember, required: AccessLevel, perm?: PermissionResolvable): Promise<boolean> {
  if (perm && member.permissions.has(perm)) return true;
  return RANK[await accessLevel(member)] >= RANK[required];
}

/** Checks role hierarchy: can `actor` (and the bot) act on `target`? Returns an error string or null. */
export function hierarchyError(actor: GuildMember, target: GuildMember): string | null {
  const me = target.guild.members.me;
  if (target.id === actor.id) return "You can't moderate yourself.";
  if (target.id === target.guild.ownerId) return "The server owner can't be moderated.";
  if (me && target.roles.highest.position >= me.roles.highest.position) return "That member's highest role is above or equal to MOTH's — move the MOTH role higher.";
  if (actor.id !== actor.guild.ownerId && target.roles.highest.position >= actor.roles.highest.position) return "That member's highest role is above or equal to yours.";
  return null;
}

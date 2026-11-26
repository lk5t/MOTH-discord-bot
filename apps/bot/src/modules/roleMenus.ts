import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, type Guild, type MessageReaction, type PartialMessageReaction, type PartialUser, type User } from "discord.js";
import { and, eq } from "drizzle-orm";
import { getDb, roleMenus, type EmbedData } from "@moth/core";
import { toApiEmbed, ok, fail } from "../lib/embeds.js";
import { cid, type ComponentHandler } from "../commands/types.js";
import { respond } from "../lib/util.js";

type Menu = typeof roleMenus.$inferSelect;

export async function publishRoleMenu(guild: Guild, menuId: string): Promise<{ messageId: string }> {
  const db = getDb();
  const [menu] = await db.select().from(roleMenus).where(and(eq(roleMenus.id, menuId), eq(roleMenus.guildId, guild.id)));
  if (!menu?.channelId) throw new Error("Role menu or channel not found");
  const ch = await guild.channels.fetch(menu.channelId).catch(() => null);
  if (!ch?.isTextBased() || !("send" in ch)) throw new Error("Channel not found");
  const opts = menu.options.filter((o) => guild.roles.cache.has(o.roleId));
  const embed = toApiEmbed({ color: "#DC143C", ...(menu.embed as EmbedData) });
  if (menu.style === "reactions") embed.description = `${embed.description ?? ""}\n\n${opts.map((o) => `${o.emoji ?? "•"} — <@&${o.roleId}>${o.description ? ` · ${o.description}` : ""}`).join("\n")}`.trim();
  const components = menu.style === "buttons"
    ? chunk(opts, 5).slice(0, 5).map((row) => new ActionRowBuilder<ButtonBuilder>().addComponents(row.map((o) => { const b = new ButtonBuilder().setCustomId(cid("rm", menu.id, o.roleId)).setLabel(o.label.slice(0, 80)).setStyle(ButtonStyle.Secondary); if (o.emoji) b.setEmoji(o.emoji); return b; })))
    : menu.style === "select"
      ? [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId(cid("rm", menu.id, "select")).setPlaceholder("Choose your roles…").setMinValues(0)
          .setMaxValues(menu.mode === "unique" ? 1 : Math.min(menu.maxSelections ?? opts.length, opts.length))
          .addOptions(opts.slice(0, 25).map((o) => ({ label: o.label.slice(0, 100), value: o.roleId, description: o.description?.slice(0, 100), emoji: o.emoji || undefined }))))]
      : [];
  let msg = menu.messageId ? await ch.messages.fetch(menu.messageId).catch(() => null) : null;
  if (msg) await msg.edit({ embeds: [embed], components }); else msg = await ch.send({ embeds: [embed], components });
  if (menu.style === "reactions") for (const o of opts) if (o.emoji) await msg.react(o.emoji).catch(() => undefined);
  await db.update(roleMenus).set({ messageId: msg.id, updatedAt: new Date() }).where(eq(roleMenus.id, menu.id));
  return { messageId: msg.id };
}

function chunk<T>(a: T[], n: number): T[][] { const o: T[][] = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }

function allowed(menu: Menu, roles: Set<string>) { return !menu.requiredRoleIds.length || menu.requiredRoleIds.some((r) => roles.has(r)); }

export const roleMenuComponents: ComponentHandler = {
  prefix: "rm",
  async handle(i, [menuId, roleId]) {
    const [menu] = await getDb().select().from(roleMenus).where(eq(roleMenus.id, menuId));
    if (!menu) return respond(i, { embeds: [fail("This role menu no longer exists.")], ephemeral: true });
    const member = i.member;
    if (!allowed(menu, new Set(member.roles.cache.keys()))) return respond(i, { embeds: [fail("You don't meet the requirements for this menu.")], ephemeral: true });
    const menuRoles = menu.options.map((o) => o.roleId).filter((r) => i.guild.roles.cache.get(r)?.editable);
    try {
      if (roleId === "select" && i.isStringSelectMenu()) {
        const chosen = new Set(i.values);
        const add = menuRoles.filter((r) => chosen.has(r) && !member.roles.cache.has(r));
        const remove = menu.mode === "add-only" ? [] : menuRoles.filter((r) => !chosen.has(r) && member.roles.cache.has(r));
        if (add.length) await member.roles.add(add, "Role menu");
        if (remove.length) await member.roles.remove(remove, "Role menu");
        return respond(i, { embeds: [ok(`Updated your roles.${add.length ? ` Added: ${add.map((r) => `<@&${r}>`).join(", ")}.` : ""}${remove.length ? ` Removed: ${remove.map((r) => `<@&${r}>`).join(", ")}.` : ""}`)], ephemeral: true });
      }
      if (!menuRoles.includes(roleId)) return respond(i, { embeds: [fail("I can't manage that role — check MOTH's role position.")], ephemeral: true });
      const has = member.roles.cache.has(roleId);
      if (has && menu.mode !== "add-only") { await member.roles.remove(roleId, "Role menu"); return respond(i, { embeds: [ok(`Removed <@&${roleId}>.`)], ephemeral: true }); }
      if (!has && menu.mode !== "remove-only") {
        if (menu.mode === "unique") await member.roles.remove(menuRoles.filter((r) => r !== roleId && member.roles.cache.has(r)), "Role menu (unique)");
        await member.roles.add(roleId, "Role menu");
        return respond(i, { embeds: [ok(`Added <@&${roleId}>.`)], ephemeral: true });
      }
      return respond(i, { embeds: [ok("No changes.")], ephemeral: true });
    } catch (err) { return respond(i, { embeds: [fail(`Couldn't update roles: ${(err as Error).message}`)], ephemeral: true }); }
  },
};

export async function onReaction(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser, added: boolean): Promise<void> {
  if (user.bot || !reaction.message.guild) return;
  const [menu] = await getDb().select().from(roleMenus).where(and(eq(roleMenus.messageId, reaction.message.id), eq(roleMenus.style, "reactions")));
  if (!menu) return;
  const key = reaction.emoji.id ? `<${reaction.emoji.animated ? "a" : ""}:${reaction.emoji.name}:${reaction.emoji.id}>` : reaction.emoji.name;
  const opt = menu.options.find((o) => o.emoji === key || o.emoji === reaction.emoji.name || (reaction.emoji.id && o.emoji?.includes(reaction.emoji.id)));
  if (!opt) return;
  const member = await reaction.message.guild.members.fetch(user.id).catch(() => null);
  if (!member || !allowed(menu, new Set(member.roles.cache.keys()))) return;
  if (added && menu.mode !== "remove-only") {
    if (menu.mode === "unique") await member.roles.remove(menu.options.map((o) => o.roleId).filter((r) => r !== opt.roleId && member.roles.cache.has(r))).catch(() => undefined);
    await member.roles.add(opt.roleId, "Reaction role").catch(() => undefined);
  } else if (!added && menu.mode !== "add-only") await member.roles.remove(opt.roleId, "Reaction role").catch(() => undefined);
}

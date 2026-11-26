import { ApplicationCommandOptionType, type ChatInputCommandInteraction, type Guild, type GuildMember, type Message, type RESTPostAPIChatInputApplicationCommandsJSONBody, MessageFlags } from "discord.js";
import { and, eq, sql } from "drizzle-orm";
import { customCommands, customCommandSchema, getDb, matchesTrigger, type CustomCommandDefinition, type AutomationCondition } from "@moth/core";
import { messagePayload, templateContext } from "../lib/embeds.js";
import { runAutomation } from "./automation.js";
import { log } from "../context.js";
import { analytics } from "./analytics.js";

type Cmd = { id: string; name: string; enabled: boolean; def: CustomCommandDefinition };
const cache = new Map<string, Cmd[]>();
const cooldowns = new Map<string, number>();

export async function loadCustomCommands(guildId: string): Promise<Cmd[]> {
  const hit = cache.get(guildId); if (hit) return hit;
  const rows = await getDb().select().from(customCommands).where(eq(customCommands.guildId, guildId));
  const out: Cmd[] = [];
  for (const r of rows) { const p = customCommandSchema.safeParse(r.definition); if (p.success) out.push({ id: r.id, name: r.name, enabled: r.enabled, def: p.data }); }
  cache.set(guildId, out);
  return out;
}
export function invalidateCustomCommands(guildId: string) { cache.delete(guildId); }

const OPTION_TYPES = { string: ApplicationCommandOptionType.String, integer: ApplicationCommandOptionType.Integer, number: ApplicationCommandOptionType.Number, boolean: ApplicationCommandOptionType.Boolean, user: ApplicationCommandOptionType.User, channel: ApplicationCommandOptionType.Channel, role: ApplicationCommandOptionType.Role } as const;

export async function customSlashDefinitions(guildId: string, reserved: Set<string>): Promise<RESTPostAPIChatInputApplicationCommandsJSONBody[]> {
  const cmds = await loadCustomCommands(guildId);
  return cmds.filter((c) => c.enabled && c.def.type === "slash" && !reserved.has(c.name)).slice(0, 50).map((c) => ({
    name: c.name, description: c.def.description.slice(0, 100),
    options: c.def.options.map((o) => ({ name: o.name, description: o.description, type: OPTION_TYPES[o.type], required: o.required, ...(o.choices?.length && o.type === "string" ? { choices: o.choices.map((ch) => ({ name: ch, value: ch })) } : {}) })) as never,
  }));
}

function conditionsPass(conds: AutomationCondition[], member: GuildMember, channelId: string): boolean {
  return conds.every((c) => {
    switch (c.type) {
      case "has_role": return member.roles.cache.has(c.roleId);
      case "missing_role": return !member.roles.cache.has(c.roleId);
      case "in_channel": return c.channelIds.includes(channelId);
      case "chance": return Math.random() * 100 < c.percent;
      case "account_age_days": { const d = (Date.now() - member.user.createdTimestamp) / 86_400_000; return c.op === "gt" ? d > c.days : d < c.days; }
      case "is_bot": return member.user.bot === c.value;
      case "member_count": return c.op === "gt" ? member.guild.memberCount > c.value : member.guild.memberCount < c.value;
      default: return true;
    }
  });
}

function gate(cmd: Cmd, member: GuildMember, channelId: string): string | null {
  const d = cmd.def;
  if (d.deniedRoleIds.some((r) => member.roles.cache.has(r))) return "You're not allowed to use this command.";
  if (d.allowedRoleIds.length && !d.allowedRoleIds.some((r) => member.roles.cache.has(r))) return "You don't have the required role for this command.";
  if (d.allowedChannelIds.length && !d.allowedChannelIds.includes(channelId)) return "This command can't be used in this channel.";
  if (d.cooldownSeconds) {
    const key = `${cmd.id}:${member.id}`;
    const until = cooldowns.get(key) ?? 0;
    if (until > Date.now()) return `On cooldown — try again <t:${Math.ceil(until / 1000)}:R>.`;
    cooldowns.set(key, Date.now() + d.cooldownSeconds * 1000);
  }
  return null;
}

async function afterRun(cmd: Cmd, guild: Guild, member: GuildMember, message: Message<true> | null) {
  await getDb().update(customCommands).set({ uses: sql`${customCommands.uses} + 1` }).where(eq(customCommands.id, cmd.id)).catch(() => undefined);
  analytics.command(guild.id);
  if (cmd.def.actions.length) {
    await runAutomation({ id: cmd.id, guildId: guild.id, name: cmd.name, def: { trigger: { type: "member_join" }, steps: cmd.def.actions.map((action) => ({ kind: "action" as const, id: "a", action })), cooldownSeconds: 0 } }, guild, { member, message }, `command:${cmd.name}`)
      .catch((err) => log.warn({ err }, "custom command actions failed"));
  }
}

export async function runCustomSlash(i: ChatInputCommandInteraction<"cached">): Promise<boolean> {
  const cmd = (await loadCustomCommands(i.guildId)).find((c) => c.name === i.commandName && c.enabled);
  if (!cmd) return false;
  const denied = gate(cmd, i.member, i.channelId);
  if (denied) { await i.reply({ content: denied, flags: MessageFlags.Ephemeral }); return true; }
  const args: Record<string, string> = {};
  for (const o of cmd.def.options) {
    const opt = i.options.get(o.name);
    if (!opt) continue;
    args[o.name] = opt.user ? `<@${opt.user.id}>` : opt.channel ? `<#${opt.channel.id}>` : opt.role ? `<@&${opt.role.id}>` : String(opt.value);
  }
  const branch = cmd.def.branches.find((b) => conditionsPass(b.conditions, i.member, i.channelId));
  const payload = messagePayload(branch?.response ?? cmd.def.response, templateContext({ member: i.member, guild: i.guild, channel: i.channel ? { id: i.channel.id, name: i.channel.name } : null, args }));
  await i.reply({ ...payload, flags: cmd.def.ephemeral ? MessageFlags.Ephemeral : undefined });
  void afterRun(cmd, i.guild, i.member, null);
  return true;
}

export async function runTriggerCommands(message: Message<true>): Promise<void> {
  if (message.author.bot || !message.member) return;
  const cmds = (await loadCustomCommands(message.guildId)).filter((c) => c.enabled && c.def.type === "trigger");
  for (const cmd of cmds) {
    if (cmd.def.trigger.channelIds.length && !cmd.def.trigger.channelIds.includes(message.channelId)) continue;
    if (!matchesTrigger(cmd.def, message.content)) continue;
    if (gate(cmd, message.member, message.channelId)) continue;
    const branch = cmd.def.branches.find((b) => conditionsPass(b.conditions, message.member!, message.channelId));
    await message.channel.send(messagePayload(branch?.response ?? cmd.def.response, templateContext({ member: message.member, guild: message.guild, channel: { id: message.channelId, name: "name" in message.channel ? String(message.channel.name) : "" } }))).catch(() => undefined);
    if (cmd.def.deleteTrigger) await message.delete().catch(() => undefined);
    void afterRun(cmd, message.guild, message.member, message);
    break; // one trigger response per message
  }
}

export async function commandExists(guildId: string, name: string) {
  const [row] = await getDb().select().from(customCommands).where(and(eq(customCommands.guildId, guildId), eq(customCommands.name, name)));
  return !!row;
}

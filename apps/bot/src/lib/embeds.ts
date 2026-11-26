import { EmbedBuilder, type APIEmbed, type BaseMessageOptions, type Guild, type GuildMember, type User } from "discord.js";
import { hexToInt, renderMessage, type EmbedData, type MessageTemplate, type TemplateContext } from "@moth/core";

export const BRAND = { crimson: 0xdc143c, dark: 0x111111, success: 0x22c55e, warning: 0xf59e0b, danger: 0xdc143c, info: 0x3f3f46 };

export function brandEmbed(title?: string, description?: string, color = BRAND.crimson): EmbedBuilder {
  const e = new EmbedBuilder().setColor(color);
  if (title) e.setTitle(title.slice(0, 256));
  if (description) e.setDescription(description.slice(0, 4096));
  return e;
}

export const ok = (d: string) => brandEmbed(undefined, `✅ ${d}`, BRAND.success);
export const fail = (d: string) => brandEmbed(undefined, `❌ ${d}`, BRAND.danger);
export const info = (d: string) => brandEmbed(undefined, d, BRAND.info);

export function toApiEmbed(e: EmbedData): APIEmbed {
  const out: APIEmbed = {};
  if (e.title) out.title = e.title.slice(0, 256);
  if (e.description) out.description = e.description.slice(0, 4096);
  const c = hexToInt(e.color); if (c !== undefined) out.color = c;
  if (e.url) out.url = e.url;
  if (e.thumbnail && /^https?:\/\//.test(e.thumbnail)) out.thumbnail = { url: e.thumbnail };
  if (e.image && /^https?:\/\//.test(e.image)) out.image = { url: e.image };
  if (e.footer) out.footer = { text: e.footer.slice(0, 2048) };
  if (e.author) out.author = { name: e.author.slice(0, 256) };
  if (e.timestamp) out.timestamp = new Date().toISOString();
  if (e.fields?.length) out.fields = e.fields.slice(0, 25).map((f) => ({ name: f.name.slice(0, 256) || "​", value: f.value.slice(0, 1024) || "​", inline: f.inline }));
  return out;
}

export function templateContext(opts: { member?: GuildMember | null; user?: User | null; guild?: Guild | null; channel?: { id: string; name: string } | null; target?: GuildMember | User | null; args?: TemplateContext["args"]; vars?: TemplateContext["vars"] }): TemplateContext {
  const u = opts.member?.user ?? opts.user ?? null;
  const tUser = opts.target ? ("user" in opts.target ? opts.target.user : opts.target) : null;
  return {
    user: u ? { id: u.id, username: u.username, displayName: opts.member?.displayName ?? u.globalName ?? u.username, avatarUrl: u.displayAvatarURL({ size: 256 }), createdAt: u.createdAt, joinedAt: opts.member?.joinedAt ?? null } : undefined,
    target: tUser ? { id: tUser.id, username: tUser.username, displayName: tUser.globalName ?? tUser.username, avatarUrl: tUser.displayAvatarURL({ size: 256 }), createdAt: tUser.createdAt } : undefined,
    server: opts.guild ? { id: opts.guild.id, name: opts.guild.name, memberCount: opts.guild.memberCount, iconUrl: opts.guild.iconURL() } : undefined,
    channel: opts.channel ? { id: opts.channel.id, name: opts.channel.name } : undefined,
    args: opts.args, vars: opts.vars,
  };
}

/** Renders a MessageTemplate into Discord message options. Mentions are restricted to users by default. */
export function messagePayload(tpl: MessageTemplate, ctx: TemplateContext, allowRoleMentions = false): BaseMessageOptions {
  const r = renderMessage(tpl, ctx);
  const payload: BaseMessageOptions = { allowedMentions: { parse: allowRoleMentions ? ["users", "roles"] : ["users"] } };
  if (r.content) payload.content = r.content.slice(0, 2000);
  if (r.embed && (r.embed.title || r.embed.description || r.embed.fields?.length || r.embed.image)) payload.embeds = [toApiEmbed(r.embed)];
  if (!payload.content && !payload.embeds) payload.content = "​";
  return payload;
}

import type { EmbedData, MessageTemplate } from "./guild-config.js";

/**
 * Placeholder rendering shared by welcome messages, custom commands,
 * automations and the dashboard preview/test tool.
 *
 * Supported: {user} {user.mention} {user.name} {user.tag} {user.id} {user.avatar}
 * {user.created} {user.joined} {server} {server.id} {server.members} {server.icon}
 * {channel} {channel.mention} {channel.id} {args.<name>} {level} {xp} {balance}
 * {date} {time} {random:a|b|c} {randnum:1-100} {target...} and any custom ctx key.
 */
export interface TemplateContext {
  user?: { id: string; username: string; displayName?: string; avatarUrl?: string; createdAt?: Date; joinedAt?: Date | null };
  target?: TemplateContext["user"];
  server?: { id: string; name: string; memberCount: number; iconUrl?: string | null };
  channel?: { id: string; name: string };
  args?: Record<string, string | number | boolean | undefined>;
  vars?: Record<string, string | number | undefined>;
  now?: Date;
}

function userVars(prefix: string, u: TemplateContext["user"]): Record<string, string> {
  if (!u) return {};
  return {
    [prefix]: `<@${u.id}>`,
    [`${prefix}.mention`]: `<@${u.id}>`,
    [`${prefix}.name`]: u.displayName ?? u.username,
    [`${prefix}.username`]: u.username,
    [`${prefix}.tag`]: u.username,
    [`${prefix}.id`]: u.id,
    [`${prefix}.avatar`]: u.avatarUrl ?? "",
    [`${prefix}.created`]: u.createdAt ? `<t:${Math.floor(u.createdAt.getTime() / 1000)}:R>` : "",
    [`${prefix}.joined`]: u.joinedAt ? `<t:${Math.floor(u.joinedAt.getTime() / 1000)}:R>` : "",
  };
}

export function buildVariables(ctx: TemplateContext): Record<string, string> {
  const now = ctx.now ?? new Date();
  const vars: Record<string, string> = {
    ...userVars("user", ctx.user),
    ...userVars("target", ctx.target),
    date: now.toISOString().slice(0, 10),
    time: now.toISOString().slice(11, 16) + " UTC",
    timestamp: `<t:${Math.floor(now.getTime() / 1000)}:f>`,
  };
  if (ctx.server) {
    Object.assign(vars, {
      server: ctx.server.name, "server.name": ctx.server.name, "server.id": ctx.server.id,
      "server.members": String(ctx.server.memberCount), "server.icon": ctx.server.iconUrl ?? "",
    });
  }
  if (ctx.channel) Object.assign(vars, { channel: `<#${ctx.channel.id}>`, "channel.mention": `<#${ctx.channel.id}>`, "channel.name": ctx.channel.name, "channel.id": ctx.channel.id });
  for (const [k, v] of Object.entries(ctx.args ?? {})) if (v !== undefined) vars[`args.${k}`] = String(v);
  for (const [k, v] of Object.entries(ctx.vars ?? {})) if (v !== undefined) vars[k] = String(v);
  return vars;
}

export function renderTemplate(input: string | undefined, ctx: TemplateContext, vars = buildVariables(ctx)): string {
  if (!input) return "";
  return input.replace(/\{([a-zA-Z0-9_.:\-|, ]+)\}/g, (match, key: string) => {
    if (key.startsWith("random:")) {
      const opts = key.slice(7).split("|");
      return opts[Math.floor(Math.random() * opts.length)] ?? "";
    }
    if (key.startsWith("randnum:")) {
      const [a, b] = key.slice(8).split("-").map(Number);
      if (Number.isFinite(a) && Number.isFinite(b)) return String(Math.floor(Math.random() * (b - a + 1)) + a);
      return match;
    }
    return key in vars ? vars[key] : match;
  });
}

export function renderEmbed(embed: EmbedData | undefined, ctx: TemplateContext, vars = buildVariables(ctx)): EmbedData | undefined {
  if (!embed) return undefined;
  const r = (s?: string) => (s === undefined ? undefined : renderTemplate(s, ctx, vars));
  return {
    ...embed,
    title: r(embed.title), description: r(embed.description), footer: r(embed.footer), author: r(embed.author),
    thumbnail: r(embed.thumbnail), image: r(embed.image),
    fields: embed.fields?.map((f) => ({ ...f, name: r(f.name) ?? "", value: r(f.value) ?? "" })),
  };
}

export function renderMessage(tpl: MessageTemplate, ctx: TemplateContext): MessageTemplate {
  const vars = buildVariables(ctx);
  return { content: tpl.content ? renderTemplate(tpl.content, ctx, vars) : undefined, embed: renderEmbed(tpl.embed, ctx, vars) };
}

export const PLACEHOLDER_HELP: { key: string; description: string }[] = [
  { key: "{user}", description: "Mentions the user" },
  { key: "{user.name}", description: "Display name" },
  { key: "{user.id}", description: "User ID" },
  { key: "{user.avatar}", description: "Avatar URL" },
  { key: "{user.created}", description: "Account age (relative)" },
  { key: "{server}", description: "Server name" },
  { key: "{server.members}", description: "Member count" },
  { key: "{channel}", description: "Mentions the current channel" },
  { key: "{args.name}", description: "Slash command option value" },
  { key: "{level} / {xp}", description: "Leveling stats (when available)" },
  { key: "{balance}", description: "Economy balance (when available)" },
  { key: "{random:a|b|c}", description: "Random choice" },
  { key: "{randnum:1-100}", description: "Random number" },
  { key: "{date} / {time} / {timestamp}", description: "Current date/time" },
];

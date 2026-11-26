import type { AutomationDefinition, AutomationStep } from "./schema.js";

/**
 * Ready-made automations. Each recipe asks for a few inputs (channels, roles,
 * text) and produces one or more complete workflows that can be edited in the
 * builder afterwards. Pure + browser-safe: used by the dashboard and the bot.
 */

export type RecipeParamKind = "channel" | "voice" | "role" | "text" | "longtext" | "number";
export interface RecipeParam { key: string; label: string; kind: RecipeParamKind; default?: string | number; hint?: string; optional?: boolean }
export interface RecipeOutput { name: string; description: string; definition: AutomationDefinition }
export interface Recipe {
  key: string;
  name: string;
  description: string;
  category: "Members" | "Moderation" | "Engagement" | "Voice" | "Support" | "Schedules";
  icon: string;
  params: RecipeParam[];
  build(p: Record<string, string>): RecipeOutput[];
}

let n = 0;
const id = () => `r${(++n).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const act = (action: Extract<AutomationStep, { kind: "action" }>["action"]): AutomationStep => ({ kind: "action", id: id(), action });
const cond = (condition: Extract<AutomationStep, { kind: "condition" }>["condition"], negate = false): AutomationStep => ({ kind: "condition", id: id(), condition, negate });
const wait = (seconds: number): AutomationStep => ({ kind: "delay", id: id(), seconds });
const num = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) && v !== "" && v !== undefined ? Number(v) : d);
const role = (r?: string) => (r ? `<@&${r}>` : "");
const def = (trigger: AutomationDefinition["trigger"], steps: AutomationStep[], cooldownSeconds = 0): AutomationDefinition => ({ trigger, steps, cooldownSeconds });

/** "18:30" | "18" → [minute, hour] */
function hm(v: string | undefined, fallback: string): [number, number] {
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec((v ?? "").trim()) ?? /^(\d{1,2})(?::(\d{2}))?$/.exec(fallback)!;
  return [Math.min(59, Number(m[2] ?? 0)), Math.min(23, Number(m[1]))];
}
const DAYS: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
function dayList(v: string | undefined): string {
  const days = (v ?? "").toLowerCase().split(/[\s,]+/).map((d) => DAYS[d.slice(0, 3)]).filter((d) => d !== undefined);
  return days.length ? [...new Set(days)].sort().join(",") : "*";
}

export const RECIPES: Recipe[] = [
  {
    key: "delayed-member-role", name: "Member role after a delay", category: "Members", icon: "⏳",
    description: "Give new members a role after they have been in the server for a while. Stops drive-by spammers.",
    params: [{ key: "role", label: "Role to give", kind: "role" }, { key: "minutes", label: "Wait (minutes)", kind: "number", default: 10 }],
    build: (p) => [{ name: "Member role after delay", description: `Gives the role after ${num(p.minutes, 10)} minutes`, definition: def({ type: "member_join" }, [cond({ type: "is_bot", value: false }), wait(num(p.minutes, 10) * 60), act({ type: "add_role", roleId: p.role })]) }],
  },
  {
    key: "quarantine-new-accounts", name: "Quarantine brand-new accounts", category: "Moderation", icon: "🛡️",
    description: "Accounts younger than N days get a restricted role and staff are told about it.",
    params: [{ key: "role", label: "Quarantine role", kind: "role" }, { key: "days", label: "Minimum account age (days)", kind: "number", default: 7 }, { key: "channel", label: "Staff alert channel", kind: "channel" }],
    build: (p) => [{ name: "Quarantine new accounts", description: `Accounts younger than ${num(p.days, 7)} days are quarantined`, definition: def({ type: "member_join" }, [
      cond({ type: "account_age_days", op: "lt", days: num(p.days, 7) }), act({ type: "add_role", roleId: p.role }),
      act({ type: "send_message", channelId: p.channel, message: { embed: { title: "🛡️ New account quarantined", description: "{user.mention} (`{user.id}`) — account created {user.created}.", color: "#F59E0B" } } }),
    ]) }],
  },
  {
    key: "welcome-dm", name: "Welcome DM with the essentials", category: "Members", icon: "👋",
    description: "Sends every new member a private message with the rules and where to start.",
    params: [{ key: "text", label: "Message", kind: "longtext", default: "Welcome to **{server}**, {user.name}! 👋\nRead the rules first, then come say hi." }],
    build: (p) => [{ name: "Welcome DM", description: "DMs new members", definition: def({ type: "member_join" }, [cond({ type: "is_bot", value: false }), act({ type: "send_dm", message: { embed: { title: "Welcome to {server}", description: p.text, color: "#DC143C" } } })]) }],
  },
  {
    key: "booster-thanks", name: "Thank server boosters", category: "Engagement", icon: "💎",
    description: "Publicly thanks members who boost, and optionally gives them an extra role.",
    params: [{ key: "channel", label: "Announcement channel", kind: "channel" }, { key: "role", label: "Extra role (optional)", kind: "role", optional: true }],
    build: (p) => [{ name: "Booster thank-you", description: "Thanks new boosters", definition: def({ type: "boost" }, [
      act({ type: "send_message", channelId: p.channel, message: { embed: { title: "💎 New boost!", description: "Huge thanks {user.mention} for boosting **{server}**!", color: "#F47FFF" } } }),
      ...(p.role ? [act({ type: "add_role", roleId: p.role })] : []),
    ]) }],
  },
  {
    key: "bump-reminder", name: "Bump reminder", category: "Schedules", icon: "🔔",
    description: "When a server-list bot confirms a bump, remind your bumpers two hours later.",
    params: [{ key: "channel", label: "Bump channel", kind: "channel" }, { key: "role", label: "Role to ping", kind: "role", optional: true }, { key: "phrase", label: "Bump confirmation text", kind: "text", default: "Bump done" }],
    build: (p) => [{ name: "Bump reminder", description: "Pings 2 hours after each bump", definition: def({ type: "message", match: "contains", pattern: p.phrase || "Bump done", channelIds: p.channel ? [p.channel] : [], ignoreBots: false }, [
      cond({ type: "is_bot", value: true }), act({ type: "react", emoji: "✅" }), wait(7200),
      act({ type: "send_message", channelId: p.channel, message: { content: `${role(p.role)} ⏰ The server can be bumped again — use \`/bump\`!`.trim() } }),
    ], 3600) }],
  },
  {
    key: "faq-reply", name: "Keyword auto-reply (FAQ)", category: "Support", icon: "💬",
    description: "Answer a common question automatically whenever someone mentions a keyword.",
    params: [{ key: "keyword", label: "Keyword or phrase", kind: "text", default: "how do i join" }, { key: "answer", label: "Answer", kind: "longtext", default: "Check the pinned message in #info for the full guide!" }],
    build: (p) => [{ name: `FAQ: ${p.keyword}`.slice(0, 100), description: "Replies to a common question", definition: def({ type: "message", match: "contains", pattern: p.keyword, channelIds: [], ignoreBots: true }, [act({ type: "reply", message: { content: p.answer } })], 120) }],
  },
  {
    key: "voice-role", name: "In-voice role", category: "Voice", icon: "🎙️",
    description: "Give members a role while they are in voice (great for a private voice-chat text channel).",
    params: [{ key: "role", label: "Role", kind: "role" }],
    build: (p) => [
      { name: "In-voice role (join)", description: "Adds the role on voice join", definition: def({ type: "voice_join", channelIds: [] }, [act({ type: "add_role", roleId: p.role })]) },
      { name: "In-voice role (leave)", description: "Removes the role on voice leave", definition: def({ type: "voice_leave", channelIds: [] }, [act({ type: "remove_role", roleId: p.role })]) },
    ],
  },
  {
    key: "forum-welcome", name: "Reply to new help threads", category: "Support", icon: "🧵",
    description: "Posts a helpful first reply whenever someone opens a thread in your help forum or channel.",
    params: [{ key: "channel", label: "Help forum / channel", kind: "channel" }, { key: "role", label: "Helper role to ping (optional)", kind: "role", optional: true }],
    build: (p) => [{ name: "Help thread reply", description: "Greets new help threads", definition: def({ type: "thread_create", channelIds: p.channel ? [p.channel] : [] }, [
      act({ type: "send_message", message: { content: `${role(p.role)} Thanks for posting, {user.mention}! Describe what you tried and include screenshots — someone will be with you soon.`.trim() } }),
    ]) }],
  },
  {
    key: "ticket-alert", name: "Alert staff on new tickets", category: "Support", icon: "🎫",
    description: "Posts in a staff channel every time a ticket is opened.",
    params: [{ key: "channel", label: "Staff channel", kind: "channel" }, { key: "role", label: "Staff role to ping (optional)", kind: "role", optional: true }],
    build: (p) => [{ name: "New ticket alert", description: "Pings staff on new tickets", definition: def({ type: "ticket_opened" }, [act({ type: "send_message", channelId: p.channel, message: { content: `${role(p.role)} 🎫 New ticket from {user.mention} → {channel}`.trim() } })]) }],
  },
  {
    key: "keyword-alert", name: "Alert staff on keywords", category: "Moderation", icon: "🚨",
    description: "Silently notifies moderators when a watched word or phrase is used (without deleting anything).",
    params: [{ key: "pattern", label: "Words (separated by |)", kind: "text", default: "scam|free nitro|hack" }, { key: "channel", label: "Staff channel", kind: "channel" }],
    build: (p) => [{ name: "Keyword alert", description: "Notifies staff about watched words", definition: def({ type: "message", match: "regex", pattern: `\\b(${p.pattern})\\b`, channelIds: [], ignoreBots: true }, [
      act({ type: "send_message", channelId: p.channel, message: { embed: { title: "🚨 Watched keyword", description: "{user.mention} in {channel}:\n>>> {message}", color: "#DC143C" } } }),
    ], 30) }],
  },
  {
    key: "night-slowmode", name: "Night-time slowmode", category: "Moderation", icon: "🌙",
    description: "Turns on slowmode overnight when fewer moderators are around, and turns it off in the morning.",
    params: [{ key: "channel", label: "Channel", kind: "channel" }, { key: "start", label: "Start (HH:MM)", kind: "text", default: "00:00" }, { key: "end", label: "End (HH:MM)", kind: "text", default: "08:00" }, { key: "seconds", label: "Slowmode seconds", kind: "number", default: 15 }, { key: "tz", label: "Timezone", kind: "text", default: "UTC" }],
    build: (p) => {
      const [sm, sh] = hm(p.start, "00:00"); const [em, eh] = hm(p.end, "08:00"); const tz = p.tz || "UTC";
      return [
        { name: "Night slowmode on", description: "Enables slowmode at night", definition: def({ type: "schedule", cron: `${sm} ${sh} * * *`, timezone: tz }, [act({ type: "slowmode", channelId: p.channel, seconds: num(p.seconds, 15) })]) },
        { name: "Night slowmode off", description: "Disables slowmode in the morning", definition: def({ type: "schedule", cron: `${em} ${eh} * * *`, timezone: tz }, [act({ type: "slowmode", channelId: p.channel, seconds: 0 })]) },
      ];
    },
  },
  {
    key: "scheduled-lock", name: "Open & close a channel on a schedule", category: "Schedules", icon: "🔒",
    description: "Locks a channel (e.g. a daily event or submissions channel) outside opening hours.",
    params: [{ key: "channel", label: "Channel", kind: "channel" }, { key: "open", label: "Opens at (HH:MM)", kind: "text", default: "09:00" }, { key: "close", label: "Closes at (HH:MM)", kind: "text", default: "21:00" }, { key: "tz", label: "Timezone", kind: "text", default: "UTC" }],
    build: (p) => {
      const [om, oh] = hm(p.open, "09:00"); const [cm, ch] = hm(p.close, "21:00"); const tz = p.tz || "UTC";
      return [
        { name: "Channel opens", description: "Unlocks on schedule", definition: def({ type: "schedule", cron: `${om} ${oh} * * *`, timezone: tz }, [act({ type: "unlock_channel", channelId: p.channel }), act({ type: "send_message", channelId: p.channel, message: { content: "🔓 This channel is now **open**." } })]) },
        { name: "Channel closes", description: "Locks on schedule", definition: def({ type: "schedule", cron: `${cm} ${ch} * * *`, timezone: tz }, [act({ type: "send_message", channelId: p.channel, message: { content: "🔒 This channel is now **closed** — see you tomorrow." } }), act({ type: "lock_channel", channelId: p.channel })]) },
      ];
    },
  },
  {
    key: "weekly-event", name: "Recurring event announcement", category: "Schedules", icon: "📅",
    description: "Announces a recurring event (game night, meeting, stream) and pings a role.",
    params: [{ key: "channel", label: "Channel", kind: "channel" }, { key: "role", label: "Role to ping (optional)", kind: "role", optional: true }, { key: "days", label: "Days", kind: "text", default: "fri", hint: "e.g. fri or mon,wed" }, { key: "time", label: "Time (HH:MM)", kind: "text", default: "18:00" }, { key: "tz", label: "Timezone", kind: "text", default: "UTC" }, { key: "text", label: "Announcement", kind: "longtext", default: "🎮 **Game night starts now!** Hop into voice." }],
    build: (p) => {
      const [m, h] = hm(p.time, "18:00");
      return [{ name: "Event announcement", description: "Recurring announcement", definition: def({ type: "schedule", cron: `${m} ${h} * * ${dayList(p.days)}`, timezone: p.tz || "UTC" }, [act({ type: "send_message", channelId: p.channel, message: { content: `${role(p.role)} ${p.text}`.trim() } })]) }];
    },
  },
  {
    key: "partner-invite-role", name: "Role for a specific invite", category: "Members", icon: "🔗",
    description: "Members who join through a particular invite link (e.g. a partner or event link) get a role.",
    params: [{ key: "code", label: "Invite code", kind: "text", hint: "the part after discord.gg/" }, { key: "role", label: "Role", kind: "role" }],
    build: (p) => [{ name: `Invite role: ${p.code}`.slice(0, 100), description: "Role for members from an invite", definition: def({ type: "member_join" }, [cond({ type: "invite_code", codes: [p.code.replace(/^.*\//, "")] }), act({ type: "add_role", roleId: p.role })]) }],
  },
  {
    key: "suggestion-announce", name: "Share new suggestions with staff", category: "Engagement", icon: "💡",
    description: "Lets staff know about each new suggestion in a private channel.",
    params: [{ key: "channel", label: "Staff channel", kind: "channel" }],
    build: (p) => [{ name: "New suggestion alert", description: "Notifies staff", definition: def({ type: "suggestion_created" }, [act({ type: "send_message", channelId: p.channel, message: { content: "💡 New suggestion from {user.mention}: {message}" } })]) }],
  },
];

export const RECIPE_CATEGORIES = [...new Set(RECIPES.map((r) => r.category))];

/** Builds a recipe, checking required params. Throws with a readable message. */
export function buildRecipe(key: string, params: Record<string, string>): RecipeOutput[] {
  const r = RECIPES.find((x) => x.key === key);
  if (!r) throw new Error("Unknown recipe");
  for (const p of r.params) {
    const v = params[p.key] ?? (p.default !== undefined ? String(p.default) : "");
    if (!p.optional && !String(v).trim()) throw new Error(`${p.label} is required`);
    params[p.key] = String(v).trim();
  }
  return r.build(params);
}

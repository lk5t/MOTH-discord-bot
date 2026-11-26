import type { GuildConfig } from "../guild-config.js";

/**
 * One-click setup packs. A pack declares the channels and roles it needs and
 * the configuration it applies once they exist. The bot reuses channels/roles
 * that are already configured or already exist by name, so applying a pack
 * twice is safe. Pure + browser-safe (the dashboard renders previews).
 */

export type PackChannel = {
  key: string; name: string; type: "text" | "voice" | "category";
  parent?: string;
  /** Only staff (and MOTH) can see it. */
  staffOnly?: boolean;
  /** Everyone can read but not send. */
  readOnly?: boolean;
  /** Voice channel nobody can join (stats display). */
  noConnect?: boolean;
  topic?: string;
};
export type PackRole = { key: string; name: string; color?: string; staff?: boolean };
export type PackIds = Record<string, string>;

export type PackExtra = "publish-verification" | "ticket-panel";

export interface SetupPack {
  key: string;
  name: string;
  icon: string;
  description: string;
  features: string[];
  channels: PackChannel[];
  roles: PackRole[];
  /** Existing ids MOTH should reuse for a key, read from the current config. */
  existing(cfg: GuildConfig): PackIds;
  config(ids: PackIds, cfg: GuildConfig): Partial<Record<keyof GuildConfig, unknown>>;
  extras?: PackExtra[];
  note?: string;
}

const firstStats = (cfg: GuildConfig, needle: string) => cfg.statsChannels.find((s) => s.template.includes(needle))?.channelId;
const clean = (o: Record<string, string | null | undefined>): PackIds => Object.fromEntries(Object.entries(o).filter(([, v]) => !!v)) as PackIds;

export const SETUP_PACKS: SetupPack[] = [
  {
    key: "essentials", name: "Logs & protection", icon: "🛡️",
    description: "Staff log channels, full server logging, auto-moderation and anti-raid with sensible defaults.",
    features: ["Moderation, security, server and message logs", "Message edit/delete, member, role, channel and invite logs", "Spam, mention, invite and duplicate filters", "Anti-raid + anti-nuke on medium sensitivity"],
    channels: [
      { key: "cat", name: "Staff Logs", type: "category", staffOnly: true },
      { key: "mod", name: "mod-log", type: "text", parent: "cat", staffOnly: true, topic: "Moderation actions" },
      { key: "server", name: "server-log", type: "text", parent: "cat", staffOnly: true, topic: "Members, roles, channels and invites" },
      { key: "messages", name: "message-log", type: "text", parent: "cat", staffOnly: true, topic: "Edited and deleted messages" },
      { key: "security", name: "security-log", type: "text", parent: "cat", staffOnly: true, topic: "Raids, suspicious accounts and anti-nuke" },
    ],
    roles: [],
    existing: (c) => clean({ mod: c.general.modLogChannelId, server: c.logging.memberChannelId ?? c.general.logChannelId, messages: c.logging.messageChannelId, security: c.general.securityLogChannelId }),
    config: (ids, c) => ({
      general: { logChannelId: ids.server, modLogChannelId: ids.mod, securityLogChannelId: ids.security },
      logging: { enabled: true, messageChannelId: ids.messages, memberChannelId: ids.server, serverChannelId: ids.server, voiceChannelId: c.logging.voiceChannelId ?? ids.server },
      automod: { enabled: true },
      security: { enabled: true, antiNuke: { ...c.security.antiNuke, enabled: true } },
      moderation: { enabled: true },
    }),
  },
  {
    key: "welcome", name: "Welcome & member roles", icon: "👋",
    description: "Welcome and goodbye messages, an automatic Member role and member-count milestones.",
    features: ["Welcome card for every new member", "Goodbye message", "Automatic “Member” role", "Milestone announcement every 100 members"],
    channels: [{ key: "welcome", name: "welcome", type: "text", readOnly: true, topic: "Say hi to our newest members!" }],
    roles: [{ key: "member", name: "Member", color: "#9CA3AF" }],
    existing: (c) => clean({ welcome: c.welcome.channelId, member: c.autorole.roleIds[0] }),
    config: (ids, c) => ({
      welcome: { enabled: true, channelId: ids.welcome },
      goodbye: { enabled: true, channelId: c.goodbye.channelId ?? ids.welcome },
      autorole: { enabled: true, roleIds: [...new Set([...c.autorole.roleIds, ids.member])] },
      community: { milestones: { ...c.community.milestones, enabled: true, channelId: c.community.milestones.channelId ?? ids.welcome } },
    }),
  },
  {
    key: "verification", name: "Verification gate", icon: "✅",
    description: "A verify button new members press to get access. Blocks most bots and raid accounts.",
    features: ["#verify channel with a button panel", "“Verified” role granted on click", "Raises verification automatically during raids"],
    channels: [{ key: "verify", name: "verify", type: "text", readOnly: true, topic: "Press the button to get access" }],
    roles: [{ key: "verified", name: "Verified", color: "#22C55E" }],
    existing: (c) => clean({ verify: c.verification.channelId, verified: c.verification.verifiedRoleId }),
    config: (ids) => ({ verification: { enabled: true, mode: "button", channelId: ids.verify, verifiedRoleId: ids.verified } }),
    extras: ["publish-verification"],
    note: "For the gate to work, your other channels must be hidden from @everyone and visible to Verified. The Architect can do this for you: “make every channel except #verify visible only to Verified”.",
  },
  {
    key: "support", name: "Support tickets", icon: "🎫",
    description: "A ticket panel with categories, a staff role, private ticket channels and transcripts.",
    features: ["#open-a-ticket panel with Support, Report and Appeal buttons", "“Support Team” role sees every ticket", "Transcripts saved to #ticket-transcripts", "Auto-close after 48h of inactivity"],
    channels: [
      { key: "cat", name: "Support", type: "category" },
      { key: "panel", name: "open-a-ticket", type: "text", parent: "cat", readOnly: true, topic: "Need help? Open a ticket below." },
      { key: "transcripts", name: "ticket-transcripts", type: "text", parent: "cat", staffOnly: true },
    ],
    roles: [{ key: "staff", name: "Support Team", color: "#3B82F6", staff: true }],
    existing: (c) => clean({ transcripts: c.tickets.transcriptChannelId }),
    config: (ids, c) => ({ tickets: { enabled: true, transcriptChannelId: ids.transcripts, autoCloseHours: c.tickets.autoCloseHours || 48 } }),
    extras: ["ticket-panel"],
  },
  {
    key: "community", name: "Suggestions & starboard", icon: "💡",
    description: "A suggestions channel with voting and staff review, a starboard for great messages, and leveling.",
    features: ["#suggestions — every message becomes a vote with a discussion thread", "Staff approve / deny with a reason; authors are notified", "#starboard for messages with 3+ ⭐", "XP and levels"],
    channels: [
      { key: "suggestions", name: "suggestions", type: "text", topic: "Post an idea — members vote, staff review." },
      { key: "starboard", name: "starboard", type: "text", readOnly: true, topic: "The best messages, as voted with ⭐" },
    ],
    roles: [],
    existing: (c) => clean({ suggestions: c.suggestions.channelId, starboard: c.starboard.channelId }),
    config: (ids) => ({ suggestions: { enabled: true, channelId: ids.suggestions }, starboard: { enabled: true, channelId: ids.starboard }, leveling: { enabled: true } }),
  },
  {
    key: "voice", name: "Join-to-create voice", icon: "🔊",
    description: "Members join one channel to get their own voice room that disappears when empty.",
    features: ["“➕ Create a room” hub", "Owner controls: lock, hide, rename, limit, transfer", "Empty rooms are deleted automatically"],
    channels: [
      { key: "cat", name: "Voice Rooms", type: "category" },
      { key: "hub", name: "➕ Create a room", type: "voice", parent: "cat" },
    ],
    roles: [],
    existing: (c) => clean({ hub: c.tempVoice.hubChannelIds[0], cat: c.tempVoice.categoryId }),
    config: (ids, c) => ({ tempVoice: { enabled: true, hubChannelIds: [...new Set([...c.tempVoice.hubChannelIds, ids.hub])], categoryId: ids.cat } }),
  },
  {
    key: "stats", name: "Live server stats", icon: "📊",
    description: "Channels at the top of your server that show the member and boost count, updated automatically.",
    features: ["👥 Members counter", "💎 Boosts counter", "Updates every 10 minutes (Discord’s rename limit)"],
    channels: [
      { key: "cat", name: "Server Stats", type: "category" },
      { key: "members", name: "👥 Members: …", type: "voice", parent: "cat", noConnect: true },
      { key: "boosts", name: "💎 Boosts: …", type: "voice", parent: "cat", noConnect: true },
    ],
    roles: [],
    existing: (c) => clean({ members: firstStats(c, "{members}"), boosts: firstStats(c, "{boosts}") }),
    config: (ids, c) => {
      const keep = c.statsChannels.filter((s) => s.channelId !== ids.members && s.channelId !== ids.boosts);
      return { statsChannels: [...keep, { channelId: ids.members, template: "👥 Members: {members}" }, { channelId: ids.boosts, template: "💎 Boosts: {boosts}" }] };
    },
  },
];

export const setupPack = (key: string) => SETUP_PACKS.find((p) => p.key === key);

export interface SetupRecommendation { key: string; title: string; detail: string; severity: "high" | "medium" | "low"; pack: string }

/** What a server is missing, most important first — each item is fixed by applying a pack. */
export function setupRecommendations(c: GuildConfig): SetupRecommendation[] {
  const out: SetupRecommendation[] = [];
  if (!c.general.modLogChannelId && !c.general.logChannelId) out.push({ key: "logs", title: "No log channels", detail: "Moderation actions, raids and deleted messages aren't recorded anywhere.", severity: "high", pack: "essentials" });
  else if (!c.logging.enabled) out.push({ key: "logging", title: "Server logging is off", detail: "Edited/deleted messages, role changes and invites aren't being logged.", severity: "medium", pack: "essentials" });
  if (!c.automod.enabled) out.push({ key: "automod", title: "Auto-moderation is off", detail: "Spam, mass mentions and invite links won't be removed automatically.", severity: "high", pack: "essentials" });
  if (!c.security.enabled || !c.security.antiNuke.enabled) out.push({ key: "security", title: "Raid protection is off", detail: "Join spikes and mass channel/role deletions won't be stopped.", severity: "high", pack: "essentials" });
  if (!c.welcome.enabled) out.push({ key: "welcome", title: "No welcome message", detail: "New members aren't greeted or given a starter role.", severity: "medium", pack: "welcome" });
  if (!c.tickets.enabled) out.push({ key: "tickets", title: "No support tickets", detail: "Members have no private way to contact staff.", severity: "medium", pack: "support" });
  if (!c.verification.enabled) out.push({ key: "verification", title: "No verification gate", detail: "Bots and raid accounts can talk the moment they join.", severity: "low", pack: "verification" });
  if (!c.suggestions.enabled) out.push({ key: "suggestions", title: "No suggestions channel", detail: "Collect and vote on ideas from your community.", severity: "low", pack: "community" });
  if (!c.tempVoice.enabled) out.push({ key: "voice", title: "No join-to-create voice", detail: "Let members spin up their own voice rooms on demand.", severity: "low", pack: "voice" });
  return out;
}

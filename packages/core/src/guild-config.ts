import { z } from "zod";

/**
 * Per-guild configuration. Stored as JSONB in `guild_settings.config`, validated
 * on every read and write. Every feature is independently toggleable.
 */

const snowflake = z.string().regex(/^\d{15,22}$/);
const optId = snowflake.nullable().default(null);
const ids = z.array(snowflake).default([]);

export const punishmentAction = z.enum(["none", "delete", "warn", "timeout", "kick", "ban"]);
export type PunishmentAction = z.infer<typeof punishmentAction>;

const filterRule = z.object({
  enabled: z.boolean().default(false),
  action: punishmentAction.default("delete"),
  timeoutMinutes: z.number().int().min(1).max(40320).default(10),
});

export const embedSchema = z.object({
  title: z.string().max(256).optional(),
  description: z.string().max(4096).optional(),
  color: z.string().regex(/^#?[0-9a-fA-F]{6}$/).optional(),
  url: z.string().url().optional(),
  thumbnail: z.string().optional(),
  image: z.string().optional(),
  footer: z.string().max(2048).optional(),
  author: z.string().max(256).optional(),
  timestamp: z.boolean().optional(),
  fields: z.array(z.object({ name: z.string().max(256), value: z.string().max(1024), inline: z.boolean().optional() })).max(25).optional(),
});
export type EmbedData = z.infer<typeof embedSchema>;

export const messageTemplateSchema = z.object({
  content: z.string().max(2000).optional(),
  embed: embedSchema.optional(),
});
export type MessageTemplate = z.infer<typeof messageTemplateSchema>;

export const guildConfigSchema = z.object({
  general: z.object({
    locale: z.string().default("en"),
    accentColor: z.string().default("#DC143C"),
    logChannelId: optId,
    modLogChannelId: optId,
    securityLogChannelId: optId,
    timezone: z.string().default("UTC"),
  }).prefault({}),

  welcome: z.object({
    enabled: z.boolean().default(false),
    channelId: optId,
    message: messageTemplateSchema.prefault({
      embed: { title: "Welcome to {server}!", description: "Hey {user.mention}, you're member **#{server.members}**. Make yourself at home.", color: "#DC143C" },
    }),
    dm: z.object({ enabled: z.boolean().default(false), message: messageTemplateSchema.prefault({ content: "Welcome to {server}, {user.name}!" }) }).prefault({}),
  }).prefault({}),

  goodbye: z.object({
    enabled: z.boolean().default(false),
    channelId: optId,
    message: messageTemplateSchema.prefault({ content: "**{user.name}** has left {server}. We're now {server.members} members." }),
  }).prefault({}),

  autorole: z.object({
    enabled: z.boolean().default(false),
    roleIds: ids,
    botRoleIds: ids,
    delaySeconds: z.number().int().min(0).max(3600).default(0),
  }).prefault({}),

  verification: z.object({
    enabled: z.boolean().default(false),
    mode: z.enum(["button", "captcha"]).default("button"),
    channelId: optId,
    verifiedRoleId: optId,
    unverifiedRoleId: optId,
    message: messageTemplateSchema.prefault({
      embed: { title: "Verification", description: "Press the button below to verify and gain access to the server.", color: "#DC143C" },
    }),
  }).prefault({}),

  moderation: z.object({
    enabled: z.boolean().default(true),
    dmOnAction: z.boolean().default(true),
    requireReason: z.boolean().default(false),
    /** Role IDs allowed to use moderation commands in addition to Discord permissions. */
    moderatorRoleIds: ids,
    adminRoleIds: ids,
    warnExpiryDays: z.number().int().min(0).max(3650).default(90),
    appeals: z.object({
      enabled: z.boolean().default(true),
      channelId: optId,
      cooldownDays: z.number().int().min(0).max(365).default(7),
    }).prefault({}),
    escalation: z.array(z.object({
      warnings: z.number().int().min(1).max(100),
      action: z.enum(["timeout", "kick", "ban"]),
      durationMinutes: z.number().int().min(1).max(40320).optional(),
    })).default([
      { warnings: 3, action: "timeout", durationMinutes: 60 },
      { warnings: 5, action: "kick" },
      { warnings: 7, action: "ban" },
    ]),
  }).prefault({}),

  automod: z.object({
    enabled: z.boolean().default(false),
    exemptRoleIds: ids,
    exemptChannelIds: ids,
    spam: filterRule.extend({ maxMessages: z.number().int().min(2).max(50).default(6), perSeconds: z.number().int().min(1).max(120).default(5) }).prefault({ enabled: true, action: "timeout" }),
    duplicates: filterRule.extend({ maxDuplicates: z.number().int().min(2).max(20).default(3), perSeconds: z.number().int().min(5).max(600).default(30) }).prefault({ enabled: true }),
    mentions: filterRule.extend({ maxMentions: z.number().int().min(1).max(100).default(6), blockEveryone: z.boolean().default(true) }).prefault({ enabled: true, action: "timeout" }),
    links: filterRule.extend({ mode: z.enum(["allow-all", "whitelist", "block-all"]).default("allow-all"), allowedDomains: z.array(z.string()).default(["youtube.com", "youtu.be", "twitch.tv", "github.com", "tenor.com"]) }).prefault({}),
    invites: filterRule.extend({ allowOwnGuild: z.boolean().default(true), allowedGuildIds: ids }).prefault({ enabled: true }),
    words: filterRule.extend({ words: z.array(z.string()).default([]), regex: z.array(z.string()).default([]), matchWholeWord: z.boolean().default(true) }).prefault({}),
    caps: filterRule.extend({ percent: z.number().int().min(50).max(100).default(75), minLength: z.number().int().min(5).max(500).default(12) }).prefault({}),
    zalgo: filterRule.prefault({}),
    aiAssist: z.object({
      enabled: z.boolean().default(false),
      /** AI only flags to the mod log by default — it never punishes on its own unless explicitly allowed. */
      autoAct: z.boolean().default(false),
      threshold: z.number().min(0).max(1).default(0.85),
    }).prefault({}),
  }).prefault({}),

  security: z.object({
    enabled: z.boolean().default(true),
    /** Presets tune all thresholds: low = few interventions, paranoid = very aggressive. */
    sensitivity: z.enum(["low", "medium", "high", "paranoid"]).default("medium"),
    joinSpike: z.object({ joins: z.number().int().min(3).max(500).default(10), perSeconds: z.number().int().min(5).max(600).default(30) }).prefault({}),
    minAccountAgeDays: z.number().int().min(0).max(365).default(3),
    suspiciousAction: z.enum(["none", "flag", "timeout", "kick", "ban"]).default("flag"),
    raidAction: z.enum(["alert", "lockdown", "kick-new", "ban-new"]).default("lockdown"),
    raidModeMinutes: z.number().int().min(1).max(1440).default(15),
    autoRecover: z.boolean().default(true),
    raiseVerificationOnRaid: z.boolean().default(true),
    alertRoleIds: ids,
    trustedRoleIds: ids,
    lockdownChannelIds: ids,
    antiNuke: z.object({
      enabled: z.boolean().default(true),
      maxChannelDeletes: z.number().int().min(1).max(50).default(3),
      maxRoleDeletes: z.number().int().min(1).max(50).default(3),
      maxBans: z.number().int().min(1).max(100).default(5),
      perSeconds: z.number().int().min(5).max(600).default(60),
    }).prefault({}),
  }).prefault({}),

  tickets: z.object({
    enabled: z.boolean().default(false),
    maxOpenPerUser: z.number().int().min(1).max(20).default(2),
    transcriptChannelId: optId,
    archiveCategoryId: optId,
    deleteOnClose: z.boolean().default(false),
    deleteDelaySeconds: z.number().int().min(0).max(86400).default(10),
    namingPattern: z.string().default("ticket-{number}"),
    autoCloseHours: z.number().int().min(0).max(720).default(0),
    aiFirstResponse: z.boolean().default(false),
    dmTranscript: z.boolean().default(true),
  }).prefault({}),

  leveling: z.object({
    enabled: z.boolean().default(false),
    xpMin: z.number().int().min(0).max(1000).default(15),
    xpMax: z.number().int().min(0).max(1000).default(25),
    cooldownSeconds: z.number().int().min(0).max(3600).default(60),
    voiceXpPerMinute: z.number().int().min(0).max(100).default(5),
    announce: z.enum(["off", "same-channel", "channel", "dm"]).default("same-channel"),
    announceChannelId: optId,
    announceMessage: z.string().default("🎉 {user.mention} reached **level {level}**!"),
    noXpChannelIds: ids,
    noXpRoleIds: ids,
    multipliers: z.array(z.object({ roleId: snowflake, multiplier: z.number().min(0).max(10) })).default([]),
    rewards: z.array(z.object({ level: z.number().int().min(1).max(1000), roleId: snowflake })).default([]),
    stackRewards: z.boolean().default(true),
  }).prefault({}),

  economy: z.object({
    enabled: z.boolean().default(false),
    currencyName: z.string().default("moth coins"),
    currencyEmoji: z.string().default("🪙"),
    dailyAmount: z.number().int().min(0).max(1_000_000).default(100),
    streakBonus: z.number().int().min(0).max(100_000).default(10),
    maxStreakBonusDays: z.number().int().min(1).max(365).default(14),
    messageReward: z.number().int().min(0).max(1000).default(1),
    shop: z.array(z.object({ id: z.string(), name: z.string(), price: z.number().int().min(0), roleId: snowflake.optional(), description: z.string().optional() })).default([]),
  }).prefault({}),

  achievements: z.object({
    enabled: z.boolean().default(false),
    announce: z.boolean().default(true),
    disabledKeys: z.array(z.string()).default([]),
  }).prefault({}),

  community: z.object({
    giveawaysEnabled: z.boolean().default(true),
    pollsEnabled: z.boolean().default(true),
    milestones: z.object({ enabled: z.boolean().default(false), every: z.number().int().min(10).default(100), channelId: optId, message: z.string().default("🎊 We just hit **{server.members}** members! Thank you all.") }).prefault({}),
    giveawayManagerRoleIds: ids,
  }).prefault({}),

  ai: z.object({
    /** Member-facing AI (/ask, @mentions, chat channels). The Architect works regardless. */
    enabled: z.boolean().default(false),
    providerId: z.string().nullable().default(null),
    personality: z.object({
      name: z.string().default("MOTH"),
      tone: z.enum(["professional", "friendly", "playful", "concise", "custom"]).default("friendly"),
      customPrompt: z.string().max(4000).default(""),
    }).prefault({}),
    chatChannelIds: ids,
    respondToMentions: z.boolean().default(true),
    allowedRoleIds: ids,
    maxTokens: z.number().int().min(64).max(8192).default(800),
    dailyRequestLimitPerUser: z.number().int().min(0).max(10_000).default(50),
    supportAutoReply: z.boolean().default(false),
  }).prefault({}),

  /** Server event logs (message edits/deletes, members, roles, channels, voice, invites). */
  logging: z.object({
    enabled: z.boolean().default(false),
    /** Falls back to general.logChannelId when a per-category channel is not set. */
    messageChannelId: optId,
    memberChannelId: optId,
    serverChannelId: optId,
    voiceChannelId: optId,
    events: z.object({
      messageDelete: z.boolean().default(true),
      messageEdit: z.boolean().default(true),
      bulkDelete: z.boolean().default(true),
      memberJoin: z.boolean().default(true),
      memberLeave: z.boolean().default(true),
      memberRoles: z.boolean().default(true),
      nickname: z.boolean().default(true),
      channels: z.boolean().default(true),
      roles: z.boolean().default(true),
      voice: z.boolean().default(false),
      invites: z.boolean().default(true),
      bans: z.boolean().default(true),
    }).prefault({}),
    /** Track which invite each member used to join. */
    inviteTracking: z.boolean().default(true),
    ignoredChannelIds: ids,
    ignoreBots: z.boolean().default(true),
  }).prefault({}),

  /** Join-to-create voice channels. */
  tempVoice: z.object({
    enabled: z.boolean().default(false),
    hubChannelIds: ids,
    /** Category for created channels; defaults to the hub's category. */
    categoryId: optId,
    nameTemplate: z.string().max(100).default("{user}'s room"),
    defaultLimit: z.number().int().min(0).max(99).default(0),
    /** Post a control panel (lock, hide, rename, limit, claim) in the channel's chat. */
    controlPanel: z.boolean().default(true),
  }).prefault({}),

  suggestions: z.object({
    enabled: z.boolean().default(false),
    channelId: optId,
    /** Messages typed in the suggestion channel are turned into suggestions automatically. */
    convertMessages: z.boolean().default(true),
    autoThread: z.boolean().default(true),
    anonymous: z.boolean().default(false),
    staffRoleIds: ids,
    /** Where approved/denied suggestions are reposted (optional). */
    reviewedChannelId: optId,
    dmAuthor: z.boolean().default(true),
  }).prefault({}),

  starboard: z.object({
    enabled: z.boolean().default(false),
    channelId: optId,
    emoji: z.string().default("⭐"),
    threshold: z.number().int().min(1).max(100).default(3),
    ignoredChannelIds: ids,
    allowSelfStar: z.boolean().default(false),
  }).prefault({}),

  /** Per-channel behaviour rules. */
  channelRules: z.array(z.object({
    channelId: snowflake,
    /** Delete messages without an attachment or link. */
    mediaOnly: z.boolean().default(false),
    /** Create a thread on every new message. */
    autoThread: z.boolean().default(false),
    threadName: z.string().max(100).default("{user.name}'s thread"),
    /** Publish messages in announcement channels automatically. */
    autoPublish: z.boolean().default(false),
    autoReact: z.array(z.string()).max(5).default([]),
    /** Delete messages after N seconds (0 = keep). */
    deleteAfterSeconds: z.number().int().min(0).max(86_400).default(0),
    /** Only one message per member per N minutes (0 = off). */
    oneMessagePerMinutes: z.number().int().min(0).max(10_080).default(0),
  })).max(50).default([]),

  /** Messages that stay at the bottom of a channel. */
  sticky: z.array(z.object({
    channelId: snowflake,
    message: messageTemplateSchema,
    /** Re-post after this many new messages. */
    every: z.number().int().min(1).max(50).default(4),
  })).max(25).default([]),

  /** Voice/text channels whose names show live server stats. */
  statsChannels: z.array(z.object({
    channelId: snowflake,
    /** Placeholders: {members} {humans} {bots} {boosts} {online} {channels} {roles} */
    template: z.string().max(100),
  })).max(10).default([]),

  backups: z.object({
    autoDaily: z.boolean().default(true),
    keep: z.number().int().min(1).max(100).default(14),
  }).prefault({}),

  dashboard: z.object({
    /** Role-based dashboard access granted to non-admins. */
    moderatorRoleIds: ids,
    viewerRoleIds: ids,
  }).prefault({}),
});

export type GuildConfig = z.infer<typeof guildConfigSchema>;
export type GuildConfigSection = keyof GuildConfig;
export const guildConfigSections = Object.keys(guildConfigSchema.shape) as GuildConfigSection[];

export function defaultGuildConfig(): GuildConfig {
  return guildConfigSchema.parse({});
}

/** Parses stored config, falling back to defaults per-section if a section is corrupt. */
export function parseGuildConfig(raw: unknown): GuildConfig {
  const result = guildConfigSchema.safeParse(raw ?? {});
  if (result.success) return result.data;
  const defaults = defaultGuildConfig() as Record<string, unknown>;
  const input = (raw ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of guildConfigSections) {
    const section = guildConfigSchema.shape[key].safeParse(input[key]);
    out[key] = section.success ? section.data : defaults[key];
  }
  return out as GuildConfig;
}

/** Sensitivity presets for the anti-raid engine. */
export function securityThresholds(cfg: GuildConfig["security"]) {
  const scale = { low: 2, medium: 1, high: 0.6, paranoid: 0.35 }[cfg.sensitivity];
  return {
    joins: Math.max(3, Math.round(cfg.joinSpike.joins * scale)),
    perSeconds: cfg.joinSpike.perSeconds,
    suspicionScore: { low: 80, medium: 65, high: 50, paranoid: 35 }[cfg.sensitivity],
    minAccountAgeDays: cfg.minAccountAgeDays,
  };
}

import { sql } from "drizzle-orm";
import {
  bigint, boolean, index, integer, jsonb, pgTable, primaryKey, real, serial, text, timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

// ───────────────────────── Guilds & configuration ─────────────────────────

export const guilds = pgTable("guilds", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  icon: text("icon"),
  ownerId: text("owner_id").notNull(),
  memberCount: integer("member_count").notNull().default(0),
  active: boolean("active").notNull().default(true),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  leftAt: timestamp("left_at", { withTimezone: true }),
  updatedAt: updatedAt(),
});

export const guildSettings = pgTable("guild_settings", {
  guildId: text("guild_id").primaryKey().references(() => guilds.id, { onDelete: "cascade" }),
  config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
  version: integer("version").notNull().default(1),
  updatedBy: text("updated_by"),
  updatedAt: updatedAt(),
});

/** Explicit dashboard grants for users (by user or role) beyond Discord permissions. */
export const dashboardAccess = pgTable("dashboard_access", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull().references(() => guilds.id, { onDelete: "cascade" }),
  subjectType: text("subject_type").$type<"user" | "role">().notNull(),
  subjectId: text("subject_id").notNull(),
  level: text("level").$type<"admin" | "moderator" | "viewer">().notNull(),
  createdBy: text("created_by"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("dashboard_access_unique").on(t.guildId, t.subjectType, t.subjectId)]);

export const dashboardSessions = pgTable("dashboard_sessions", {
  id: text("id").primaryKey(), // sha256 of the cookie token
  userId: text("user_id").notNull(),
  user: jsonb("user").$type<{ id: string; username: string; globalName: string | null; avatar: string | null }>().notNull(),
  accessTokenEnc: text("access_token_enc").notNull(),
  refreshTokenEnc: text("refresh_token_enc"),
  tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }).notNull(),
  guildCache: jsonb("guild_cache").$type<{ id: string; name: string; icon: string | null; owner: boolean; permissions: string }[]>(),
  guildCacheAt: timestamp("guild_cache_at", { withTimezone: true }),
  userAgent: text("user_agent"),
  ip: text("ip"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("dashboard_sessions_user").on(t.userId)]);

// ───────────────────────── Audit & backups ─────────────────────────

export const changeLog = pgTable("change_log", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  actorId: text("actor_id"),
  source: text("source").$type<"discord" | "dashboard" | "ai" | "system" | "architect">().notNull(),
  action: text("action").notNull(),
  target: text("target"),
  before: jsonb("before"),
  after: jsonb("after"),
  createdAt: createdAt(),
}, (t) => [index("change_log_guild").on(t.guildId, t.createdAt)]);

export const configBackups = pgTable("config_backups", {
  id: uuid("id").primaryKey().defaultRandom(),
  guildId: text("guild_id").notNull().references(() => guilds.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  kind: text("kind").$type<"manual" | "auto" | "pre-architect" | "pre-restore">().notNull(),
  snapshot: jsonb("snapshot").notNull(),
  sizeBytes: integer("size_bytes").notNull().default(0),
  createdBy: text("created_by"),
  createdAt: createdAt(),
}, (t) => [index("config_backups_guild").on(t.guildId, t.createdAt)]);

// ───────────────────────── Moderation ─────────────────────────

export const modCases = pgTable("mod_cases", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  caseNumber: integer("case_number").notNull(),
  type: text("type").$type<"warn" | "timeout" | "untimeout" | "kick" | "ban" | "unban" | "softban" | "note" | "purge" | "automod">().notNull(),
  targetId: text("target_id").notNull(),
  targetTag: text("target_tag"),
  moderatorId: text("moderator_id").notNull(),
  reason: text("reason"),
  durationMs: bigint("duration_ms", { mode: "number" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  active: boolean("active").notNull().default(true),
  automated: boolean("automated").notNull().default(false),
  /** Machine-readable explanation for automated enforcement. */
  explanation: jsonb("explanation"),
  logMessageId: text("log_message_id"),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("mod_cases_number").on(t.guildId, t.caseNumber),
  index("mod_cases_target").on(t.guildId, t.targetId),
  index("mod_cases_expiry").on(t.expiresAt),
]);

export const appeals = pgTable("appeals", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  caseId: integer("case_id").references(() => modCases.id, { onDelete: "set null" }),
  userId: text("user_id").notNull(),
  userTag: text("user_tag"),
  content: text("content").notNull(),
  status: text("status").$type<"pending" | "accepted" | "denied">().notNull().default("pending"),
  reviewerId: text("reviewer_id"),
  response: text("response"),
  createdAt: createdAt(),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
}, (t) => [index("appeals_guild").on(t.guildId, t.status)]);

export const securityEvents = pgTable("security_events", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  type: text("type").notNull(), // join_spike, suspicious_account, raid_mode_on, raid_mode_off, lockdown, nuke_attempt, automod
  severity: text("severity").$type<"info" | "low" | "medium" | "high" | "critical">().notNull(),
  userId: text("user_id"),
  summary: text("summary").notNull(),
  details: jsonb("details"),
  actionTaken: text("action_taken"),
  createdAt: createdAt(),
}, (t) => [index("security_events_guild").on(t.guildId, t.createdAt)]);

/** Persisted raid/lockdown state so the bot can recover after restarts. */
export const guildState = pgTable("guild_state", {
  guildId: text("guild_id").primaryKey(),
  raidMode: boolean("raid_mode").notNull().default(false),
  raidModeUntil: timestamp("raid_mode_until", { withTimezone: true }),
  lockdown: boolean("lockdown").notNull().default(false),
  /** Saved permission overwrites / verification level to restore after a lockdown. */
  restoreData: jsonb("restore_data"),
  updatedAt: updatedAt(),
});

// ───────────────────────── Tickets ─────────────────────────

export type TicketCategoryDef = {
  id: string; label: string; emoji?: string; description?: string;
  parentCategoryId?: string | null; staffRoleIds: string[];
  openMessage?: string; questions?: { label: string; placeholder?: string; required?: boolean; long?: boolean }[];
  defaultPriority?: "low" | "normal" | "high" | "urgent";
};

export const ticketPanels = pgTable("ticket_panels", {
  id: uuid("id").primaryKey().defaultRandom(),
  guildId: text("guild_id").notNull().references(() => guilds.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  channelId: text("channel_id"),
  messageId: text("message_id"),
  style: text("style").$type<"buttons" | "select">().notNull().default("buttons"),
  embed: jsonb("embed").notNull(),
  categories: jsonb("categories").$type<TicketCategoryDef[]>().notNull(),
  staffRoleIds: jsonb("staff_role_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  parentCategoryId: text("parent_category_id"),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const tickets = pgTable("tickets", {
  id: uuid("id").primaryKey().defaultRandom(),
  guildId: text("guild_id").notNull(),
  panelId: uuid("panel_id").references(() => ticketPanels.id, { onDelete: "set null" }),
  categoryId: text("category_id"),
  categoryLabel: text("category_label"),
  number: integer("number").notNull(),
  channelId: text("channel_id"),
  openerId: text("opener_id").notNull(),
  openerTag: text("opener_tag"),
  claimedById: text("claimed_by_id"),
  assigneeIds: jsonb("assignee_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  priority: text("priority").$type<"low" | "normal" | "high" | "urgent">().notNull().default("normal"),
  status: text("status").$type<"open" | "closed" | "archived">().notNull().default("open"),
  subject: text("subject"),
  answers: jsonb("answers").$type<{ question: string; answer: string }[]>(),
  closedById: text("closed_by_id"),
  closeReason: text("close_reason"),
  firstResponseAt: timestamp("first_response_at", { withTimezone: true }),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: createdAt(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("tickets_number").on(t.guildId, t.number),
  index("tickets_status").on(t.guildId, t.status),
  index("tickets_channel").on(t.channelId),
]);

export const ticketTranscripts = pgTable("ticket_transcripts", {
  id: serial("id").primaryKey(),
  ticketId: uuid("ticket_id").notNull().references(() => tickets.id, { onDelete: "cascade" }),
  html: text("html").notNull(),
  messageCount: integer("message_count").notNull(),
  createdAt: createdAt(),
});

// ───────────────────────── Automation & commands ─────────────────────────

export const automations = pgTable("automations", {
  id: uuid("id").primaryKey().defaultRandom(),
  guildId: text("guild_id").notNull().references(() => guilds.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  enabled: boolean("enabled").notNull().default(true),
  /** Validated by automationSchema in @moth/core/automation. */
  definition: jsonb("definition").notNull(),
  runCount: integer("run_count").notNull().default(0),
  failCount: integer("fail_count").notNull().default(0),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  createdBy: text("created_by"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("automations_guild").on(t.guildId)]);

export const automationRuns = pgTable("automation_runs", {
  id: serial("id").primaryKey(),
  automationId: uuid("automation_id").notNull().references(() => automations.id, { onDelete: "cascade" }),
  guildId: text("guild_id").notNull(),
  status: text("status").$type<"success" | "skipped" | "failed">().notNull(),
  trigger: text("trigger").notNull(),
  durationMs: integer("duration_ms").notNull().default(0),
  error: text("error"),
  createdAt: createdAt(),
}, (t) => [index("automation_runs_guild").on(t.guildId, t.createdAt)]);

export const customCommands = pgTable("custom_commands", {
  id: uuid("id").primaryKey().defaultRandom(),
  guildId: text("guild_id").notNull().references(() => guilds.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** Validated by customCommandSchema in @moth/core/commands. */
  definition: jsonb("definition").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  uses: integer("uses").notNull().default(0),
  createdBy: text("created_by"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("custom_commands_name").on(t.guildId, t.name)]);

export const roleMenus = pgTable("role_menus", {
  id: uuid("id").primaryKey().defaultRandom(),
  guildId: text("guild_id").notNull().references(() => guilds.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  channelId: text("channel_id"),
  messageId: text("message_id"),
  style: text("style").$type<"reactions" | "buttons" | "select">().notNull(),
  mode: text("mode").$type<"toggle" | "unique" | "add-only" | "remove-only">().notNull().default("toggle"),
  embed: jsonb("embed").notNull(),
  options: jsonb("options").$type<{ roleId: string; label: string; emoji?: string; description?: string }[]>().notNull(),
  maxSelections: integer("max_selections"),
  requiredRoleIds: jsonb("required_role_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("role_menus_message").on(t.messageId)]);

// ───────────────────────── Community ─────────────────────────

export const memberLevels = pgTable("member_levels", {
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  xp: integer("xp").notNull().default(0),
  level: integer("level").notNull().default(0),
  messages: integer("messages").notNull().default(0),
  voiceMinutes: integer("voice_minutes").notNull().default(0),
  lastXpAt: timestamp("last_xp_at", { withTimezone: true }),
  updatedAt: updatedAt(),
}, (t) => [primaryKey({ columns: [t.guildId, t.userId] }), index("member_levels_rank").on(t.guildId, t.xp)]);

export const economyAccounts = pgTable("economy_accounts", {
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  balance: bigint("balance", { mode: "number" }).notNull().default(0),
  lifetimeEarned: bigint("lifetime_earned", { mode: "number" }).notNull().default(0),
  lastDailyAt: timestamp("last_daily_at", { withTimezone: true }),
  streak: integer("streak").notNull().default(0),
  updatedAt: updatedAt(),
}, (t) => [primaryKey({ columns: [t.guildId, t.userId] }), index("economy_rank").on(t.guildId, t.balance)]);

export const userAchievements = pgTable("user_achievements", {
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  key: text("key").notNull(),
  unlockedAt: timestamp("unlocked_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.guildId, t.userId, t.key] })]);

export const giveaways = pgTable("giveaways", {
  id: uuid("id").primaryKey().defaultRandom(),
  guildId: text("guild_id").notNull(),
  channelId: text("channel_id").notNull(),
  messageId: text("message_id"),
  prize: text("prize").notNull(),
  description: text("description"),
  winnerCount: integer("winner_count").notNull().default(1),
  hostId: text("host_id").notNull(),
  requiredRoleId: text("required_role_id"),
  minLevel: integer("min_level"),
  entrants: jsonb("entrants").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  winnerIds: jsonb("winner_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  ended: boolean("ended").notNull().default(false),
  createdAt: createdAt(),
}, (t) => [index("giveaways_active").on(t.ended, t.endsAt)]);

export const polls = pgTable("polls", {
  id: uuid("id").primaryKey().defaultRandom(),
  guildId: text("guild_id").notNull(),
  channelId: text("channel_id").notNull(),
  messageId: text("message_id"),
  question: text("question").notNull(),
  options: jsonb("options").$type<string[]>().notNull(),
  votes: jsonb("votes").$type<Record<string, number[]>>().notNull().default(sql`'{}'::jsonb`),
  multiple: boolean("multiple").notNull().default(false),
  anonymous: boolean("anonymous").notNull().default(true),
  creatorId: text("creator_id").notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  ended: boolean("ended").notNull().default(false),
  createdAt: createdAt(),
}, (t) => [index("polls_active").on(t.ended, t.endsAt)]);

// ───────────────────────── Analytics ─────────────────────────

export const analyticsHourly = pgTable("analytics_hourly", {
  guildId: text("guild_id").notNull(),
  hour: timestamp("hour", { withTimezone: true }).notNull(),
  messages: integer("messages").notNull().default(0),
  joins: integer("joins").notNull().default(0),
  leaves: integer("leaves").notNull().default(0),
  activeUsers: integer("active_users").notNull().default(0),
  voiceMinutes: integer("voice_minutes").notNull().default(0),
  commands: integer("commands").notNull().default(0),
  memberCount: integer("member_count"),
}, (t) => [primaryKey({ columns: [t.guildId, t.hour] })]);

export const channelActivity = pgTable("channel_activity", {
  guildId: text("guild_id").notNull(),
  channelId: text("channel_id").notNull(),
  day: timestamp("day", { withTimezone: true }).notNull(),
  messages: integer("messages").notNull().default(0),
}, (t) => [primaryKey({ columns: [t.guildId, t.channelId, t.day] })]);

// ───────────────────────── AI & Architect ─────────────────────────

export const aiProviders = pgTable("ai_providers", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** null = platform-wide provider configured by the instance owner. */
  guildId: text("guild_id").references(() => guilds.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  kind: text("kind").$type<"openai" | "anthropic" | "ollama" | "openai-compatible">().notNull(),
  baseUrl: text("base_url"),
  model: text("model").notNull(),
  apiKeyEnc: text("api_key_enc"),
  temperature: real("temperature").notNull().default(0.4),
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const aiUsage = pgTable("ai_usage", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id"),
  userId: text("user_id"),
  feature: text("feature").notNull(),
  providerKind: text("provider_kind"),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  createdAt: createdAt(),
}, (t) => [index("ai_usage_guild").on(t.guildId, t.createdAt), index("ai_usage_user").on(t.guildId, t.userId, t.createdAt)]);

export const architectSessions = pgTable("architect_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  guildId: text("guild_id").notNull().references(() => guilds.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  mode: text("mode").$type<"create" | "quick" | "improve" | "redesign">().notNull(),
  title: text("title"),
  messages: jsonb("messages").$type<{ role: "user" | "assistant"; content: string; at: string }[]>().notNull().default(sql`'[]'::jsonb`),
  /** Current proposed blueprint (partial for quick/improve). */
  blueprint: jsonb("blueprint"),
  analysis: jsonb("analysis"),
  plan: jsonb("plan"),
  status: text("status").$type<"drafting" | "applying" | "applied" | "failed" | "rolled_back" | "cancelled">().notNull().default("drafting"),
  backupId: uuid("backup_id"),
  /** Result of apply: created/updated entity ids for rollback. */
  result: jsonb("result"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("architect_sessions_guild").on(t.guildId, t.createdAt)]);

export const blueprints = pgTable("blueprints", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** null = shared across the whole instance. */
  guildId: text("guild_id"),
  name: text("name").notNull(),
  description: text("description"),
  tags: jsonb("tags").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  blueprint: jsonb("blueprint").notNull(),
  createdBy: text("created_by"),
  createdAt: createdAt(),
});

export const scheduledJobs = pgTable("scheduled_jobs", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  kind: text("kind").notNull(), // unban, untimeout-role, ticket-delete, reminder
  runAt: timestamp("run_at", { withTimezone: true }).notNull(),
  payload: jsonb("payload").notNull(),
  attempts: integer("attempts").notNull().default(0),
  done: boolean("done").notNull().default(false),
  lastError: text("last_error"),
  createdAt: createdAt(),
}, (t) => [index("scheduled_jobs_due").on(t.done, t.runAt)]);

export const serviceHeartbeats = pgTable("service_heartbeats", {
  service: text("service").primaryKey(),
  status: text("status").notNull(),
  details: jsonb("details"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  beatAt: timestamp("beat_at", { withTimezone: true }).notNull().defaultNow(),
});

// ───────────────────────── Server tools ─────────────────────────

/** Join-to-create voice channels currently alive (so they are cleaned up after restarts). */
export const tempVoiceChannels = pgTable("temp_voice_channels", {
  channelId: text("channel_id").primaryKey(),
  guildId: text("guild_id").notNull(),
  ownerId: text("owner_id").notNull(),
  panelMessageId: text("panel_message_id"),
  createdAt: createdAt(),
}, (t) => [index("temp_voice_guild").on(t.guildId)]);

export const suggestions = pgTable("suggestions", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  number: integer("number").notNull(),
  authorId: text("author_id").notNull(),
  content: text("content").notNull(),
  channelId: text("channel_id").notNull(),
  messageId: text("message_id"),
  threadId: text("thread_id"),
  status: text("status").$type<"open" | "approved" | "denied" | "implemented" | "considering">().notNull().default("open"),
  upvotes: integer("upvotes").notNull().default(0),
  downvotes: integer("downvotes").notNull().default(0),
  reviewerId: text("reviewer_id"),
  response: text("response"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("suggestions_number").on(t.guildId, t.number), index("suggestions_message").on(t.messageId)]);

export const suggestionVotes = pgTable("suggestion_votes", {
  suggestionId: integer("suggestion_id").notNull().references(() => suggestions.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  value: integer("value").notNull(),
}, (t) => [primaryKey({ columns: [t.suggestionId, t.userId] })]);

export const starboardPosts = pgTable("starboard_posts", {
  messageId: text("message_id").primaryKey(),
  guildId: text("guild_id").notNull(),
  channelId: text("channel_id").notNull(),
  authorId: text("author_id").notNull(),
  starboardMessageId: text("starboard_message_id"),
  stars: integer("stars").notNull().default(0),
  createdAt: createdAt(),
}, (t) => [index("starboard_guild").on(t.guildId, t.stars)]);

/** Which invite each member used (invite tracking). */
export const memberInvites = pgTable("member_invites", {
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  code: text("code"),
  inviterId: text("inviter_id"),
  left: boolean("left").notNull().default(false),
  joinedAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.guildId, t.userId] }), index("member_invites_inviter").on(t.guildId, t.inviterId)]);

/** Small per-guild key/value state for features (sticky message ids, stats cache…). */
export const featureState = pgTable("feature_state", {
  guildId: text("guild_id").notNull(),
  key: text("key").notNull(),
  value: jsonb("value").notNull(),
  updatedAt: updatedAt(),
}, (t) => [primaryKey({ columns: [t.guildId, t.key] })]);

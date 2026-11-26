import { z } from "zod";
import { embedSchema } from "../guild-config.js";
import { automationSchema } from "../automation/schema.js";
import { ROLE_PRESETS } from "./permissions.js";

/**
 * A Blueprint describes a desired Discord server (or a set of changes to one).
 *
 * References ("ref") point at roles/channels by blueprint `key` first, then by
 * the name of an existing role/channel. "@everyone" is always valid for roles.
 *
 * Blueprints are additive: nothing is deleted unless listed under `removals`
 * (or, in Full Redesign with pruning enabled, when not present in the blueprint).
 */

const ref = z.string().min(1).max(100);
const permList = z.array(z.string()).default([]);

export const overwriteSchema = z.object({
  target: ref.describe("role key, existing role name, or @everyone"),
  allow: permList,
  deny: permList,
});

export const channelTypeSchema = z.enum(["text", "voice", "announcement", "forum", "stage"]);

export const blueprintChannelSchema = z.object({
  key: z.string().max(60).optional(),
  name: z.string().min(1).max(100),
  renameFrom: z.string().max(100).optional(),
  type: channelTypeSchema.default("text"),
  topic: z.string().max(1024).optional(),
  slowmode: z.number().int().min(0).max(21600).optional(),
  nsfw: z.boolean().optional(),
  userLimit: z.number().int().min(0).max(99).optional(),
  /** Hidden from @everyone; visible to `visibleTo` roles (and staff). */
  private: z.boolean().optional(),
  visibleTo: z.array(ref).optional(),
  /** @everyone can read but not send; `writableBy` roles can send. */
  readOnly: z.boolean().optional(),
  writableBy: z.array(ref).optional(),
  overwrites: z.array(overwriteSchema).optional(),
  purpose: z.string().max(200).optional(),
});
export type BlueprintChannel = z.infer<typeof blueprintChannelSchema>;

export const blueprintCategorySchema = z.object({
  key: z.string().max(60).optional(),
  name: z.string().min(1).max(100),
  renameFrom: z.string().max(100).optional(),
  private: z.boolean().optional(),
  visibleTo: z.array(ref).optional(),
  readOnly: z.boolean().optional(),
  writableBy: z.array(ref).optional(),
  overwrites: z.array(overwriteSchema).optional(),
  channels: z.array(blueprintChannelSchema).default([]),
});
export type BlueprintCategory = z.infer<typeof blueprintCategorySchema>;

export const blueprintRoleSchema = z.object({
  key: z.string().min(1).max(60),
  name: z.string().min(1).max(100),
  renameFrom: z.string().max(100).optional(),
  color: z.string().regex(/^#?[0-9a-fA-F]{6}$/).optional(),
  hoist: z.boolean().optional(),
  mentionable: z.boolean().optional(),
  preset: z.enum(Object.keys(ROLE_PRESETS) as [keyof typeof ROLE_PRESETS, ...(keyof typeof ROLE_PRESETS)[]]).optional(),
  permissions: z.array(z.string()).optional(),
  description: z.string().max(200).optional(),
});
export type BlueprintRole = z.infer<typeof blueprintRoleSchema>;

export const blueprintFeaturesSchema = z.object({
  welcome: z.object({ channel: ref, title: z.string().max(256).optional(), message: z.string().max(2000), dm: z.string().max(2000).optional() }).optional(),
  goodbye: z.object({ channel: ref, message: z.string().max(2000) }).optional(),
  verification: z.object({ mode: z.enum(["button", "captcha"]).default("button"), channel: ref, verifiedRole: ref, message: z.string().max(2000).optional() }).optional(),
  autoroles: z.array(ref).optional(),
  moderation: z.object({ preset: z.enum(["relaxed", "balanced", "strict"]).default("balanced"), logChannel: ref.optional(), modRoles: z.array(ref).optional(), appealsChannel: ref.optional() }).optional(),
  security: z.object({ sensitivity: z.enum(["low", "medium", "high", "paranoid"]).default("medium"), logChannel: ref.optional(), alertRoles: z.array(ref).optional() }).optional(),
  tickets: z.array(z.object({
    name: z.string().max(100),
    channel: ref,
    title: z.string().max(256).optional(),
    description: z.string().max(2000).optional(),
    parentCategory: ref.optional(),
    transcriptChannel: ref.optional(),
    staffRoles: z.array(ref).default([]),
    categories: z.array(z.object({
      label: z.string().max(80), emoji: z.string().max(40).optional(), description: z.string().max(100).optional(),
      staffRoles: z.array(ref).optional(),
      questions: z.array(z.object({ label: z.string().max(45), placeholder: z.string().max(100).optional(), long: z.boolean().optional(), required: z.boolean().optional() })).max(5).optional(),
    })).min(1).max(25),
  })).optional(),
  roleMenus: z.array(z.object({
    name: z.string().max(100), channel: ref, style: z.enum(["buttons", "select", "reactions"]).default("buttons"),
    mode: z.enum(["toggle", "unique"]).default("toggle"),
    title: z.string().max(256), description: z.string().max(2000).optional(),
    options: z.array(z.object({ role: ref, label: z.string().max(80), emoji: z.string().max(40).optional(), description: z.string().max(100).optional() })).min(1).max(25),
  })).optional(),
  leveling: z.object({ enabled: z.boolean().default(true), announceChannel: ref.optional(), rewards: z.array(z.object({ level: z.number().int().min(1), role: ref })).optional() }).optional(),
  economy: z.object({ enabled: z.boolean().default(true), currencyName: z.string().max(40).optional(), currencyEmoji: z.string().max(40).optional() }).optional(),
  achievements: z.object({ enabled: z.boolean().default(true) }).optional(),
  ai: z.object({ enabled: z.boolean().default(true), chatChannels: z.array(ref).optional(), tone: z.enum(["professional", "friendly", "playful", "concise"]).optional() }).optional(),
  milestones: z.object({ channel: ref, every: z.number().int().min(10).default(100) }).optional(),
  automations: z.array(z.object({ name: z.string().max(100), description: z.string().max(500).optional(), definition: automationSchema })).optional(),
  messages: z.array(z.object({ channel: ref, content: z.string().max(2000).optional(), embed: embedSchema.optional(), pin: z.boolean().optional() })).optional(),
});
export type BlueprintFeatures = z.infer<typeof blueprintFeaturesSchema>;

export const blueprintSchema = z.object({
  name: z.string().max(100).optional(),
  description: z.string().max(1000).optional(),
  purpose: z.string().max(300).optional(),
  audience: z.string().max(300).optional(),
  theme: z.object({
    primaryColor: z.string().regex(/^#?[0-9a-fA-F]{6}$/).default("#DC143C"),
    accentColor: z.string().regex(/^#?[0-9a-fA-F]{6}$/).optional(),
    namingStyle: z.string().max(60).optional().describe("e.g. '┃emoji-name', 'plain', 'Title Case'"),
    tone: z.string().max(60).optional(),
    tagline: z.string().max(200).optional(),
  }).optional(),
  verificationLevel: z.enum(["none", "low", "medium", "high", "very_high"]).optional(),
  /** Listed highest → lowest in the hierarchy. */
  roles: z.array(blueprintRoleSchema).default([]),
  /** Channels not inside any category. */
  channels: z.array(blueprintChannelSchema).default([]),
  categories: z.array(blueprintCategorySchema).default([]),
  features: blueprintFeaturesSchema.prefault({}),
  removals: z.object({
    channels: z.array(z.string()).default([]),
    categories: z.array(z.string()).default([]),
    roles: z.array(z.string()).default([]),
  }).prefault({}),
});
export type Blueprint = z.infer<typeof blueprintSchema>;
export type BlueprintInput = z.input<typeof blueprintSchema>;

/** Structured AI response for architect conversation turns. */
export const architectTurnSchema = z.object({
  reply: z.string().max(4000),
  blueprint: blueprintSchema,
  questions: z.array(z.string()).max(5).optional(),
});

export const analysisFindingSchema = z.object({
  severity: z.enum(["info", "low", "medium", "high", "critical"]),
  area: z.enum(["structure", "permissions", "security", "moderation", "onboarding", "engagement", "roles", "branding"]),
  title: z.string().max(200),
  detail: z.string().max(1000),
  recommendation: z.string().max(1000).optional(),
});
export type AnalysisFinding = z.infer<typeof analysisFindingSchema>;

export const serverAnalysisSchema = z.object({
  score: z.number().min(0).max(100),
  summary: z.string().max(2000),
  findings: z.array(analysisFindingSchema).max(40),
});
export type ServerAnalysis = z.infer<typeof serverAnalysisSchema>;

export const improveTurnSchema = architectTurnSchema.extend({ analysis: serverAnalysisSchema });

import { z } from "zod";
import { messageTemplateSchema } from "../guild-config.js";

/**
 * Automation workflow definition: a trigger followed by an ordered list of
 * steps. Steps are conditions (stop the run when false), actions, or delays.
 * The dashboard's visual builder edits this structure directly and the AI
 * generator produces it from natural language.
 */

export const triggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("member_join") }),
  z.object({ type: z.literal("member_leave") }),
  z.object({ type: z.literal("message"), match: z.enum(["any", "contains", "starts_with", "exact", "regex"]).default("any"), pattern: z.string().default(""), channelIds: z.array(z.string()).default([]), ignoreBots: z.boolean().default(true) }),
  z.object({ type: z.literal("reaction_add"), emoji: z.string().default(""), messageId: z.string().optional(), channelIds: z.array(z.string()).default([]) }),
  z.object({ type: z.literal("role_added"), roleId: z.string() }),
  z.object({ type: z.literal("role_removed"), roleId: z.string() }),
  z.object({ type: z.literal("voice_join"), channelIds: z.array(z.string()).default([]) }),
  z.object({ type: z.literal("voice_leave"), channelIds: z.array(z.string()).default([]) }),
  z.object({ type: z.literal("schedule"), cron: z.string().min(9), timezone: z.string().default("UTC") }),
  z.object({ type: z.literal("level_up"), level: z.number().int().optional() }),
  z.object({ type: z.literal("ticket_opened") }),
  z.object({ type: z.literal("ticket_closed") }),
  z.object({ type: z.literal("boost") }),
]);
export type AutomationTrigger = z.infer<typeof triggerSchema>;

export const conditionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("has_role"), roleId: z.string() }),
  z.object({ type: z.literal("missing_role"), roleId: z.string() }),
  z.object({ type: z.literal("in_channel"), channelIds: z.array(z.string()) }),
  z.object({ type: z.literal("account_age_days"), op: z.enum(["gt", "lt"]), days: z.number() }),
  z.object({ type: z.literal("message_matches"), regex: z.string() }),
  z.object({ type: z.literal("chance"), percent: z.number().min(0).max(100) }),
  z.object({ type: z.literal("is_bot"), value: z.boolean() }),
  z.object({ type: z.literal("member_count"), op: z.enum(["gt", "lt"]), value: z.number() }),
  z.object({ type: z.literal("level_at_least"), level: z.number().int() }),
]);
export type AutomationCondition = z.infer<typeof conditionSchema>;

export const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("send_message"), channelId: z.string().optional().describe("omit = trigger channel"), message: messageTemplateSchema }),
  z.object({ type: z.literal("send_dm"), message: messageTemplateSchema }),
  z.object({ type: z.literal("reply"), message: messageTemplateSchema }),
  z.object({ type: z.literal("add_role"), roleId: z.string() }),
  z.object({ type: z.literal("remove_role"), roleId: z.string() }),
  z.object({ type: z.literal("react"), emoji: z.string() }),
  z.object({ type: z.literal("delete_message") }),
  z.object({ type: z.literal("timeout"), minutes: z.number().int().min(1).max(40320), reason: z.string().default("Automation") }),
  z.object({ type: z.literal("set_nickname"), nickname: z.string().max(32) }),
  z.object({ type: z.literal("create_thread"), name: z.string().max(100) }),
  z.object({ type: z.literal("log"), message: z.string() }),
  z.object({ type: z.literal("set_channel_name"), channelId: z.string(), name: z.string().max(100) }),
  z.object({ type: z.literal("add_xp"), amount: z.number().int() }),
  z.object({ type: z.literal("add_currency"), amount: z.number().int() }),
]);
export type AutomationAction = z.infer<typeof actionSchema>;

export const stepSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("condition"), id: z.string().default(() => Math.random().toString(36).slice(2, 10)), condition: conditionSchema, negate: z.boolean().default(false) }),
  z.object({ kind: z.literal("action"), id: z.string().default(() => Math.random().toString(36).slice(2, 10)), action: actionSchema }),
  z.object({ kind: z.literal("delay"), id: z.string().default(() => Math.random().toString(36).slice(2, 10)), seconds: z.number().int().min(1).max(86_400) }),
]);
export type AutomationStep = z.infer<typeof stepSchema>;

export const automationSchema = z.object({
  trigger: triggerSchema,
  steps: z.array(stepSchema).max(30),
  cooldownSeconds: z.number().int().min(0).max(86_400).default(0),
});
export type AutomationDefinition = z.infer<typeof automationSchema>;

export const generatedAutomationSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).default(""),
  definition: automationSchema,
});

export const TRIGGER_LABELS: Record<AutomationTrigger["type"], string> = {
  member_join: "Member joins", member_leave: "Member leaves", message: "Message sent", reaction_add: "Reaction added",
  role_added: "Role added", role_removed: "Role removed", voice_join: "Joins voice", voice_leave: "Leaves voice",
  schedule: "On a schedule", level_up: "Levels up", ticket_opened: "Ticket opened", ticket_closed: "Ticket closed", boost: "Server boosted",
};

export const ACTION_LABELS: Record<AutomationAction["type"], string> = {
  send_message: "Send message", send_dm: "Send DM", reply: "Reply", add_role: "Add role", remove_role: "Remove role",
  react: "React", delete_message: "Delete message", timeout: "Timeout member", set_nickname: "Set nickname",
  create_thread: "Create thread", log: "Write to log", set_channel_name: "Rename channel", add_xp: "Give XP", add_currency: "Give currency",
};

export const CONDITION_LABELS: Record<AutomationCondition["type"], string> = {
  has_role: "Has role", missing_role: "Missing role", in_channel: "In channel", account_age_days: "Account age",
  message_matches: "Message matches", chance: "Random chance", is_bot: "Is bot", member_count: "Member count", level_at_least: "Level at least",
};

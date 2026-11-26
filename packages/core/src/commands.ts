import { z } from "zod";
import { messageTemplateSchema } from "./guild-config.js";
import { actionSchema, conditionSchema } from "./automation/schema.js";

/** Custom command definition (slash or message-trigger). */
export const customCommandSchema = z.object({
  type: z.enum(["slash", "trigger"]).default("slash"),
  description: z.string().min(1).max(100).default("Custom command"),
  options: z.array(z.object({
    name: z.string().regex(/^[a-z0-9_-]{1,32}$/),
    description: z.string().min(1).max(100),
    type: z.enum(["string", "integer", "number", "boolean", "user", "channel", "role"]).default("string"),
    required: z.boolean().default(false),
    choices: z.array(z.string().max(100)).max(25).optional(),
  })).max(10).default([]),
  trigger: z.object({
    match: z.enum(["exact", "contains", "starts_with", "regex"]).default("exact"),
    pattern: z.string().default(""),
    caseSensitive: z.boolean().default(false),
    channelIds: z.array(z.string()).default([]),
  }).prefault({}),
  response: messageTemplateSchema.default({ content: "Hello {user}!" }),
  ephemeral: z.boolean().default(false),
  /** Conditional responses: first matching branch overrides the default response. */
  branches: z.array(z.object({
    conditions: z.array(conditionSchema).min(1),
    response: messageTemplateSchema,
  })).max(10).default([]),
  actions: z.array(actionSchema).max(10).default([]),
  allowedRoleIds: z.array(z.string()).default([]),
  deniedRoleIds: z.array(z.string()).default([]),
  allowedChannelIds: z.array(z.string()).default([]),
  cooldownSeconds: z.number().int().min(0).max(86_400).default(0),
  deleteTrigger: z.boolean().default(false),
});
export type CustomCommandDefinition = z.infer<typeof customCommandSchema>;

export const commandNameSchema = z.string().regex(/^[a-z0-9_-]{1,32}$/, "Lowercase letters, numbers, - and _ only (max 32)");

export const generatedCommandSchema = z.object({ name: commandNameSchema, definition: customCommandSchema }).refine(
  (c) => !!(c.definition.response.content?.trim() || c.definition.response.embed?.description?.trim() || c.definition.response.embed?.title?.trim()),
  { message: "definition.response must include non-empty content (e.g. {\"content\": \"...\"})", path: ["definition", "response"] },
);

export const commandExportSchema = z.object({
  moth: z.literal("commands"),
  version: z.literal(1),
  commands: z.array(z.object({ name: commandNameSchema, enabled: z.boolean().default(true), definition: customCommandSchema })),
});

/** Returns true when a message matches a trigger command. */
export function matchesTrigger(def: CustomCommandDefinition, content: string): boolean {
  const t = def.trigger;
  if (!t.pattern) return false;
  const text = t.caseSensitive ? content : content.toLowerCase();
  const pat = t.caseSensitive ? t.pattern : t.pattern.toLowerCase();
  switch (t.match) {
    case "exact": return text.trim() === pat.trim();
    case "contains": return text.includes(pat);
    case "starts_with": return text.startsWith(pat);
    case "regex":
      try { return new RegExp(t.pattern, t.caseSensitive ? "" : "i").test(content); } catch { return false; }
  }
}

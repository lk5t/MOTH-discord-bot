import { z } from "zod";
import type { AIClient, CompletionResult } from "./provider.js";
import { AUTOMATION_GENERATOR_PROMPT, COMMAND_GENERATOR_PROMPT } from "../architect/prompts.js";
import { customCommandSchema, generatedCommandSchema, type CustomCommandDefinition } from "../commands.js";
import { automationSchema, generatedAutomationSchema, type AutomationDefinition } from "../automation/schema.js";

/**
 * AI generation of custom commands and automations.
 *
 * Large hosted models fill MOTH's full schemas directly. Small local models
 * (the free, no-key default) are asked for a tiny flat shape instead, which
 * MOTH expands into a full definition. That keeps generation reliable on a
 * 1–3B model running on a CPU.
 */

const KNOWN = /^(user|target|server|channel)(\.[a-z]+)?$|^args\.[\w-]+$|^(random|randnum):|^(date|time|timestamp|level|xp|balance)$/;
/** Keeps only real MOTH placeholders; "#{general}" → "#general", "{server}play.x.com" → "play.x.com". */
export function sanitizePlaceholders(text: string): string {
  return text
    .replace(/\{(server|user)\}(?=[a-z0-9])/gi, "")
    .replace(/\{([^{}\n]{1,40})\}/g, (m, k: string) => (KNOWN.test(k.trim()) ? m : k.trim()));
}

const slug = (s: string) => s.toLowerCase().replace(/^\//, "").replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "command";

const simpleCommandSchema = z.object({
  name: z.string().min(1).max(60),
  description: z.string().max(200).default("Custom command"),
  reply: z.string().min(1).max(1900),
  /** Optional list of alternative replies, one is picked at random. */
  choices: z.array(z.string().min(1).max(500)).max(20).optional(),
  trigger_word: z.string().max(100).optional(),
});

const SIMPLE_COMMAND_PROMPT = `You create Discord bot commands. Reply with ONLY a JSON object:
{"name": "short-lowercase-name", "description": "what it does", "reply": "the message the bot sends", "choices": ["optional", "random", "answers"], "trigger_word": "optional word that triggers it instead of a slash command"}
In "reply" you may use {user} for the user and {server} for the server name. If the bot should pick randomly between answers, list them in "choices".
Example: {"name": "coinflip", "description": "Flip a coin", "reply": "🪙 {user} flipped a coin...", "choices": ["Heads!", "Tails!"]}`;

export async function generateCommand(ai: AIClient, request: string, serverContext: string): Promise<{ data: { name: string; definition: CustomCommandDefinition }; usage: CompletionResult }> {
  if (ai.config.kind !== "ollama") {
    return ai.completeJson([{ role: "system", content: COMMAND_GENERATOR_PROMPT }, { role: "user", content: `${serverContext}\n\nRequest: ${request}` }], generatedCommandSchema, { maxTokens: 1500 });
  }
  const { data: s, usage } = await ai.completeJson([{ role: "system", content: SIMPLE_COMMAND_PROMPT }, { role: "user", content: request }], simpleCommandSchema, { maxTokens: 400, temperature: 0.3 });
  // Only randomise when the request actually asks for it (small models add choices everywhere).
  const wantsRandom = /\b(random|randomly|pick|flip|roll|8.?ball|choose|either|chance|dice|coin)\b/i.test(request);
  const choices = wantsRandom ? [...new Set((s.choices ?? []).map((c) => c.replace(/[|{}]/g, "").trim()).filter(Boolean))] : [];
  const reply = sanitizePlaceholders(s.reply).replace(/\{(choices?|options?|answers?|random)\}/gi, "").replace(/[ \t]+$/gm, "").trim();
  const content = choices.length > 1 ? `${reply}\n{random:${choices.join("|")}}`.trim() : reply || choices[0] || "Done!";
  // "when someone says X" → message trigger, even if the model forgot.
  const said = request.match(/\b(?:says?|types?|writes?|sends?|mentions?)\s+["'“]?([^"'”.,!?]{1,40})/i)?.[1]?.trim();
  const trigger = s.trigger_word?.trim() || (!/\/\w/.test(request) ? said : undefined);
  const definition = customCommandSchema.parse({
    type: trigger ? "trigger" : "slash",
    description: s.description.slice(0, 100) || "Custom command",
    trigger: trigger ? { match: "contains", pattern: trigger } : undefined,
    response: { content: content.slice(0, 2000) },
  });
  return { data: { name: slug(s.name), definition }, usage };
}

const simpleAutomationSchema = z.object({
  name: z.string().min(1).max(100),
  when: z.enum(["member_join", "member_leave", "message", "schedule"]),
  keyword: z.string().max(100).optional(),
  cron: z.string().max(60).optional(),
  action: z.enum(["send_message", "send_dm", "reply", "add_role"]),
  channel: z.string().max(100).optional(),
  role: z.string().max(100).optional(),
  message: z.string().max(1900).optional(),
});

const SIMPLE_AUTOMATION_PROMPT = `You create Discord server automations. Reply with ONLY a JSON object:
{"name": "short name", "when": "member_join" | "member_leave" | "message" | "schedule",
 "keyword": "for when=message: word to look for", "cron": "for when=schedule: cron like 0 18 * * 5",
 "action": "send_message" | "send_dm" | "reply" | "add_role",
 "channel": "channel name for send_message", "role": "role name for add_role", "message": "text to send, may use {user} and {server}"}
Example: {"name": "Welcome DM", "when": "member_join", "action": "send_dm", "message": "Welcome to {server}, {user}!"}`;

/**
 * @param resolve maps a channel/role name from the model to a real ID (or null).
 */
export async function generateAutomation(
  ai: AIClient, request: string, serverContext: string,
  resolve: { channel: (name: string) => string | null; role: (name: string) => string | null },
): Promise<{ data: { name: string; description: string; definition: AutomationDefinition }; usage: CompletionResult }> {
  if (ai.config.kind !== "ollama") {
    return ai.completeJson([{ role: "system", content: AUTOMATION_GENERATOR_PROMPT }, { role: "user", content: `${serverContext}\n\nRequest: ${request}` }], generatedAutomationSchema, { maxTokens: 1500 });
  }
  const { data: raw, usage } = await ai.completeJson([{ role: "system", content: SIMPLE_AUTOMATION_PROMPT }, { role: "user", content: `${serverContext}\n\nRequest: ${request}` }], simpleAutomationSchema, { maxTokens: 400, temperature: 0.2 });
  // Correct obvious trigger mistakes deterministically.
  const s = { ...raw };
  const cron = cronFromText(request);
  if (cron) { s.when = "schedule"; s.cron = cron; }
  else if (/\b(joins?|new members?|newcomers?)\b/i.test(request)) s.when = "member_join";
  else if (/\b(leaves?|left)\b/i.test(request)) s.when = "member_leave";
  if (s.when === "schedule" && s.action === "reply") s.action = "send_message";
  const trigger = s.when === "message" ? { type: "message", match: s.keyword ? "contains" : "any", pattern: s.keyword ?? "" }
    : s.when === "schedule" ? { type: "schedule", cron: s.cron && s.cron.trim().split(/\s+/).length === 5 ? s.cron.trim() : "0 12 * * *", timezone: "UTC" }
    : { type: s.when };
  const message = { content: sanitizePlaceholders(s.message || "Hello {user}!").slice(0, 2000) };
  let action: Record<string, unknown>;
  if (s.action === "add_role") {
    const roleId = s.role ? resolve.role(s.role) : null;
    action = roleId ? { type: "add_role", roleId } : { type: "send_dm", message };
  } else if (s.action === "send_message") {
    const channelId = s.channel ? resolve.channel(s.channel) : null;
    action = channelId ? { type: "send_message", channelId, message } : s.when === "message" ? { type: "reply", message } : { type: "send_dm", message };
  } else if (s.action === "reply" && s.when !== "message") {
    action = { type: "send_dm", message };
  } else action = { type: s.action, message };
  const definition = automationSchema.parse({ trigger, steps: [{ kind: "action", action }], cooldownSeconds: s.when === "message" ? 30 : 0 });
  return { data: { name: s.name, description: `Generated from: ${request.slice(0, 200)}`, definition }, usage };
}

const DAYS: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/** Parses schedules like "every friday at 6pm", "daily at 09:30", "every monday and thursday at 8 pm". */
export function cronFromText(text: string): string | null {
  const t = text.toLowerCase();
  const days = [...t.matchAll(/\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/g)].map((m) => DAYS[m[1]]);
  const daily = /\b(every ?day|daily|each day|every morning|every evening|every night)\b/.test(t);
  const weekdays = /\bweekdays?\b/.test(t), weekends = /\bweekends?\b/.test(t);
  const hourly = /\b(every hour|hourly)\b/.test(t);
  if (!days.length && !daily && !weekdays && !weekends && !hourly && !/\bevery (week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(t)) return null;
  if (hourly) return "0 * * * *";
  let hour = 12, minute = 0;
  const tm = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/) ?? t.match(/\b(\d{1,2}):(\d{2})\b/);
  if (tm) {
    hour = Number(tm[1]) % 24; minute = Number(tm[2] ?? 0) % 60;
    if (tm[3] === "pm" && hour < 12) hour += 12;
    if (tm[3] === "am" && hour === 12) hour = 0;
  } else if (/\bmorning\b/.test(t)) hour = 9; else if (/\bevening\b/.test(t)) hour = 18; else if (/\bnight\b/.test(t)) hour = 21;
  const dow = weekdays ? "1-5" : weekends ? "0,6" : days.length ? [...new Set(days)].sort().join(",") : "*";
  return `${minute} ${hour} * * ${dow}`;
}

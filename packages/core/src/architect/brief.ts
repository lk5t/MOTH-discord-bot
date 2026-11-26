import { z } from "zod";
import type { AIClient, CompletionResult } from "../ai/provider.js";
import { composeBlueprint, inferIntent, type DesignIntent, type Feature, type ServerKind } from "./templates.js";
import { blueprintSchema, type Blueprint, type BlueprintInput } from "./blueprint.js";
import type { GuildSnapshot } from "./snapshot.js";
import { normaliseName } from "../util.js";

/**
 * "Design briefs" let small local AI models drive the Architect.
 *
 * Instead of writing a full blueprint (thousands of tokens, slow and error-prone
 * on a CPU), the model answers a short structured brief describing what the
 * user wants. MOTH's deterministic designer turns that into the full layout,
 * so you get the model's understanding with the designer's reliability.
 */

const KINDS = ["gaming", "community", "business", "education", "creator", "developer", "roleplay", "esports"] as const;
const FEATURES = ["tickets", "staff-applications", "announcements", "verification", "leveling", "economy", "giveaways", "events", "voice", "media", "suggestions", "role-menus", "ai", "partnerships", "faq", "polls", "music", "lfg", "showcase"] as const;
const CHANNEL_TYPES = ["text", "voice", "forum", "announcement"] as const;

/** "gameJams" / "Game Jams" → "game-jams"; voice → "Game Jams". */
const splitWords = (n: string) => n.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
const textName = (n: string) => splitWords(n).toLowerCase().replace(/\s+/g, "-");
const voiceName = (n: string) => splitWords(n).replace(/\b\w/g, (c) => c.toUpperCase());
const styledChannel = (c: { name: string; type: "text" | "voice" | "forum" | "announcement" }, emoji: boolean) =>
  c.type === "voice" ? `🔊 ${voiceName(c.name)}` : `${emoji ? `${{ forum: "🗂️", announcement: "📣", text: "💬" }[c.type]}┃` : ""}${textName(c.name)}`;

const lenientEnumArray = <T extends readonly [string, ...string[]]>(values: T) =>
  z.array(z.string()).default([]).transform((a) => a.map((x) => x.toLowerCase().trim().replace(/[\s_]+/g, "-")).filter((x): x is T[number] => (values as readonly string[]).includes(x)));
const channelType = z.string().optional().transform((t) => ((CHANNEL_TYPES as readonly string[]).includes(t?.toLowerCase() ?? "") ? (t!.toLowerCase() as (typeof CHANNEL_TYPES)[number]) : "text"));
const section = z.object({
  name: z.string().min(1).max(60),
  private: z.boolean().optional(),
  channels: z.array(z.union([z.string().min(1).max(60).transform((name) => ({ name, type: "text" as const })), z.object({ name: z.string().min(1).max(60), type: channelType })])).max(15).default([]),
});

export const designBriefSchema = z.object({
  server_name: z.string().max(60).optional(),
  kind: z.string().transform((k) => ((KINDS as readonly string[]).includes(k.toLowerCase()) ? (k.toLowerCase() as ServerKind) : undefined)).optional(),
  topics: z.array(z.string().max(40)).max(8).default([]),
  tone: z.string().optional().transform((t) => (t && /prof|formal|business/i.test(t) ? "professional" : t && /play|fun|casual/i.test(t) ? "playful" : t ? "friendly" : undefined)),
  emoji: z.boolean().optional(),
  features: lenientEnumArray(FEATURES),
  extra_sections: z.array(section).max(8).default([]),
  reply: z.string().max(1500).optional(),
});
export type DesignBrief = z.infer<typeof designBriefSchema>;

const DESIGN_BRIEF_PROMPT = `You plan Discord servers. Read the request and reply with ONLY a JSON object:
{"server_name": "name if given", "kind": one of ${KINDS.join("|")},
 "topics": ["games or subjects mentioned, e.g. Minecraft"], "tone": "professional|friendly|playful", "emoji": true,
 "features": [any of: ${FEATURES.join(", ")}],
 "extra_sections": [{"name": "section the user asked for that is not a standard feature", "private": false, "channels": [{"name": "channel-name", "type": "text|voice|forum|announcement"}]}],
 "reply": "one or two friendly sentences describing your plan"}
Only include features and sections the request asks for or clearly implies.`;

/** Asks the model for a design brief and builds a full blueprint from it. */
export async function blueprintFromBrief(ai: AIClient, request: string, context = "", signal?: AbortSignal): Promise<{ blueprint: Blueprint; reply: string; usage: CompletionResult }> {
  const { data: b, usage } = await ai.completeJson([{ role: "system", content: DESIGN_BRIEF_PROMPT }, { role: "user", content: `${context ? `${context}\n\n` : ""}Request: ${request}` }], designBriefSchema, { maxTokens: 450, temperature: 0.2, signal, attempts: 1 });
  const base = inferIntent(request);
  const intent: DesignIntent = {
    ...base,
    kind: b.kind ?? base.kind,
    name: b.server_name?.trim() || base.name,
    topics: [...new Set([...base.topics, ...b.topics.map((t) => t.trim()).filter(Boolean)])].slice(0, 6),
    tone: b.tone ?? base.tone,
    emoji: b.emoji ?? base.emoji,
    features: new Set<Feature>([...base.features, ...b.features]),
  };
  const bp = composeBlueprint(intent);
  const style = (name: string) => (intent.emoji ? `━━ ✦ ${name.toUpperCase()} ✦ ━━` : name);
  const extra = b.extra_sections
    .filter((s) => !bp.categories.some((c) => normaliseName(c.name).includes(normaliseName(s.name))))
    .map((s) => ({ name: style(splitWords(s.name)), private: s.private, visibleTo: s.private ? ["moderator", "admin"] : undefined, channels: s.channels.map((c) => ({ name: styledChannel(c, intent.emoji), type: c.type })) }));
  // Insert custom sections before the support/staff areas.
  const at = bp.categories.findIndex((c) => ["cat_voice", "cat_support", "cat_tickets", "cat_staff"].includes(c.key ?? ""));
  const categories = [...bp.categories];
  categories.splice(at === -1 ? categories.length : at, 0, ...(extra as typeof categories));
  const blueprint = blueprintSchema.parse({ ...bp, categories });
  const counts = `${blueprint.roles.length} roles, ${blueprint.categories.length} categories and ${blueprint.categories.reduce((n, c) => n + c.channels.length, 0)} channels`;
  const reply = `${b.reply?.trim() || `I've designed **${blueprint.name}**.`}\n\n• ${counts}.\n• Features: ${[...intent.features].filter((f) => !["faq", "announcements"].includes(f)).join(", ") || "core essentials"}.\n• Welcome messages, auto-moderation, anti-raid protection, logs and appeals are configured.\n\nReview the preview, tell me what to change, or approve it to build.`;
  return { blueprint, reply, usage };
}

export const editBriefSchema = z.object({
  add_sections: z.array(section).max(6).default([]),
  add_channels: z.array(z.object({ name: z.string().min(1).max(60), type: channelType, section: z.string().max(60).optional() })).max(15).default([]),
  rename: z.array(z.object({ from: z.string().min(1).max(100), to: z.string().min(1).max(100) })).max(15).default([]),
  remove_channels: z.array(z.string().max(100)).max(30).default([]),
  remove_sections: z.array(z.string().max(100)).max(15).default([]),
  add_roles: z.array(z.object({ name: z.string().min(1).max(60), color: z.string().regex(/^#?[0-9a-fA-F]{6}$/).optional(), type: z.string().optional() })).max(10).default([]),
  remove_roles: z.array(z.string().max(100)).max(15).default([]),
  remove_bots: z.array(z.string().max(100)).max(15).default([]),
  features: z.array(z.string()).default([]),
  reply: z.string().max(1500).optional(),
});
export type EditBrief = z.infer<typeof editBriefSchema>;

const EDIT_BRIEF_PROMPT = `You edit a Discord server. Using the CURRENT SERVER below, reply with ONLY a JSON object describing the requested change:
{"add_sections": [{"name": "Section", "private": false, "channels": [{"name": "channel-name", "type": "text|voice|forum|announcement"}]}],
 "add_channels": [{"name": "channel-name", "type": "text", "section": "existing section name"}],
 "rename": [{"from": "existing name", "to": "new name"}],
 "remove_channels": ["existing channel name"], "remove_sections": ["existing category name"],
 "add_roles": [{"name": "Role", "color": "#RRGGBB", "type": "staff|member|cosmetic"}], "remove_roles": ["existing role"],
 "remove_bots": ["bot name"],
 "features": [any of: tickets, verification, welcome, security, staff-hierarchy, cleanup],
 "reply": "one or two sentences describing the change"}
Use exact names from the current server for anything existing. Leave lists empty when not requested. Never remove things the user did not ask to remove.`;

/** Asks the model for a structured edit and converts it to a partial blueprint. Feature words are returned for the heuristic editor. */
export async function blueprintFromEditBrief(ai: AIClient, request: string, serverDescription: string, snap: GuildSnapshot, signal?: AbortSignal): Promise<{ blueprint: BlueprintInput; featurePhrase: string; reply: string; usage: CompletionResult; empty: boolean }> {
  const { data: b, usage } = await ai.completeJson([{ role: "system", content: EDIT_BRIEF_PROMPT }, { role: "user", content: `CURRENT SERVER:\n${serverDescription}\n\nRequest: ${request}` }], editBriefSchema, { maxTokens: 400, temperature: 0.1, signal, attempts: 1 });
  const existsCh = (n: string) => snap.channels.some((c) => normaliseName(c.name) === normaliseName(n));
  const existsRole = (n: string) => snap.roles.some((r) => normaliseName(r.name) === normaliseName(n));
  const slugify = textName;
  const bp: BlueprintInput = { roles: [], channels: [], categories: [], features: {}, removals: { channels: [], categories: [], roles: [], bots: [] } };
  for (const s of b.add_sections) bp.categories!.push({ name: splitWords(s.name), private: s.private, channels: s.channels.map((c) => ({ name: c.type === "voice" ? voiceName(c.name) : slugify(c.name), type: c.type })) });
  for (const c of b.add_channels) {
    const ch = { name: c.type === "voice" ? voiceName(c.name) : slugify(c.name), type: c.type };
    const cat = c.section && snap.channels.find((x) => x.type === "category" && normaliseName(x.name).includes(normaliseName(c.section!)));
    if (cat) bp.categories!.push({ name: cat.name, channels: [ch] }); else bp.channels!.push(ch);
  }
  // Removals the user asked for by name are detected from their words — small models sometimes
  // "rename to x-deleted" instead of removing.
  const asked = request.toLowerCase();
  const wantsRemoval = (name: string) => {
    const n = name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b(delete|remove|get rid of|drop|kick)\\b[^.;]*?#?${n}\\b`).test(asked);
  };
  const removeCh = snap.channels.filter((c) => c.type !== "category" && wantsRemoval(c.name)).map((c) => c.name);
  const removeCat = snap.channels.filter((c) => c.type === "category" && wantsRemoval(c.name)).map((c) => c.name);
  const removeRole = snap.roles.filter((r) => !r.everyone && !r.managed && wantsRemoval(r.name)).map((r) => r.name);
  const removeBot = (snap.bots ?? []).filter((x) => wantsRemoval(x.name)).map((x) => x.name);
  const removing = new Set([...removeCh, ...removeCat, ...removeRole].map(normaliseName));
  b.rename = b.rename.filter((r) => !removing.has(normaliseName(r.from)) && !/delet|remov|archiv/i.test(r.to));
  for (const r of b.rename) {
    const cat = snap.channels.find((x) => x.type === "category" && normaliseName(x.name) === normaliseName(r.from));
    if (cat) bp.categories!.push({ name: r.to, renameFrom: cat.name, channels: [] });
    else if (existsCh(r.from)) bp.channels!.push({ name: slugify(r.to), renameFrom: r.from });
    else if (existsRole(r.from)) bp.roles!.push({ key: `role_${normaliseName(r.to) || "renamed"}`, name: r.to, renameFrom: r.from });
  }
  // Only remove things that exist and were asked for — the model must not invent removals.
  const askedRemoval = /\b(remove|delete|clean|get rid|drop|kick|ban|purge|clear)\b/.test(asked);
  const uniq = (a: string[]) => [...new Map(a.map((x) => [normaliseName(x), x])).values()];
  if (askedRemoval) {
    bp.removals!.channels = uniq([...removeCh, ...b.remove_channels.filter(existsCh)]);
    bp.removals!.categories = uniq([...removeCat, ...b.remove_sections.filter((n) => snap.channels.some((c) => c.type === "category" && normaliseName(c.name) === normaliseName(n)))]);
    bp.removals!.roles = uniq([...removeRole, ...b.remove_roles.filter(existsRole)]);
    bp.removals!.bots = uniq([...removeBot, ...b.remove_bots.filter((n) => snap.bots?.some((x) => normaliseName(x.name) === normaliseName(n)))]);
  }
  const presets: Record<string, "moderator" | "member" | "cosmetic"> = { staff: "moderator", member: "member", cosmetic: "cosmetic" };
  for (const r of b.add_roles) if (!existsRole(r.name)) bp.roles!.push({ key: `role_${normaliseName(r.name) || "new"}`, name: r.name, color: r.color, hoist: r.type === "staff", preset: presets[r.type?.toLowerCase() ?? ""] ?? "cosmetic" });
  const phrases: Record<string, string> = { tickets: "set up a professional ticket system", verification: "improve security", welcome: "redesign the welcome experience", security: "improve server security", "staff-hierarchy": "improve the staff hierarchy", cleanup: "clean up unnecessary channels" };
  const featurePhrase = b.features.map((f) => phrases[f.toLowerCase().trim()]).filter(Boolean).join(", ");
  const empty = !bp.categories!.length && !bp.channels!.length && !bp.roles!.length && !Object.values(bp.removals!).some((l) => (l as string[]).length);
  return { blueprint: bp, featurePhrase, reply: b.reply?.trim() ?? "", usage, empty: empty && !featurePhrase };
}

/** Very compact server outline for small models: far fewer tokens than describeSnapshot. */
export function compactOutline(s: GuildSnapshot): string {
  const cats = s.channels.filter((c) => c.type === "category").sort((a, b) => a.position - b.position);
  const kids = (id: string | null) => s.channels.filter((c) => c.type !== "category" && c.parentId === id).sort((a, b) => a.position - b.position).map((c) => c.name).slice(0, 15).join(", ");
  const lines = [`Server "${s.name}".`];
  const top = kids(null); if (top) lines.push(`No category: ${top}`);
  for (const c of cats.slice(0, 20)) lines.push(`${c.name}: ${kids(c.id) || "(empty)"}`);
  lines.push(`Roles: ${s.roles.filter((r) => !r.everyone && !r.managed).sort((a, b) => b.position - a.position).map((r) => r.name).slice(0, 25).join(", ")}`);
  if (s.bots?.length) lines.push(`Bots: ${s.bots.map((b) => b.name).join(", ")}`);
  return lines.join("\n");
}

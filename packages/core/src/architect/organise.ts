import type { Blueprint, BlueprintChannel } from "./blueprint.js";

/**
 * Server layout conventions, applied to every Architect plan so servers come
 * out organised the same way no matter which designer (AI or heuristic)
 * produced the blueprint:
 *
 *   Start Here / Information → Announcements → community topics → Support →
 *   Voice → Staff → Archive
 *
 * and inside a category: welcome/verify → rules → info/FAQ → roles →
 * announcements → everything else → voice channels last.
 */

const plain = (s: string) => s.normalize("NFKD").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const has = (s: string, re: RegExp) => re.test(` ${plain(s)} `);

const START = /\b(start|starting|start here|welcome|getting started|get started|info|information|important|rules|read ?me|onboarding|verify|verification|server info|about|guide)\b/;
const ANNOUNCE = /\b(announce\w*|news|updates?|changelog|notices?)\b/;
const SUPPORT = /\b(support|tickets?|help ?desk|helpdesk|contact|reports?|appeals?)\b/;
const VOICE = /\b(voice|vc|vcs|lounges?|calls?|stage|music rooms?|hangout rooms?)\b/;
const STAFF = /\b(staff|mods?|moderation|moderators?|admins?|administration|management|team only|logs?|audit|private|internal|backstage)\b/;
const ARCHIVE = /\b(archive[sd]?|old|legacy|deprecated|closed)\b/;

/** Lower comes first. */
export function categoryRank(name: string, channels: { name: string; type?: string }[] = []): number {
  if (has(name, ARCHIVE)) return 9;
  if (has(name, STAFF)) return 8;
  if (has(name, START)) return 0;
  if (has(name, ANNOUNCE)) return 1;
  if (has(name, SUPPORT)) return 4;
  const allVoice = channels.length > 0 && channels.every((c) => c.type === "voice" || c.type === "stage");
  if (has(name, VOICE) || allVoice) return 5;
  // An unnamed-looking category whose channels are all onboarding channels is a start category too.
  if (channels.length && channels.every((c) => has(c.name, START) || has(c.name, ANNOUNCE))) return 0;
  return 2;
}

export function channelRank(name: string, type?: string): number {
  const voice = type === "voice" || type === "stage" ? 10 : 0;
  if (has(name, /\b(welcome|verify|verification|start here|start|introduction|read ?me)\b/)) return voice + 0;
  if (has(name, /\b(rules?|guidelines|tos|code of conduct)\b/)) return voice + 1;
  if (has(name, /\b(info|information|about|faq|guide|how to|server info|links?)\b/)) return voice + 2;
  if (has(name, /\b(roles?|self roles?|reaction roles?|pick roles?|get roles?)\b/)) return voice + 3;
  if (has(name, ANNOUNCE)) return voice + 4;
  if (has(name, /\b(logs?|audit|transcripts?)\b/)) return voice + 7;
  return voice + 5;
}

const stable = <T>(items: T[], rank: (t: T) => number): T[] => items.map((t, i) => ({ t, i, r: rank(t) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.t);

export function organiseChannels<T extends Pick<BlueprintChannel, "name" | "type">>(channels: T[]): T[] {
  return stable(channels, (c) => channelRank(c.name, c.type));
}

/** Returns a copy of the blueprint with categories and channels in conventional order. */
export function organiseBlueprint(bp: Blueprint): Blueprint {
  return {
    ...bp,
    channels: organiseChannels(bp.channels),
    categories: stable(bp.categories, (c) => categoryRank(c.name, c.channels)).map((c) => ({ ...c, channels: organiseChannels(c.channels) })),
  };
}

/** Snowflake order (numeric, not string). */
export const idCmp = (a: string, b: string) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);

export type LayoutChannel = { id: string; kind: "category" | "text" | "voice"; parentId: string | null; position: number };
export type LayoutPosition = { channel: string; position: number; parent?: string | null };

/**
 * Computes a unique position for EVERY channel so Discord shows exactly the
 * requested order (Discord breaks position ties by ID, so partial updates
 * scramble). Categories follow `order`, then untouched ones; inside each
 * parent, listed channels come first, then the rest in their current order;
 * text-type channels before voice (as Discord displays them).
 */
export function layoutPositions(channels: LayoutChannel[], order: { id: string; parent: string | null }[]): LayoutPosition[] {
  const byId = new Map(channels.map((c) => [c.id, c]));
  const sortPos = (a: LayoutChannel, b: LayoutChannel) => a.position - b.position || idCmp(a.id, b.id);
  const parentOf = new Map(order.filter((o) => byId.has(o.id)).map((o) => [o.id, o.parent]));
  const listedCats = order.map((o) => byId.get(o.id)).filter((c): c is LayoutChannel => !!c && c.kind === "category");
  const catOrder = [...new Set([...listedCats, ...channels.filter((c) => c.kind === "category").sort(sortPos)])];
  const out: LayoutPosition[] = catOrder.map((c, i) => ({ channel: c.id, position: i }));
  for (const parent of [null, ...catOrder.map((c) => c.id)]) {
    const target = (c: LayoutChannel) => (parentOf.has(c.id) ? parentOf.get(c.id)! : c.parentId);
    const children = channels.filter((c) => c.kind !== "category" && target(c) === parent);
    const listed = order.filter((o) => o.parent === parent).map((o) => byId.get(o.id)).filter((c): c is LayoutChannel => !!c && c.kind !== "category");
    const ordered = [...listed, ...children.filter((c) => !listed.includes(c)).sort(sortPos)];
    const final = [...ordered.filter((c) => c.kind === "text"), ...ordered.filter((c) => c.kind === "voice")];
    final.forEach((c, i) => out.push({ channel: c.id, position: i, ...(c.parentId !== parent ? { parent } : {}) }));
  }
  return out;
}

/** How Discord displays a server: categories by position (ties by ID), text above voice inside each. */
export function displayOrder(channels: LayoutChannel[]): string[] {
  const sortPos = (a: LayoutChannel, b: LayoutChannel) => a.position - b.position || idCmp(a.id, b.id);
  const kids = (p: string | null) => [...channels.filter((c) => c.kind === "text" && c.parentId === p).sort(sortPos), ...channels.filter((c) => c.kind === "voice" && c.parentId === p).sort(sortPos)];
  return [...kids(null).map((c) => c.id), ...channels.filter((c) => c.kind === "category").sort(sortPos).flatMap((c) => [c.id, ...kids(c.id).map((k) => k.id)])];
}

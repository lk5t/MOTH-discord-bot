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

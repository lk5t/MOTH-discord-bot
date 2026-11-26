/** Parses human durations like "10m", "1h30m", "2d", "45s", "1w". Returns milliseconds or null. */
export function parseDuration(input: string | null | undefined): number | null {
  if (!input) return null;
  const re = /(\d+(?:\.\d+)?)\s*(w|d|h|m|s|ms)/gi;
  const units: Record<string, number> = { w: 604_800_000, d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000, ms: 1 };
  let total = 0;
  let matched = "";
  for (const m of input.matchAll(re)) {
    total += Number(m[1]) * units[m[2].toLowerCase()];
    matched += m[0];
  }
  if (!matched || matched.replace(/\s/g, "").length !== input.replace(/\s/g, "").length) return null;
  return total > 0 ? Math.round(total) : null;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const parts: string[] = [];
  const units: [string, number][] = [["d", 86_400_000], ["h", 3_600_000], ["m", 60_000], ["s", 1000]];
  let rest = ms;
  for (const [u, size] of units) {
    const n = Math.floor(rest / size);
    if (n > 0) { parts.push(`${n}${u}`); rest -= n * size; }
  }
  return parts.slice(0, 2).join(" ");
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Normalises a Discord channel/role name for fuzzy matching (strips emoji, separators, case). */
export function normaliseName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}️‍]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLowerCase();
}

export function deepMerge<T>(base: T, patch: unknown): T {
  if (Array.isArray(patch) || patch === null || typeof patch !== "object") return (patch === undefined ? base : patch) as T;
  if (base === null || typeof base !== "object" || Array.isArray(base)) return patch as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === undefined) continue;
    out[k] = deepMerge((base as Record<string, unknown>)[k], v);
  }
  return out as T;
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function hexToInt(hex: string | undefined | null): number | undefined {
  if (!hex) return undefined;
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return Number.isFinite(n) ? n : undefined;
}

export function intToHex(n: number | null | undefined): string {
  return `#${(n ?? 0).toString(16).padStart(6, "0")}`;
}

/** Leveling curve: XP needed to go from `level` to `level + 1`. */
export function xpForLevel(level: number): number {
  return 5 * level * level + 50 * level + 100;
}

/** Resolves total XP into { level, current, needed }. */
export function levelFromXp(totalXp: number): { level: number; current: number; needed: number } {
  let level = 0;
  let rest = totalXp;
  while (rest >= xpForLevel(level)) { rest -= xpForLevel(level); level++; }
  return { level, current: rest, needed: xpForLevel(level) };
}

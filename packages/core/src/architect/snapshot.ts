/** A serialisable snapshot of a guild's structure, produced by the bot. */
export interface SnapshotRole {
  id: string; name: string; color: number; hoist: boolean; mentionable: boolean;
  permissions: string; position: number; managed: boolean; everyone?: boolean;
}

export interface SnapshotOverwrite { id: string; type: "role" | "member"; allow: string; deny: string }

export type SnapshotChannelType = "text" | "voice" | "category" | "announcement" | "forum" | "stage" | "other";

export interface SnapshotChannel {
  id: string; name: string; type: SnapshotChannelType; parentId: string | null; position: number;
  topic?: string | null; nsfw?: boolean; rateLimitPerUser?: number; userLimit?: number;
  overwrites: SnapshotOverwrite[];
  /** Optional: messages in the last 30 days (from analytics). */
  recentMessages?: number;
}

export interface GuildSnapshot {
  id: string; name: string; iconUrl?: string | null; ownerId: string; memberCount: number;
  verificationLevel: number; botRoleId?: string | null; botHighestPosition?: number;
  roles: SnapshotRole[]; channels: SnapshotChannel[];
  /** Other bot accounts in the server (MOTH itself excluded). */
  bots?: { id: string; name: string; kickable: boolean }[];
  capturedAt: string;
}

/** Compact, token-efficient text description of a server for AI prompts. */
export function describeSnapshot(s: GuildSnapshot, maxChannels = 250): string {
  const roles = [...s.roles].filter((r) => !r.everyone).sort((a, b) => b.position - a.position);
  const lines: string[] = [`Server "${s.name}" — ${s.memberCount} members, verification level ${s.verificationLevel}.`, "Roles (highest first):"];
  for (const r of roles.slice(0, 80)) {
    const perms = BigInt(r.permissions);
    const flags = [(perms & 8n) ? "ADMIN" : "", r.managed ? "managed" : "", r.hoist ? "hoisted" : ""].filter(Boolean).join(",");
    lines.push(`- ${r.name}${flags ? ` [${flags}]` : ""}`);
  }
  const cats = s.channels.filter((c) => c.type === "category").sort((a, b) => a.position - b.position);
  const byParent = (pid: string | null) => s.channels.filter((c) => c.type !== "category" && c.parentId === pid).sort((a, b) => a.position - b.position);
  const fmt = (c: SnapshotChannel) => {
    const priv = c.overwrites.some((o) => o.id === s.id && (BigInt(o.deny) & 1024n)) ? " (private)" : "";
    const act = c.recentMessages !== undefined ? ` · ${c.recentMessages} msgs/30d` : "";
    return `  - #${c.name} <${c.type}>${priv}${act}${c.topic ? ` — ${c.topic.slice(0, 80)}` : ""}`;
  };
  lines.push("Channels:");
  let count = 0;
  for (const c of byParent(null)) { if (count++ < maxChannels) lines.push(fmt(c)); }
  for (const cat of cats) {
    const priv = cat.overwrites.some((o) => o.id === s.id && (BigInt(o.deny) & 1024n)) ? " (private)" : "";
    lines.push(`- Category "${cat.name}"${priv}`);
    for (const c of byParent(cat.id)) { if (count++ < maxChannels) lines.push(fmt(c)); }
  }
  if (count > maxChannels) lines.push(`  …and ${count - maxChannels} more channels`);
  if (s.bots?.length) lines.push(`Other bots: ${s.bots.map((b) => b.name).join(", ")}`);
  return lines.join("\n");
}

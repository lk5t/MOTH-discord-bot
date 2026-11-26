import type { BlueprintInput } from "./blueprint.js";
import type { GuildSnapshot, SnapshotChannel } from "./snapshot.js";
import { fromBits } from "./permissions.js";
import { intToHex, normaliseName } from "../util.js";

/** Converts a live server snapshot into a reusable blueprint template. */
export function snapshotToBlueprint(s: GuildSnapshot): BlueprintInput {
  const roleName = (id: string) => (id === s.id ? "@everyone" : s.roles.find((r) => r.id === id)?.name);
  const usedKeys = new Set<string>();
  const key = (prefix: string, name: string) => {
    let k = `${prefix}_${normaliseName(name) || "x"}`.slice(0, 50); let i = 2;
    while (usedKeys.has(k)) k = `${k.slice(0, 46)}_${i++}`;
    usedKeys.add(k); return k;
  };
  const roles = s.roles.filter((r) => !r.everyone && !r.managed).sort((a, b) => b.position - a.position).map((r) => ({
    key: key("role", r.name), name: r.name, color: r.color ? intToHex(r.color) : undefined, hoist: r.hoist, mentionable: r.mentionable, permissions: fromBits(r.permissions),
  }));
  const ow = (c: SnapshotChannel) => c.overwrites.filter((o) => o.type === "role" && roleName(o.id)).map((o) => ({ target: roleName(o.id)!, allow: fromBits(o.allow), deny: fromBits(o.deny) }));
  const chan = (c: SnapshotChannel) => ({
    key: key("chan", c.name), name: c.name, type: (["text", "voice", "announcement", "forum", "stage"].includes(c.type) ? c.type : "text") as "text",
    topic: c.topic ?? undefined, slowmode: c.rateLimitPerUser || undefined, nsfw: c.nsfw || undefined, userLimit: c.userLimit || undefined, overwrites: ow(c),
  });
  const children = (pid: string | null) => s.channels.filter((c) => c.type !== "category" && c.type !== "other" && c.parentId === pid).sort((a, b) => a.position - b.position).map(chan);
  return {
    name: s.name, description: `Exported from ${s.name}`,
    roles,
    channels: children(null),
    categories: s.channels.filter((c) => c.type === "category").sort((a, b) => a.position - b.position).map((c) => ({ key: key("cat", c.name), name: c.name, overwrites: ow(c), channels: children(c.id) })),
  };
}

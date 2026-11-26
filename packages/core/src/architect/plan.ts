import { categoryRank, organiseBlueprint } from "./organise.js";
import type { Blueprint, BlueprintCategory, BlueprintChannel, BlueprintRole } from "./blueprint.js";
import { blueprintSchema } from "./blueprint.js";
import type { GuildSnapshot, SnapshotChannel, SnapshotChannelType, SnapshotOverwrite, SnapshotRole } from "./snapshot.js";
import { fromBits, ROLE_PRESETS, toBits, isValidPermission, type PermissionName } from "./permissions.js";
import { hexToInt, normaliseName } from "../util.js";
import type { AutomationDefinition } from "../automation/schema.js";
import type { EmbedData } from "../guild-config.js";

/**
 * The planner turns (current snapshot + blueprint) into an ordered list of
 * concrete operations. It is a pure function — the bot executes the plan.
 *
 * References inside ops are strings:
 *   "role:<key>" / "chan:<key>"  → resolved through plan.refs + created ids
 *   "id:<snowflake>"              → an existing entity
 *   "@everyone"                   → the guild's @everyone role
 */

export type ArchitectMode = "create" | "quick" | "improve" | "redesign";

export interface PlanOptions {
  mode: ArchitectMode;
  /** Delete roles/channels that the blueprint does not mention (Full Redesign / fresh servers). */
  prune?: boolean;
  /** Kick every other bot from the server (Full Redesign). */
  removeBots?: boolean;
  /** Replace permission overwrites instead of merging with existing ones. */
  resetPermissions?: boolean;
  /** Reorder existing channels/roles to match the blueprint. */
  reorder?: boolean;
  protectedChannelIds?: string[];
  /** Hide everything except the verify channel from members without the verified role (default on when verification is used). */
  gateUnverified?: boolean;
}

export interface PlannedOverwrite { target: string; allow: PermissionName[]; deny: PermissionName[] }

interface OpBase { id: string; description: string; destructive: boolean }

export type PlanOp = OpBase & (
  | { kind: "guild.update"; verificationLevel: number }
  | { kind: "role.create"; ref: string; data: { name: string; color?: number; hoist: boolean; mentionable: boolean; permissions: PermissionName[] } }
  | { kind: "role.update"; ref: string; roleId: string; data: { name?: string; color?: number; hoist?: boolean; mentionable?: boolean; permissions?: PermissionName[] } }
  | { kind: "role.delete"; roleId: string; name: string }
  | { kind: "roles.reorder"; order: string[] }
  | { kind: "category.create"; ref: string; data: { name: string }; overwrites: PlannedOverwrite[] }
  | { kind: "category.update"; ref: string; channelId: string; data: { name?: string }; overwrites?: PlannedOverwrite[] }
  | { kind: "channel.create"; ref: string; parent: string | null; data: ChannelData; overwrites: PlannedOverwrite[] | null }
  | { kind: "channel.update"; ref: string; channelId: string; parent?: string | null; data: Partial<ChannelData>; overwrites?: PlannedOverwrite[] }
  | { kind: "channel.delete"; channelId: string; name: string; channelType: SnapshotChannelType }
  | { kind: "bot.remove"; userId: string; name: string }
  | { kind: "channels.reorder"; order: { ref: string; parent: string | null }[] }
  | { kind: "message.post"; channel: string; content?: string; embed?: EmbedData; pin?: boolean }
  | { kind: "verification.publish"; channel: string }
  | { kind: "config.update"; patch: Record<string, unknown> }
  | { kind: "ticketpanel.create"; panel: { name: string; channel: string; title?: string; description?: string; parentCategory?: string; staffRoles: string[]; categories: { label: string; emoji?: string; description?: string; staffRoles: string[]; questions?: { label: string; placeholder?: string; long?: boolean; required?: boolean }[] }[] } }
  | { kind: "rolemenu.create"; menu: { name: string; channel: string; style: "buttons" | "select" | "reactions"; mode: "toggle" | "unique"; title: string; description?: string; options: { role: string; label: string; emoji?: string; description?: string }[] } }
  | { kind: "automation.create"; name: string; about?: string; definition: AutomationDefinition }
);

export type PlanOpKind = PlanOp["kind"];
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
export type PlanOpInput = DistributiveOmit<PlanOp, "id">;

export interface ChannelData {
  name: string; type: "text" | "voice" | "announcement" | "forum" | "stage";
  topic?: string; slowmode?: number; nsfw?: boolean; userLimit?: number;
}

export interface ArchitectPlan {
  mode: ArchitectMode;
  generatedAt: string;
  guildId: string;
  refs: Record<string, string>;
  ops: PlanOp[];
  warnings: string[];
  summary: { creates: number; updates: number; deletes: number; features: number; destructive: number };
}

const VERIFICATION_LEVELS = { none: 0, low: 1, medium: 2, high: 3, very_high: 4 } as const;
const VIEW: PermissionName[] = ["ViewChannel"];
const READ: PermissionName[] = ["ViewChannel", "ReadMessageHistory"];
const WRITE: PermissionName[] = ["SendMessages", "SendMessagesInThreads", "CreatePublicThreads", "CreatePrivateThreads"];

const keyOf = (x: { key?: string; name: string }) => x.key ?? (normaliseName(x.name) || x.name);
const typeCompatible = (a: SnapshotChannelType, b: ChannelData["type"]) =>
  a === b || ((a === "text" || a === "announcement") && (b === "text" || b === "announcement")) || ((a === "voice" || a === "stage") && (b === "voice" || b === "stage"));

class Planner {
  private ops: PlanOp[] = [];
  private warnings: string[] = [];
  private refs: Record<string, string> = {};
  private n = 0;
  private usedChannels = new Set<string>();
  private usedRoles = new Set<string>();
  private roleKeys = new Map<string, string>(); // normalised key/name -> ref
  private channelKeys = new Map<string, string>();
  private staffRefs: string[] = [];
  private deletedChannels = new Set<string>();
  private catEntries: { ref: string; name: string; channels: { name: string; type?: string }[]; existingId?: string }[] = [];

  constructor(private snap: GuildSnapshot, private bp: Blueprint, private opts: PlanOptions) {}

  private push(op: PlanOpInput) { this.ops.push({ ...op, id: `op${++this.n}` } as PlanOp); }

  /**
   * Orders every category in the server (new, changed and untouched ones) by
   * convention — Start Here first, staff and archive last — and the channels
   * of the categories in the blueprint. Skipped when nothing would move.
   */
  private planOrder(channelOrder: { ref: string; parent: string | null }[]) {
    const snap = this.snap;
    const full = this.opts.mode !== "quick";
    const fromBp = new Map(this.catEntries.filter((c) => c.existingId).map((c) => [c.existingId!, c]));
    const existingCats = snap.channels.filter((c) => c.type === "category" && !this.deletedChannels.has(c.id)).sort((a, b) => a.position - b.position);
    const childrenOf = (id: string) => snap.channels.filter((c) => c.parentId === id && !this.deletedChannels.has(c.id));
    type Entry = { ref: string; name: string; channels: { name: string; type?: string }[]; existingId?: string };
    const leftovers: Entry[] = existingCats.filter((c) => !fromBp.has(c.id)).map((c) => ({ ref: `id:${c.id}`, name: c.name, channels: childrenOf(c.id), existingId: c.id }));
    const newCats = this.catEntries.filter((c) => !c.existingId);
    // Starting order: the blueprint's for new layouts, the server's current order for edits.
    const start: Entry[] = this.opts.mode === "create" || this.opts.mode === "redesign"
      ? [...this.catEntries, ...leftovers]
      : [...existingCats.map((c) => fromBp.get(c.id) ?? leftovers.find((l) => l.existingId === c.id)!), ...newCats];
    const sorted = start.map((e, i) => ({ e, i, r: categoryRank(e.name, e.channels) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.e);

    const order: { ref: string; parent: string | null }[] = channelOrder.filter((o) => o.parent === null);
    for (const cat of sorted) {
      order.push({ ref: cat.ref, parent: null });
      // Quick edits only arrange channels inside categories they create.
      if (full || !cat.existingId) order.push(...channelOrder.filter((o) => o.parent === cat.ref));
    }
    const changed = newCats.length > 0 || sorted.some((c, i) => c.existingId !== existingCats[i]?.id) || (full && this.catEntries.length > 0);
    if (order.length && changed) this.push({ kind: "channels.reorder", order, destructive: false, description: sorted.length ? `Arrange categories (${sorted.slice(0, 3).map((c) => c.name).join(" → ")}${sorted.length > 3 ? " → …" : ""}) and channels` : "Arrange channels" });
  }

  /**
   * Verification gate: when the server uses verification, members without the
   * verified role see ONLY the verify channel. Every other channel/category is
   * hidden from @everyone and shown to the verified role; private (staff)
   * areas stay private. Verified members no longer see the verify channel.
   */
  private planVerificationGate() {
    const f = this.bp.features.verification;
    const sv = this.snap.verification;
    const roleRef = f ? this.roleRef(f.verifiedRole) : sv && this.snap.roles.some((r) => r.id === sv.roleId) ? `id:${sv.roleId}` : null;
    if (!roleRef || roleRef === "@everyone") return;
    const chanRef = f ? this.channelRef(f.channel) : sv?.channelId ? `id:${sv.channelId}` : null;
    const verifyId = chanRef?.startsWith("id:") ? chanRef.slice(3) : chanRef ? this.refs[chanRef] : undefined;
    const isVerify = (ref?: string, id?: string) => (!!chanRef && ref === chanRef) || (!!verifyId && id === verifyId);

    const clone = (l: PlannedOverwrite[]) => l.map((o) => ({ target: o.target, allow: [...o.allow], deny: [...o.deny] }));
    const entry = (l: PlannedOverwrite[], t: string) => { let e = l.find((o) => o.target === t); if (!e) { e = { target: t, allow: [], deny: [] }; l.push(e); } return e; };
    const set = (e: PlannedOverwrite, p: PermissionName, allow: boolean) => { e.allow = e.allow.filter((x) => x !== p); e.deny = e.deny.filter((x) => x !== p); (allow ? e.allow : e.deny).push(p); };
    const gate = (base: PlannedOverwrite[], verify: boolean): PlannedOverwrite[] | null => {
      const ev = base.find((o) => o.target === "@everyone");
      if (verify) {
        const r = base.find((o) => o.target === roleRef);
        if (!ev?.deny.includes("ViewChannel") && r?.deny.includes("ViewChannel")) return null;
        const l = clone(base); set(entry(l, "@everyone"), "ViewChannel", true); set(entry(l, roleRef), "ViewChannel", false); return l;
      }
      if (ev?.deny.includes("ViewChannel")) return null; // already private / gated
      const l = clone(base); set(entry(l, "@everyone"), "ViewChannel", false); set(entry(l, roleRef), "ViewChannel", true); return l;
    };
    const current = (c: SnapshotChannel): PlannedOverwrite[] => c.overwrites.map((o) => ({ target: o.type === "member" ? `member:${o.id}` : o.id === this.snap.id ? "@everyone" : `id:${o.id}`, allow: fromBits(o.allow), deny: fromBits(o.deny) }));
    const byId = new Map(this.snap.channels.map((c) => [c.id, c]));
    const handled = new Set<string>();
    const catOverwrites = new Map<string, PlannedOverwrite[]>();
    // Existing categories that the blueprint doesn't touch are gated below; record what they'll become.
    for (const c of this.snap.channels) if (c.type === "category") { const g = gate(current(c), false); catOverwrites.set(`id:${c.id}`, g ?? current(c)); }

    for (const op of this.ops) {
      if (op.kind === "category.create" || op.kind === "category.update" || op.kind === "channel.create" || op.kind === "channel.update") {
        const id = "channelId" in op ? op.channelId : undefined;
        if (id) handled.add(id);
        const verify = isVerify(op.ref, id);
        let base: PlannedOverwrite[];
        if (op.kind === "channel.create" && op.overwrites === null) {
          // Would inherit its category — use the category's (gated) permissions explicitly.
          const parentId = op.parent?.startsWith("id:") ? op.parent.slice(3) : op.parent ? this.refs[op.parent] : undefined;
          base = op.parent ? catOverwrites.get(op.parent) ?? (parentId ? catOverwrites.get(`id:${parentId}`) : undefined) ?? [] : [];
        } else base = op.overwrites ?? (id && byId.get(id) ? current(byId.get(id)!) : []);
        const gated = gate(base, verify);
        if (gated) { op.overwrites = gated; op.description += verify ? " · visible only to unverified members" : " · hidden until verified"; }
        else if (op.kind === "channel.create" && op.overwrites === null && base.length) op.overwrites = base;
        if (op.kind === "category.create" || op.kind === "category.update") catOverwrites.set(op.ref, op.overwrites ?? base);
      }
    }
    for (const c of this.snap.channels) {
      if (handled.has(c.id) || this.deletedChannels.has(c.id)) continue;
      const verify = isVerify(undefined, c.id);
      const gated = gate(current(c), verify);
      if (!gated) continue;
      const label = c.type === "category" ? `category ${c.name}` : `#${c.name}`;
      if (c.type === "category") this.push({ kind: "category.update", ref: `id:${c.id}`, channelId: c.id, data: {}, overwrites: gated, destructive: false, description: verify ? `Show ${label} to unverified members` : `Hide ${label} until members verify` });
      else this.push({ kind: "channel.update", ref: `id:${c.id}`, channelId: c.id, data: {}, overwrites: gated, destructive: false, description: verify ? `Show ${label} only to unverified members` : `Hide ${label} until members verify` });
    }
  }

  // ── reference resolution ──
  roleRef(name: string): string | null {
    if (name === "@everyone" || normaliseName(name) === "everyone") return "@everyone";
    if (/^\d{15,22}$/.test(name) && this.snap.roles.some((r) => r.id === name)) return `id:${name}`;
    const k = this.roleKeys.get(name) ?? this.roleKeys.get(normaliseName(name));
    if (k) return k;
    const existing = this.snap.roles.find((r) => !r.everyone && normaliseName(r.name) === normaliseName(name));
    if (existing) return `id:${existing.id}`;
    this.warnings.push(`Role reference "${name}" could not be resolved and was ignored.`);
    return null;
  }

  channelRef(name: string): string | null {
    if (/^\d{15,22}$/.test(name) && this.snap.channels.some((c) => c.id === name)) return `id:${name}`;
    const clean = name.replace(/^#/, "");
    const k = this.channelKeys.get(clean) ?? this.channelKeys.get(normaliseName(clean));
    if (k) return k;
    const existing = this.snap.channels.find((c) => normaliseName(c.name) === normaliseName(clean));
    if (existing) return `id:${existing.id}`;
    this.warnings.push(`Channel reference "${name}" could not be resolved and was ignored.`);
    return null;
  }

  private rolesRefs(names: string[] | undefined): string[] {
    return (names ?? []).map((n) => this.roleRef(n)).filter((x): x is string => !!x);
  }

  // ── matching existing entities ──
  private matchRole(r: BlueprintRole): SnapshotRole | undefined {
    const candidates = this.snap.roles.filter((x) => !x.everyone && !x.managed && !this.usedRoles.has(x.id));
    const names = [r.renameFrom, r.name].filter(Boolean).map((n) => normaliseName(n!));
    return candidates.find((x) => names.includes(normaliseName(x.name)));
  }

  private matchChannel(c: { name: string; renameFrom?: string }, kind: "category" | ChannelData["type"], parentId?: string | null): SnapshotChannel | undefined {
    const names = [c.renameFrom, c.name].filter(Boolean).map((n) => normaliseName(n!));
    const pool = this.snap.channels.filter((x) => !this.usedChannels.has(x.id) && names.includes(normaliseName(x.name))
      && (kind === "category" ? x.type === "category" : x.type !== "category" && typeCompatible(x.type, kind)));
    return pool.find((x) => parentId !== undefined && x.parentId === parentId) ?? pool[0];
  }

  // ── permissions ──
  private desiredOverwrites(spec: { private?: boolean; visibleTo?: string[]; readOnly?: boolean; writableBy?: string[]; overwrites?: { target: string; allow: string[]; deny: string[] }[] }, base: PlannedOverwrite[] = []): PlannedOverwrite[] | null {
    const hasSpec = spec.private !== undefined || spec.readOnly !== undefined || !!spec.overwrites?.length || !!spec.visibleTo?.length || !!spec.writableBy?.length;
    if (!hasSpec) return null;
    const map = new Map<string, { allow: Set<PermissionName>; deny: Set<PermissionName> }>();
    const get = (t: string) => { if (!map.has(t)) map.set(t, { allow: new Set(), deny: new Set() }); return map.get(t)!; };
    const allow = (t: string, perms: PermissionName[]) => { const e = get(t); perms.forEach((p) => { e.allow.add(p); e.deny.delete(p); }); };
    const deny = (t: string, perms: PermissionName[]) => { const e = get(t); perms.forEach((p) => { e.deny.add(p); e.allow.delete(p); }); };
    for (const o of base) { allow(o.target, o.allow); deny(o.target, o.deny); }
    if (spec.private) {
      deny("@everyone", VIEW);
      for (const r of this.rolesRefs(spec.visibleTo)) allow(r, [...READ, "SendMessages", "Connect", "Speak"]);
    } else if (spec.private === false) {
      const e = map.get("@everyone"); e?.deny.delete("ViewChannel");
    }
    if (spec.readOnly) {
      deny("@everyone", WRITE);
      for (const r of [...this.rolesRefs(spec.writableBy), ...this.staffRefs]) allow(r, ["SendMessages", "SendMessagesInThreads"]);
    }
    for (const o of spec.overwrites ?? []) {
      const t = this.roleRef(o.target);
      if (!t) continue;
      const valid = (l: string[]) => l.filter((p) => { const ok = isValidPermission(p); if (!ok) this.warnings.push(`Unknown permission "${p}" ignored.`); return ok; }) as PermissionName[];
      allow(t, valid(o.allow)); deny(t, valid(o.deny));
    }
    return [...map.entries()].filter(([, v]) => v.allow.size || v.deny.size).map(([target, v]) => ({ target, allow: [...v.allow], deny: [...v.deny] }));
  }

  /** Merges desired overwrites into an existing set (preserving untouched targets). */
  private mergeWithExisting(existing: SnapshotOverwrite[], desired: PlannedOverwrite[]): { merged: PlannedOverwrite[]; changed: boolean } {
    const toTarget = (o: SnapshotOverwrite) => (o.id === this.snap.id ? "@everyone" : `id:${o.id}`);
    const current = existing.filter((o) => o.type === "role" || this.opts.resetPermissions !== true).map((o) => ({ target: o.type === "member" ? `member:${o.id}` : toTarget(o), allow: fromBits(o.allow), deny: fromBits(o.deny) }));
    const byTarget = new Map(current.map((o) => [o.target, o]));
    let changed = false;
    if (this.opts.resetPermissions) {
      const keep = current.filter((o) => o.target.startsWith("member:"));
      const merged = [...keep, ...desired];
      changed = JSON.stringify(normaliseOw(current)) !== JSON.stringify(normaliseOw(merged));
      return { merged, changed };
    }
    for (const d of desired) {
      const cur = byTarget.get(d.target);
      const allow = new Set(cur?.allow ?? []); const deny = new Set(cur?.deny ?? []);
      d.allow.forEach((p) => { allow.add(p); deny.delete(p); });
      d.deny.forEach((p) => { deny.add(p); allow.delete(p); });
      const next = { target: d.target, allow: [...allow], deny: [...deny] };
      if (!cur || JSON.stringify(normaliseOw([cur])) !== JSON.stringify(normaliseOw([next]))) changed = true;
      byTarget.set(d.target, next);
    }
    return { merged: [...byTarget.values()], changed };
  }

  // ── main ──
  build(): ArchitectPlan {
    const { bp, snap, opts } = this;
    const protectedIds = new Set(opts.protectedChannelIds ?? []);

    if (bp.verificationLevel) {
      const lvl = VERIFICATION_LEVELS[bp.verificationLevel];
      if (lvl !== snap.verificationLevel) this.push({ kind: "guild.update", verificationLevel: lvl, destructive: false, description: `Set server verification level to ${bp.verificationLevel.replace("_", " ")}` });
    }

    // Register keys first so cross references work regardless of order.
    for (const r of bp.roles) { const ref = `role:${r.key}`; this.roleKeys.set(r.key, ref); this.roleKeys.set(normaliseName(r.name), ref); }
    const allChannels: { c: BlueprintChannel; cat: BlueprintCategory | null }[] = [
      ...bp.channels.map((c) => ({ c, cat: null })),
      ...bp.categories.flatMap((cat) => cat.channels.map((c) => ({ c, cat }))),
    ];
    for (const cat of bp.categories) { const ref = `chan:${keyOf(cat)}`; this.channelKeys.set(keyOf(cat), ref); this.channelKeys.set(normaliseName(cat.name), ref); }
    for (const { c } of allChannels) { const ref = `chan:${keyOf(c)}`; this.channelKeys.set(keyOf(c), ref); this.channelKeys.set(normaliseName(c.name), ref); }

    // Staff roles get write access in read-only channels.
    this.staffRefs = bp.roles.filter((r) => r.preset && ["admin", "manager", "moderator", "support"].includes(r.preset)).map((r) => `role:${r.key}`);

    // ── roles ──
    for (const r of bp.roles) {
      const ref = `role:${r.key}`;
      const perms = (r.permissions?.filter(isValidPermission) as PermissionName[] | undefined) ?? (r.preset ? ROLE_PRESETS[r.preset] : undefined);
      const color = hexToInt(r.color);
      const existing = this.matchRole(r);
      if (existing) {
        this.usedRoles.add(existing.id);
        this.refs[ref] = existing.id;
        const data: Extract<PlanOp, { kind: "role.update" }>["data"] = {};
        if (existing.name !== r.name) data.name = r.name;
        if (color !== undefined && color !== existing.color) data.color = color;
        if (r.hoist !== undefined && r.hoist !== existing.hoist) data.hoist = r.hoist;
        if (r.mentionable !== undefined && r.mentionable !== existing.mentionable) data.mentionable = r.mentionable;
        // Preserve existing permissions unless explicitly listed (presets don't overwrite existing roles outside redesign).
        if (perms && (r.permissions || opts.mode === "redesign") && toBits(perms) !== BigInt(existing.permissions)) data.permissions = perms;
        if (Object.keys(data).length) {
          const removesPerms = data.permissions ? fromBits(existing.permissions).some((p) => !data.permissions!.includes(p)) : false;
          this.push({ kind: "role.update", ref, roleId: existing.id, data, destructive: removesPerms, description: `Update role @${existing.name}${data.name ? ` → @${data.name}` : ""}${data.permissions ? " (permissions)" : ""}` });
        }
      } else {
        if (existing === undefined && this.snap.roles.some((x) => x.managed && normaliseName(x.name) === normaliseName(r.name))) this.warnings.push(`@${r.name} matches an integration-managed role; a separate role will be created.`);
        this.push({ kind: "role.create", ref, data: { name: r.name, color, hoist: r.hoist ?? (!!r.preset && r.preset !== "member" && r.preset !== "cosmetic" && r.preset !== "muted"), mentionable: r.mentionable ?? false, permissions: perms ?? [] }, destructive: false, description: `Create role @${r.name}${r.preset ? ` (${r.preset})` : ""}` });
      }
    }
    if (bp.roles.length > 1 && (opts.mode === "create" || opts.mode === "redesign" || opts.reorder)) {
      this.push({ kind: "roles.reorder", order: bp.roles.map((r) => `role:${r.key}`), destructive: false, description: "Arrange role hierarchy" });
    }

    // ── categories & channels ──
    const order: { ref: string; parent: string | null }[] = [];
    const planChannel = (c: BlueprintChannel, parentRef: string | null, parentId: string | null | undefined, catBase: PlannedOverwrite[] | null) => {
      const ref = `chan:${keyOf(c)}`;
      order.push({ ref, parent: parentRef });
      const data: ChannelData = { name: c.name, type: c.type, topic: c.topic, slowmode: c.slowmode, nsfw: c.nsfw, userLimit: c.userLimit };
      const existing = this.matchChannel(c, c.type, parentId);
      const own = this.desiredOverwrites(c, catBase ?? []);
      if (existing) {
        this.usedChannels.add(existing.id);
        this.refs[ref] = existing.id;
        const diff: Partial<ChannelData> = {};
        if (normaliseName(existing.name) !== normaliseName(c.name) || (c.renameFrom && existing.name !== c.name)) diff.name = c.name;
        if (c.topic !== undefined && (existing.topic ?? "") !== c.topic) diff.topic = c.topic;
        if (c.slowmode !== undefined && (existing.rateLimitPerUser ?? 0) !== c.slowmode) diff.slowmode = c.slowmode;
        if (c.nsfw !== undefined && !!existing.nsfw !== c.nsfw) diff.nsfw = c.nsfw;
        if (c.userLimit !== undefined && (existing.userLimit ?? 0) !== c.userLimit) diff.userLimit = c.userLimit;
        if ((existing.type === "text" && c.type === "announcement") || (existing.type === "announcement" && c.type === "text")) diff.type = c.type;
        const parentChanged = parentId !== undefined && existing.parentId !== parentId;
        const moveToNewParent = parentRef !== null && parentId === undefined; // parent category being created
        let overwrites: PlannedOverwrite[] | undefined;
        if (own) {
          const { merged, changed } = this.mergeWithExisting(existing.overwrites, own);
          if (changed) overwrites = merged;
        }
        if (Object.keys(diff).length || parentChanged || moveToNewParent || overwrites) {
          const bits = [diff.name ? `rename → #${diff.name}` : "", parentChanged || moveToNewParent ? "move" : "", overwrites ? "permissions" : "", diff.topic !== undefined ? "topic" : "", diff.type ? `convert to ${diff.type}` : ""].filter(Boolean).join(", ");
          this.push({ kind: "channel.update", ref, channelId: existing.id, parent: parentChanged || moveToNewParent ? parentRef : undefined, data: diff, overwrites, destructive: false, description: `Update #${existing.name}${bits ? ` (${bits})` : ""}` });
        }
      } else {
        this.push({ kind: "channel.create", ref, parent: parentRef, data, overwrites: own ?? catBase, destructive: false, description: `Create ${c.type === "text" ? "#" : c.type + " "}${c.name}${parentRef ? "" : " (no category)"}` });
      }
    };

    // In quick edits / improvements, listing an existing channel at the top level means "change it",
    // not "move it out of its category".
    const topParent = opts.mode === "quick" || opts.mode === "improve" ? undefined : null;
    for (const c of bp.channels) planChannel(c, null, topParent, null);
    for (const cat of bp.categories) {
      const ref = `chan:${keyOf(cat)}`;
      const existing = this.matchChannel(cat, "category");
      this.catEntries.push({ ref, name: cat.name, channels: cat.channels, existingId: existing?.id });
      const desired = this.desiredOverwrites(cat);
      if (existing) {
        this.usedChannels.add(existing.id);
        this.refs[ref] = existing.id;
        let overwrites: PlannedOverwrite[] | undefined;
        if (desired) { const { merged, changed } = this.mergeWithExisting(existing.overwrites, desired); if (changed) overwrites = merged; }
        const rename = existing.name !== cat.name ? cat.name : undefined;
        if (rename || overwrites) this.push({ kind: "category.update", ref, channelId: existing.id, data: { name: rename }, overwrites, destructive: false, description: `Update category ${existing.name}${rename ? ` → ${rename}` : ""}${overwrites ? " (permissions)" : ""}` });
      } else {
        this.push({ kind: "category.create", ref, data: { name: cat.name }, overwrites: desired ?? [], destructive: false, description: `Create category ${cat.name}${cat.private ? " (private)" : ""}` });
      }
      for (const ch of cat.channels) planChannel(ch, ref, existing ? existing.id : undefined, desired);
    }

    // ── features ──
    this.planFeatures();

    // ── deletions ──
    const deleteChannel = (c: SnapshotChannel, why: string) => {
      if (protectedIds.has(c.id)) { this.warnings.push(`#${c.name} is a protected system channel and was kept.`); return; }
      this.usedChannels.add(c.id);
      this.deletedChannels.add(c.id);
      this.push({ kind: "channel.delete", channelId: c.id, name: c.name, channelType: c.type, destructive: true, description: `Delete ${c.type === "category" ? "category" : "#"}${c.type === "category" ? " " + c.name : c.name} (${why})` });
    };
    const deletableRole = (r: SnapshotRole) => !r.everyone && !r.managed && r.id !== snap.botRoleId && (snap.botHighestPosition === undefined || r.position < snap.botHighestPosition);
    for (const name of bp.removals.channels) {
      const c = snap.channels.find((x) => x.type !== "category" && !this.usedChannels.has(x.id) && (x.id === name || normaliseName(x.name) === normaliseName(name.replace(/^#/, ""))));
      if (c) deleteChannel(c, "requested"); else this.warnings.push(`Channel to remove "${name}" not found.`);
    }
    for (const name of bp.removals.categories) {
      const c = snap.channels.find((x) => x.type === "category" && !this.usedChannels.has(x.id) && (x.id === name || normaliseName(x.name) === normaliseName(name)));
      if (c) deleteChannel(c, "requested"); else this.warnings.push(`Category to remove "${name}" not found.`);
    }
    for (const name of bp.removals.roles) {
      const r = snap.roles.find((x) => !this.usedRoles.has(x.id) && (x.id === name || normaliseName(x.name) === normaliseName(name)));
      if (!r) { this.warnings.push(`Role to remove "${name}" not found.`); continue; }
      if (!deletableRole(r)) { this.warnings.push(`@${r.name} cannot be deleted (managed, @everyone, or above MOTH).`); continue; }
      this.usedRoles.add(r.id);
      this.push({ kind: "role.delete", roleId: r.id, name: r.name, destructive: true, description: `Delete role @${r.name} (requested)` });
    }
    if (opts.prune) {
      for (const c of snap.channels.filter((x) => x.type !== "category" && !this.usedChannels.has(x.id))) deleteChannel(c, "not in blueprint");
      for (const c of snap.channels.filter((x) => x.type === "category" && !this.usedChannels.has(x.id))) deleteChannel(c, "not in blueprint");
      for (const r of snap.roles.filter((x) => !this.usedRoles.has(x.id) && deletableRole(x))) {
        this.push({ kind: "role.delete", roleId: r.id, name: r.name, destructive: true, description: `Delete role @${r.name} (not in blueprint)` });
      }
    }

    if (opts.gateUnverified !== false) this.planVerificationGate();
    if (opts.reorder ?? (opts.mode === "create" || opts.mode === "redesign")) this.planOrder(order);

    // Other bots: explicit removals, or all of them when removeBots is on.
    const removedBots = new Set<string>();
    const removeBot = (b: { id: string; name: string; kickable: boolean }, why: string) => {
      if (removedBots.has(b.id)) return;
      if (!b.kickable) { this.warnings.push(`Bot ${b.name} can't be removed — its role is above MOTH's. Move MOTH's role higher.`); return; }
      removedBots.add(b.id);
      this.push({ kind: "bot.remove", userId: b.id, name: b.name, destructive: true, description: `Remove bot ${b.name} (${why})` });
    };
    for (const name of bp.removals.bots) {
      const b = snap.bots?.find((x) => x.id === name || normaliseName(x.name) === normaliseName(name));
      if (b) removeBot(b, "requested"); else this.warnings.push(`Bot to remove "${name}" not found.`);
    }
    if (opts.removeBots) for (const b of snap.bots ?? []) removeBot(b, "MOTH replaces it");

    const count = (pred: (o: PlanOp) => boolean) => this.ops.filter(pred).length;
    return {
      mode: opts.mode, generatedAt: new Date().toISOString(), guildId: snap.id, refs: this.refs, ops: this.ops, warnings: [...new Set(this.warnings)],
      summary: {
        creates: count((o) => o.kind.endsWith(".create") && !["ticketpanel.create", "rolemenu.create", "automation.create"].includes(o.kind)),
        updates: count((o) => o.kind.endsWith(".update") && o.kind !== "config.update"),
        deletes: count((o) => o.kind.endsWith(".delete") || o.kind === "bot.remove"),
        features: count((o) => ["config.update", "ticketpanel.create", "rolemenu.create", "automation.create", "verification.publish", "message.post"].includes(o.kind)),
        destructive: count((o) => o.destructive),
      },
    };
  }

  private planFeatures() {
    const f = this.bp.features;
    const color = this.bp.theme?.primaryColor ?? "#DC143C";
    const patch: Record<string, Record<string, unknown>> = {};
    const set = (section: string, value: Record<string, unknown>) => { patch[section] = { ...(patch[section] ?? {}), ...value }; };
    const ch = (n?: string) => (n ? this.channelRef(n) : null);
    const ro = (n?: string) => (n ? this.roleRef(n) : null);
    const wrap = (r: string | null) => (r ? `ref:${r}` : null);
    const described: string[] = [];

    if (f.welcome) {
      const c = ch(f.welcome.channel);
      if (c) {
        set("welcome", { enabled: true, channelId: wrap(c), message: { embed: { title: f.welcome.title ?? "Welcome to {server}!", description: f.welcome.message, color, thumbnail: "{user.avatar}" } }, ...(f.welcome.dm ? { dm: { enabled: true, message: { content: f.welcome.dm } } } : {}) });
        described.push("welcome messages");
      }
    }
    if (f.goodbye) { const c = ch(f.goodbye.channel); if (c) { set("goodbye", { enabled: true, channelId: wrap(c), message: { content: f.goodbye.message } }); described.push("goodbye messages"); } }
    if (f.autoroles?.length) { set("autorole", { enabled: true, roleIds: this.rolesRefs(f.autoroles).map(wrap) }); described.push("auto-roles"); }
    if (f.verification) {
      const c = ch(f.verification.channel); const r = ro(f.verification.verifiedRole);
      if (c && r) {
        set("verification", { enabled: true, mode: f.verification.mode, channelId: wrap(c), verifiedRoleId: wrap(r), ...(f.verification.message ? { message: { embed: { title: "Verification", description: f.verification.message, color } } } : {}) });
        this.push({ kind: "verification.publish", channel: c, destructive: false, description: `Post the verification panel in ${f.verification.channel}` });
        // Gate the server: @everyone loses ViewChannel; the verified role grants it.
        const everyone = this.snap.roles.find((x) => x.everyone);
        if (everyone) {
          const current = fromBits(everyone.permissions);
          if (current.includes("ViewChannel")) {
            const next = current.filter((p) => p !== "ViewChannel");
            this.push({ kind: "role.update", ref: "@everyone", roleId: everyone.id, data: { permissions: next }, destructive: this.opts.mode !== "create", description: this.opts.mode === "create" ? "Hide channels from unverified members (@everyone loses View Channels)" : "Hide channels from unverified members — EXISTING members without the verified role will lose access until they verify" });
          }
        }
        if (r.startsWith("role:")) {
          const op = this.ops.find((o) => o.kind === "role.create" && o.ref === r) as Extract<PlanOp, { kind: "role.create" }> | undefined;
          if (op && !op.data.permissions.includes("ViewChannel")) op.data.permissions = [...new Set([...op.data.permissions, ...ROLE_PRESETS.member])];
        }
        this.ensureVisibleToEveryone(c);
        described.push("verification");
      }
    }
    if (f.moderation) {
      const presets = moderationPreset(f.moderation.preset);
      set("automod", presets.automod); set("moderation", { ...presets.moderation, ...(f.moderation.modRoles ? { moderatorRoleIds: this.rolesRefs(f.moderation.modRoles).map(wrap) } : {}) });
      if (f.moderation.logChannel) { const c = ch(f.moderation.logChannel); if (c) set("general", { modLogChannelId: wrap(c), logChannelId: wrap(c) }); }
      if (f.moderation.appealsChannel) { const c = ch(f.moderation.appealsChannel); if (c) set("moderation", { appeals: { enabled: true, channelId: wrap(c) } }); }
      described.push(`${f.moderation.preset} auto-moderation`);
    }
    if (f.security) {
      set("security", { enabled: true, sensitivity: f.security.sensitivity, ...(f.security.alertRoles ? { alertRoleIds: this.rolesRefs(f.security.alertRoles).map(wrap) } : {}) });
      if (f.security.logChannel) { const c = ch(f.security.logChannel); if (c) set("general", { securityLogChannelId: wrap(c) }); }
      described.push(`${f.security.sensitivity} anti-raid protection`);
    }
    if (f.leveling) {
      const c = ch(f.leveling.announceChannel);
      set("leveling", { enabled: f.leveling.enabled, ...(c ? { announce: "channel", announceChannelId: wrap(c) } : {}), ...(f.leveling.rewards ? { rewards: f.leveling.rewards.map((r) => ({ level: r.level, roleId: wrap(this.roleRef(r.role)) })).filter((r) => r.roleId) } : {}) });
      described.push("XP & leveling");
    }
    if (f.economy) { set("economy", { enabled: f.economy.enabled, ...(f.economy.currencyName ? { currencyName: f.economy.currencyName } : {}), ...(f.economy.currencyEmoji ? { currencyEmoji: f.economy.currencyEmoji } : {}) }); described.push("economy"); }
    if (f.achievements) set("achievements", { enabled: f.achievements.enabled });
    if (f.ai) { set("ai", { enabled: f.ai.enabled, ...(f.ai.chatChannels ? { chatChannelIds: f.ai.chatChannels.map((n) => wrap(ch(n))).filter(Boolean) } : {}), ...(f.ai.tone ? { personality: { tone: f.ai.tone } } : {}) }); described.push("AI assistant"); }
    if (f.milestones) { const c = ch(f.milestones.channel); if (c) set("community", { milestones: { enabled: true, every: f.milestones.every, channelId: wrap(c) } }); }

    if (f.tickets?.length) {
      set("tickets", { enabled: true });
      for (const t of f.tickets) {
        const c = ch(t.channel); if (!c) continue;
        if (t.transcriptChannel) { const tc = ch(t.transcriptChannel); if (tc) set("tickets", { transcriptChannelId: wrap(tc) }); }
        const staff = this.rolesRefs(t.staffRoles);
        this.push({
          kind: "ticketpanel.create", destructive: false, description: `Create ticket panel "${t.name}" with ${t.categories.length} categor${t.categories.length === 1 ? "y" : "ies"}`,
          panel: {
            name: t.name, channel: c, title: t.title, description: t.description, parentCategory: t.parentCategory ? ch(t.parentCategory) ?? undefined : undefined, staffRoles: staff,
            categories: t.categories.map((k) => ({ label: k.label, emoji: k.emoji, description: k.description, staffRoles: k.staffRoles ? this.rolesRefs(k.staffRoles) : staff, questions: k.questions })),
          },
        });
      }
    }
    for (const m of f.roleMenus ?? []) {
      const c = ch(m.channel); if (!c) continue;
      const options = m.options.map((o) => ({ ...o, role: this.roleRef(o.role) })).filter((o): o is typeof o & { role: string } => !!o.role);
      if (options.length) this.push({ kind: "rolemenu.create", destructive: false, description: `Create role menu "${m.name}" (${options.length} roles)`, menu: { name: m.name, channel: c, style: m.style, mode: m.mode, title: m.title, description: m.description, options } });
    }
    for (const a of f.automations ?? []) this.push({ kind: "automation.create", name: a.name, about: a.description, definition: a.definition, destructive: false, description: `Create automation "${a.name}"` });
    for (const msg of f.messages ?? []) {
      const c = ch(msg.channel); if (!c) continue;
      this.push({ kind: "message.post", channel: c, content: msg.content, embed: msg.embed ? { color, ...msg.embed } : undefined, pin: msg.pin, destructive: false, description: `Post ${msg.embed?.title ? `"${msg.embed.title}"` : "a message"} in ${msg.channel}` });
    }
    if (Object.keys(patch).length) this.ops.splice(this.firstFeatureIndex(), 0, { id: `op${++this.n}`, kind: "config.update", patch, destructive: false, description: `Configure MOTH: ${described.join(", ") || Object.keys(patch).join(", ")}` });
  }

  private firstFeatureIndex(): number {
    const i = this.ops.findIndex((o) => ["verification.publish", "ticketpanel.create", "rolemenu.create", "automation.create", "message.post"].includes(o.kind));
    return i === -1 ? this.ops.length : i;
  }

  /** The verification channel must stay visible to unverified members. */
  private ensureVisibleToEveryone(channelRef: string) {
    for (const op of this.ops) {
      if ((op.kind === "channel.create" || op.kind === "channel.update") && op.ref === channelRef) {
        const base = op.overwrites ?? [];
        const others = base.filter((o) => o.target !== "@everyone");
        const ev = base.find((o) => o.target === "@everyone") ?? { target: "@everyone", allow: [], deny: [] };
        op.overwrites = [...others, { target: "@everyone", allow: [...new Set([...ev.allow, "ViewChannel", "ReadMessageHistory"] as PermissionName[])], deny: [...new Set([...ev.deny.filter((p) => p !== "ViewChannel"), "SendMessages"] as PermissionName[])] }];
        return;
      }
    }
    if (channelRef.startsWith("id:")) {
      this.push({ kind: "channel.update", ref: channelRef, channelId: channelRef.slice(3), data: {}, overwrites: [{ target: "@everyone", allow: ["ViewChannel", "ReadMessageHistory"], deny: ["SendMessages"] }], destructive: false, description: "Keep the verification channel visible to unverified members" });
    }
  }
}

function normaliseOw(list: PlannedOverwrite[]) {
  return [...list].map((o) => ({ t: o.target, a: [...o.allow].sort(), d: [...o.deny].sort() })).sort((a, b) => a.t.localeCompare(b.t));
}

export function moderationPreset(preset: "relaxed" | "balanced" | "strict") {
  const base = { enabled: true };
  if (preset === "relaxed") return {
    automod: { ...base, spam: { enabled: true, action: "delete" }, mentions: { enabled: true, action: "delete", maxMentions: 10 }, invites: { enabled: false }, caps: { enabled: false }, links: { enabled: false, mode: "allow-all" } },
    moderation: { escalation: [{ warnings: 5, action: "timeout", durationMinutes: 60 }, { warnings: 8, action: "kick" }] },
  };
  if (preset === "strict") return {
    automod: { ...base, spam: { enabled: true, action: "timeout", maxMessages: 5 }, duplicates: { enabled: true, action: "warn" }, mentions: { enabled: true, action: "timeout", maxMentions: 4 }, invites: { enabled: true, action: "warn" }, caps: { enabled: true, action: "delete" }, links: { enabled: true, mode: "whitelist", action: "delete" }, zalgo: { enabled: true, action: "delete" } },
    moderation: { escalation: [{ warnings: 2, action: "timeout", durationMinutes: 60 }, { warnings: 4, action: "kick" }, { warnings: 5, action: "ban" }] },
  };
  return {
    automod: { ...base, spam: { enabled: true, action: "timeout" }, duplicates: { enabled: true, action: "delete" }, mentions: { enabled: true, action: "timeout" }, invites: { enabled: true, action: "delete" }, caps: { enabled: true, action: "delete" } },
    moderation: { escalation: [{ warnings: 3, action: "timeout", durationMinutes: 60 }, { warnings: 5, action: "kick" }, { warnings: 7, action: "ban" }] },
  };
}

/** Heuristic: a guild that still looks like Discord's default template. */
export function looksFresh(s: GuildSnapshot): boolean {
  return s.channels.length <= 6 && s.roles.filter((r) => !r.everyone && !r.managed).length <= 1;
}

export function buildPlan(snapshot: GuildSnapshot, blueprintInput: unknown, opts: PlanOptions): ArchitectPlan {
  const bp = organiseBlueprint(blueprintSchema.parse(blueprintInput));
  return new Planner(snapshot, bp, { ...opts, prune: opts.prune ?? (opts.mode === "create" && looksFresh(snapshot)) }).build();
}

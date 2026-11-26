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
  /** Replace permission overwrites instead of merging with existing ones. */
  resetPermissions?: boolean;
  /** Reorder existing channels/roles to match the blueprint. */
  reorder?: boolean;
  protectedChannelIds?: string[];
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

  constructor(private snap: GuildSnapshot, private bp: Blueprint, private opts: PlanOptions) {}

  private push(op: PlanOpInput) { this.ops.push({ ...op, id: `op${++this.n}` } as PlanOp); }

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

    for (const c of bp.channels) planChannel(c, null, null, null);
    for (const cat of bp.categories) {
      const ref = `chan:${keyOf(cat)}`;
      order.push({ ref, parent: null });
      const existing = this.matchChannel(cat, "category");
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
    if (order.length && (opts.mode === "create" || opts.mode === "redesign" || opts.reorder)) {
      this.push({ kind: "channels.reorder", order, destructive: false, description: "Arrange categories and channels" });
    }

    // ── features ──
    this.planFeatures();

    // ── deletions ──
    const deleteChannel = (c: SnapshotChannel, why: string) => {
      if (protectedIds.has(c.id)) { this.warnings.push(`#${c.name} is a protected system channel and was kept.`); return; }
      this.usedChannels.add(c.id);
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

    const count = (pred: (o: PlanOp) => boolean) => this.ops.filter(pred).length;
    return {
      mode: opts.mode, generatedAt: new Date().toISOString(), guildId: snap.id, refs: this.refs, ops: this.ops, warnings: [...new Set(this.warnings)],
      summary: {
        creates: count((o) => o.kind.endsWith(".create") && !["ticketpanel.create", "rolemenu.create", "automation.create"].includes(o.kind)),
        updates: count((o) => o.kind.endsWith(".update") && o.kind !== "config.update"),
        deletes: count((o) => o.kind.endsWith(".delete")),
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
  const bp = blueprintSchema.parse(blueprintInput);
  return new Planner(snapshot, bp, { reorder: false, ...opts, prune: opts.prune ?? (opts.mode === "create" && looksFresh(snapshot)) }).build();
}

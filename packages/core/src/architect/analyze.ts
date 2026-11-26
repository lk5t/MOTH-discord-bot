import type { AnalysisFinding, ServerAnalysis, BlueprintInput } from "./blueprint.js";
import type { GuildSnapshot } from "./snapshot.js";
import { DANGEROUS_PERMISSIONS, fromBits } from "./permissions.js";
import { normaliseName } from "../util.js";
import type { GuildConfig } from "../guild-config.js";

/**
 * Deterministic server audit used by Smart Improve. The AI (when configured)
 * builds on these findings rather than replacing them, so results are
 * explainable and reproducible.
 */
export function analyzeServer(s: GuildSnapshot, cfg?: GuildConfig): ServerAnalysis & { suggestions: BlueprintInput } {
  const findings: AnalysisFinding[] = [];
  const add = (f: AnalysisFinding) => findings.push(f);
  const everyone = s.roles.find((r) => r.everyone);
  const channels = s.channels.filter((c) => c.type !== "category");
  const cats = s.channels.filter((c) => c.type === "category");
  const has = (re: RegExp) => channels.some((c) => re.test(normaliseName(c.name)));
  const suggestions: BlueprintInput = { roles: [], categories: [], channels: [], features: {} };

  if (everyone) {
    const bad = fromBits(everyone.permissions).filter((p) => DANGEROUS_PERMISSIONS.includes(p));
    if (bad.length) add({ severity: bad.includes("Administrator") ? "critical" : "high", area: "permissions", title: "@everyone has dangerous permissions", detail: `Every member can: ${bad.join(", ")}.`, recommendation: "Remove these from @everyone and grant them only to staff roles." });
  }
  const adminRoles = s.roles.filter((r) => !r.everyone && !r.managed && fromBits(r.permissions).includes("Administrator"));
  if (adminRoles.length > 3) add({ severity: "medium", area: "roles", title: "Too many Administrator roles", detail: `${adminRoles.length} roles grant Administrator: ${adminRoles.map((r) => r.name).join(", ")}.`, recommendation: "Keep Administrator to one owner role; use scoped permissions for other staff." });
  const staffLike = s.roles.filter((r) => /mod|admin|staff|helper|support|owner/i.test(r.name));
  if (!staffLike.length) {
    add({ severity: "medium", area: "roles", title: "No clear staff hierarchy", detail: "No roles look like staff (moderator/admin/support).", recommendation: "Create Admin, Moderator and Support roles with scoped permissions." });
    suggestions.roles!.push({ key: "admin", name: "Admin", preset: "manager", color: "#B91C1C", hoist: true }, { key: "moderator", name: "Moderator", preset: "moderator", color: "#F43F5E", hoist: true });
  }
  if (s.verificationLevel === 0) add({ severity: "medium", area: "security", title: "Verification level is None", detail: "Anyone can chat immediately, including brand-new spam accounts.", recommendation: "Raise verification to Medium or enable MOTH verification." });
  if (!has(/rules/)) {
    add({ severity: "medium", area: "onboarding", title: "No rules channel", detail: "Members have nowhere to read the rules.", recommendation: "Add a read-only #rules channel and post rules." });
    suggestions.channels!.push({ key: "rules", name: "📜┃rules", readOnly: true });
  }
  if (!has(/welcome|start|introduc/)) add({ severity: "low", area: "onboarding", title: "No welcome channel", detail: "New members don't get a clear landing place.", recommendation: "Add a welcome channel with an embed and enable welcome messages." });
  if (!has(/log/)) {
    add({ severity: "medium", area: "moderation", title: "No moderation log channel", detail: "Moderator actions aren't recorded anywhere visible.", recommendation: "Add a private #mod-log and point MOTH's moderation logging at it." });
  }
  if (!has(/announce|news|updates/)) add({ severity: "low", area: "structure", title: "No announcements channel", detail: "There's no dedicated place for official news.", recommendation: "Add a read-only announcement channel." });
  const orphans = channels.filter((c) => !c.parentId);
  if (orphans.length > 3) add({ severity: "low", area: "structure", title: "Channels outside categories", detail: `${orphans.length} channels aren't in a category: ${orphans.slice(0, 6).map((c) => `#${c.name}`).join(", ")}.`, recommendation: "Group them into categories so navigation stays tidy." });
  const empty = cats.filter((c) => !channels.some((ch) => ch.parentId === c.id));
  if (empty.length) add({ severity: "info", area: "structure", title: "Empty categories", detail: `${empty.map((c) => c.name).join(", ")} contain no channels.`, recommendation: "Remove them or add channels." });
  const dupes = new Map<string, number>();
  for (const c of channels) dupes.set(normaliseName(c.name), (dupes.get(normaliseName(c.name)) ?? 0) + 1);
  const dup = [...dupes.entries()].filter(([k, n]) => n > 1 && k);
  if (dup.length) add({ severity: "low", area: "structure", title: "Duplicate channel names", detail: `Duplicated: ${dup.map(([k]) => k).join(", ")}.`, recommendation: "Rename or merge duplicates to avoid confusion." });
  const inactive = channels.filter((c) => c.type === "text" && c.recentMessages === 0);
  if (inactive.length >= 3) add({ severity: "low", area: "engagement", title: "Inactive channels", detail: `${inactive.length} text channels had no messages in 30 days: ${inactive.slice(0, 8).map((c) => `#${c.name}`).join(", ")}.`, recommendation: "Archive or remove unused channels to concentrate activity." });
  if (channels.length > 80) add({ severity: "low", area: "structure", title: "Very large channel list", detail: `${channels.length} channels can overwhelm new members.`, recommendation: "Consolidate related channels or use forums/threads." });
  const unsorted = s.roles.filter((r) => !r.everyone && !r.managed && r.color === 0 && r.hoist);
  if (unsorted.length > 2) add({ severity: "info", area: "branding", title: "Hoisted roles without colours", detail: `${unsorted.map((r) => r.name).join(", ")} are displayed separately but have no colour.`, recommendation: "Give hoisted roles a consistent colour palette." });

  if (cfg) {
    if (!cfg.automod.enabled) add({ severity: "medium", area: "moderation", title: "Auto-moderation is off", detail: "Spam, mass mentions and invite links aren't filtered.", recommendation: "Enable MOTH auto-moderation with the Balanced preset." });
    if (!cfg.security.enabled) add({ severity: "high", area: "security", title: "Anti-raid protection is off", detail: "Join spikes and raids won't be detected.", recommendation: "Enable security with Medium sensitivity." });
    if (!cfg.welcome.enabled) add({ severity: "low", area: "onboarding", title: "Welcome messages are off", detail: "New members aren't greeted.", recommendation: "Enable welcome messages." });
    if (!cfg.general.modLogChannelId) add({ severity: "low", area: "moderation", title: "MOTH mod-log not configured", detail: "Automated actions aren't being logged to a channel.", recommendation: "Set a moderation log channel in Server Settings." });
    if (!cfg.tickets.enabled) add({ severity: "info", area: "engagement", title: "No ticket system", detail: "Members have no private way to contact staff.", recommendation: "Set up a ticket panel." });
    if (!cfg.automod.enabled) suggestions.features!.moderation = { preset: "balanced" };
    if (!cfg.security.enabled) suggestions.features!.security = { sensitivity: "medium" };
  }

  const weights = { critical: 25, high: 15, medium: 8, low: 4, info: 1 } as const;
  const score = Math.max(0, 100 - findings.reduce((n, f) => n + weights[f.severity], 0));
  const order = ["critical", "high", "medium", "low", "info"];
  findings.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
  const summary = findings.length
    ? `Health score ${score}/100. ${findings.filter((f) => ["critical", "high"].includes(f.severity)).length} high-priority and ${findings.filter((f) => f.severity === "medium").length} medium-priority issues found.`
    : `Health score ${score}/100. This server is in great shape.`;
  return { score, summary, findings, suggestions };
}

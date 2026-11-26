import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPlan, designFromPrompt, analyzeServer, parseDuration, renderTemplate, levelFromXp, xpForLevel,
  defaultGuildConfig, parseGuildConfig, encryptSecret, decryptSecret, extractJson, matchesTrigger,
  customCommandSchema, automationSchema, cronFromText, BUILTIN_TEMPLATES, builtinTemplate, snapshotToBlueprint, toBits, fromBits,
  type GuildSnapshot,
} from "../index.js";

const GUILD = "100000000000000001";
const freshSnapshot = (): GuildSnapshot => ({
  id: GUILD, name: "Test", ownerId: "200000000000000001", memberCount: 3, verificationLevel: 0, capturedAt: new Date().toISOString(),
  botRoleId: "300000000000000009", botHighestPosition: 5,
  roles: [
    { id: GUILD, name: "@everyone", color: 0, hoist: false, mentionable: false, permissions: toBits(["ViewChannel", "SendMessages", "ReadMessageHistory"]).toString(), position: 0, managed: false, everyone: true },
    { id: "300000000000000009", name: "MOTH", color: 0, hoist: false, mentionable: false, permissions: toBits(["Administrator"]).toString(), position: 5, managed: true },
  ],
  channels: [
    { id: "400000000000000001", name: "Text Channels", type: "category", parentId: null, position: 0, overwrites: [] },
    { id: "400000000000000002", name: "general", type: "text", parentId: "400000000000000001", position: 0, overwrites: [] },
    { id: "400000000000000003", name: "Voice Channels", type: "category", parentId: null, position: 1, overwrites: [] },
    { id: "400000000000000004", name: "General", type: "voice", parentId: "400000000000000003", position: 0, overwrites: [] },
  ],
});

test("parseDuration handles compound values", () => {
  assert.equal(parseDuration("1h30m"), 5_400_000);
  assert.equal(parseDuration("2d"), 172_800_000);
  assert.equal(parseDuration("abc"), null);
  assert.equal(parseDuration("10x"), null);
});

test("renderTemplate substitutes placeholders", () => {
  const out = renderTemplate("Hi {user.name} in {server} ({server.members}) {args.thing} {unknown}", {
    user: { id: "1", username: "ana" }, server: { id: "2", name: "Hive", memberCount: 42 }, args: { thing: "x" },
  });
  assert.equal(out, "Hi ana in Hive (42) x {unknown}");
});

test("levels progress monotonically", () => {
  assert.equal(levelFromXp(0).level, 0);
  assert.equal(levelFromXp(xpForLevel(0)).level, 1);
  assert.equal(levelFromXp(xpForLevel(0) + xpForLevel(1)).level, 2);
});

test("guild config defaults & recovery from corrupt sections", () => {
  const d = defaultGuildConfig();
  assert.equal(d.automod.spam.enabled, true);
  assert.equal(d.security.sensitivity, "medium");
  const cfg = parseGuildConfig({ welcome: { enabled: "yes" }, leveling: { enabled: true } });
  assert.equal(cfg.welcome.enabled, false); // corrupt section falls back
  assert.equal(cfg.leveling.enabled, true);
});

test("secrets round-trip through AES-GCM", () => {
  const key = "k".repeat(40);
  const enc = encryptSecret("sk-test-123", key);
  assert.notEqual(enc, "sk-test-123");
  assert.equal(decryptSecret(enc, key), "sk-test-123");
});

test("extractJson finds objects in fenced/prose output", () => {
  assert.deepEqual(extractJson("Sure!\n```json\n{\"a\":1}\n```"), { a: 1 });
  assert.deepEqual(extractJson("prefix {\"a\":{\"b\":\"}\"}} suffix"), { a: { b: "}" } });
});

test("heuristic architect designs the Minecraft example", () => {
  const { blueprint, intent } = designFromPrompt("I want a professional gaming community for Minecraft with staff applications, support tickets, announcements, game-specific channels and a friendly community.");
  assert.equal(intent.kind, "gaming");
  assert.ok(intent.topics.includes("Minecraft"));
  assert.ok(blueprint.roles.some((r) => r.key === "moderator"));
  assert.ok(blueprint.features.tickets?.[0].categories.some((c) => c.label === "Staff Application"));
  assert.ok(blueprint.categories.some((c) => /MINECRAFT/i.test(c.name)));
});

test("plan for a fresh guild creates structure and prunes defaults", () => {
  const { blueprint } = designFromPrompt("gaming community for valorant with tickets and verification");
  const plan = buildPlan(freshSnapshot(), blueprint, { mode: "create" });
  assert.ok(plan.summary.creates > 10);
  assert.ok(plan.ops.some((o) => o.kind === "ticketpanel.create"));
  assert.ok(plan.ops.some((o) => o.kind === "verification.publish"));
  assert.ok(plan.ops.some((o) => o.kind === "config.update"));
  // The default "general" text channel is matched/reused, not deleted.
  assert.ok(!plan.ops.some((o) => o.kind === "channel.delete" && o.channelId === "400000000000000002"));
  // Managed bot role is never deleted.
  assert.ok(!plan.ops.some((o) => o.kind === "role.delete" && o.roleId === "300000000000000009"));
  // Verification hides channels from @everyone, which is non-destructive in create mode.
  const ev = plan.ops.find((o) => o.kind === "role.update" && o.ref === "@everyone");
  assert.ok(ev && !ev.destructive);
});

test("quick edits never delete implicitly", () => {
  const snap = freshSnapshot();
  const plan = buildPlan(snap, { categories: [{ name: "Gaming", channels: [{ name: "lfg" }] }] }, { mode: "quick" });
  assert.equal(plan.summary.deletes, 0);
  assert.equal(plan.summary.creates, 2);
  const removal = buildPlan(snap, { removals: { channels: ["general"] } }, { mode: "quick" });
  assert.equal(removal.summary.deletes, 1);
  assert.ok(removal.ops[0].destructive);
});

test("existing channel permissions are preserved when merging", () => {
  const snap = freshSnapshot();
  snap.channels[1].overwrites = [{ id: "500000000000000001", type: "member", allow: toBits(["ManageMessages"]).toString(), deny: "0" }];
  const plan = buildPlan(snap, { channels: [{ name: "general", readOnly: true }] }, { mode: "quick" });
  const up = plan.ops.find((o) => o.kind === "channel.update");
  assert.ok(up && up.kind === "channel.update" && up.overwrites);
  assert.ok(up.overwrites.some((o) => o.target === "member:500000000000000001"));
  assert.ok(up.overwrites.some((o) => o.target === "@everyone" && o.deny.includes("SendMessages")));
});

test("analyzer flags dangerous @everyone permissions", () => {
  const snap = freshSnapshot();
  snap.roles[0].permissions = toBits(["Administrator", "ViewChannel"]).toString();
  const a = analyzeServer(snap, defaultGuildConfig());
  assert.equal(a.findings[0].severity, "critical");
  assert.ok(a.score < 80);
});

test("all builtin templates produce valid plans", () => {
  for (const t of BUILTIN_TEMPLATES) {
    const bp = builtinTemplate(t.id)!;
    const plan = buildPlan(freshSnapshot(), bp, { mode: "create" });
    assert.ok(plan.ops.length > 5, t.id);
  }
});

test("snapshot export round-trips into a plan without changes", () => {
  const snap = freshSnapshot();
  const plan = buildPlan(snap, snapshotToBlueprint(snap), { mode: "quick" });
  assert.equal(plan.summary.creates, 0);
  assert.equal(plan.summary.deletes, 0);
});

test("permission bit helpers", () => {
  assert.deepEqual(fromBits(toBits(["KickMembers", "BanMembers"])), ["KickMembers", "BanMembers"]);
});

test("custom command & automation schemas apply defaults", () => {
  const c = customCommandSchema.parse({ type: "trigger", trigger: { match: "contains", pattern: "hello" } });
  assert.ok(matchesTrigger(c, "well HELLO there"));
  const a = automationSchema.parse({ trigger: { type: "member_join" }, steps: [{ kind: "action", action: { type: "add_role", roleId: "1" } }] });
  assert.equal(a.cooldownSeconds, 0);
  assert.ok(a.steps[0].id);
});

test("schedule phrases become cron expressions", () => {
  assert.equal(cronFromText("every friday at 6pm post a reminder"), "0 18 * * 5");
  assert.equal(cronFromText("daily at 09:30"), "30 9 * * *");
  assert.equal(cronFromText("every monday and thursday at 8 pm"), "0 20 * * 1,4");
  assert.equal(cronFromText("on weekdays at 7am"), "0 7 * * 1-5");
  assert.equal(cronFromText("when someone says hello"), null);
});

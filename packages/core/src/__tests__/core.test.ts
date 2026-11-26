import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPlan, designFromPrompt, analyzeServer, parseDuration, renderTemplate, levelFromXp, xpForLevel,
  defaultGuildConfig, parseGuildConfig, encryptSecret, decryptSecret, extractJson, matchesTrigger,
  customCommandSchema, automationSchema, cronFromText, sanitizePlaceholders, BUILTIN_TEMPLATES, builtinTemplate, snapshotToBlueprint, toBits, fromBits,
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

test("full redesign can remove other bots; quick edits only when asked", () => {
  const snap = freshSnapshot();
  snap.bots = [{ id: "700000000000000001", name: "MEE6", kickable: true }, { id: "700000000000000002", name: "Dyno", kickable: false }];
  const plan = buildPlan(snap, { categories: [{ name: "Chat", channels: [{ name: "general" }] }] }, { mode: "redesign", prune: true, removeBots: true });
  const bots = plan.ops.filter((o) => o.kind === "bot.remove");
  assert.equal(bots.length, 1); // Dyno is above MOTH → warning instead
  assert.ok(bots[0].destructive);
  assert.ok(plan.warnings.some((w) => w.includes("Dyno")));
  assert.ok(plan.ops.some((o) => o.kind === "channel.delete" && o.name === "General"));
  const quick = buildPlan(snap, { removals: { bots: ["mee6"] } }, { mode: "quick" });
  assert.equal(quick.ops.filter((o) => o.kind === "bot.remove").length, 1);
  assert.equal(buildPlan(snap, { channels: [{ name: "lfg" }] }, { mode: "quick" }).ops.filter((o) => o.kind === "bot.remove").length, 0);
});

test("design briefs from a (fake) small model build full blueprints", async () => {
  const { blueprintFromBrief, blueprintFromEditBrief } = await import("../index.js");
  const fake = (answer: unknown) => ({ config: { kind: "ollama" }, completeJson: async (_m: unknown, schema: { parse: (x: unknown) => unknown }) => ({ data: schema.parse(answer), usage: { text: "", inputTokens: 1, outputTokens: 1, model: "fake" } }) }) as never;
  const r = await blueprintFromBrief(fake({ kind: "Gaming", topics: ["Valorant"], features: ["tickets", "Leveling", "nonsense"], extra_sections: [{ name: "Tournaments", channels: ["brackets", { name: "Match Voice", type: "voice" }] }], reply: "A competitive Valorant hub." }), "valorant server with tournaments");
  assert.ok(r.blueprint.categories.some((c) => /TOURNAMENTS/.test(c.name) && c.channels.some((ch) => ch.type === "voice")));
  assert.ok(r.blueprint.features.tickets?.length);
  assert.ok(r.blueprint.features.leveling);
  assert.ok(r.reply.startsWith("A competitive Valorant hub."));
  const snap = freshSnapshot();
  const e = await blueprintFromEditBrief(fake({ add_sections: [{ name: "Music", channels: [{ name: "Song Requests" }] }], remove_channels: ["general", "does-not-exist"], features: ["tickets"] }), "add a music section", "", snap);
  assert.equal(e.blueprint.categories!.length, 1);
  assert.deepEqual(e.blueprint.removals!.channels, []); // not asked to remove → ignored
  assert.match(e.featurePhrase, /ticket/);
  const e2 = await blueprintFromEditBrief(fake({ remove_channels: ["general", "does-not-exist"] }), "remove the general channel", "", snap);
  assert.deepEqual(e2.blueprint.removals!.channels, ["general"]); // only existing things
});

test("generated text keeps only real placeholders", () => {
  assert.equal(sanitizePlaceholders("Hi {user}, see #{general} on {server}"), "Hi {user}, see #general on {server}");
  assert.equal(sanitizePlaceholders("IP: {server}play.example.com {random:a|b}"), "IP: play.example.com {random:a|b}");
});

// ───────── Recipes & setup packs ─────────
import { RECIPES, buildRecipe } from "../automation/recipes.js";
import { SETUP_PACKS, setupRecommendations } from "../setup/packs.js";
import { automationSchema as autoSchema } from "../automation/schema.js";
import { defaultGuildConfig as defaults, guildConfigSchema as cfgSchema } from "../guild-config.js";
import { deepMerge as merge } from "../util.js";

test("every recipe builds valid automations", () => {
  const fake: Record<string, string> = { channel: "111111111111111111", voice: "222222222222222222", role: "333333333333333333" };
  for (const r of RECIPES) {
    const params = Object.fromEntries(r.params.map((p) => [p.key, fake[p.kind] ?? (p.default !== undefined ? String(p.default) : "test")]));
    const out = buildRecipe(r.key, params);
    assert.ok(out.length >= 1, r.key);
    for (const o of out) {
      const parsed = autoSchema.safeParse(o.definition);
      assert.ok(parsed.success, `${r.key}: ${parsed.success ? "" : JSON.stringify(parsed.error.issues[0])}`);
    }
  }
});

test("recipes reject missing required inputs", () => {
  assert.throws(() => buildRecipe("delayed-member-role", {}), /required/);
});

test("recipe schedules use the requested time and days", () => {
  const [o] = buildRecipe("weekly-event", { channel: "111111111111111111", days: "mon, wed", time: "19:30", tz: "Europe/London", text: "Hi" });
  assert.deepEqual(o.definition.trigger, { type: "schedule", cron: "30 19 * * 1,3", timezone: "Europe/London" });
});

test("every setup pack produces a valid config", () => {
  for (const p of SETUP_PACKS) {
    const ids = Object.fromEntries([...p.channels, ...p.roles].map((x, i) => [x.key, String(100000000000000000n + BigInt(i))]));
    const patch = p.config(ids, defaults());
    const next = merge(defaults(), patch);
    const parsed = cfgSchema.safeParse(next);
    assert.ok(parsed.success, `${p.key}: ${parsed.success ? "" : JSON.stringify(parsed.error.issues[0])}`);
  }
});

test("recommendations clear once the essentials pack is applied", () => {
  const c = defaults();
  assert.ok(setupRecommendations(c).some((r) => r.key === "logs"));
  const p = SETUP_PACKS.find((x) => x.key === "essentials")!;
  const ids = Object.fromEntries(p.channels.map((x, i) => [x.key, String(100000000000000000n + BigInt(i))]));
  const after = setupRecommendations(merge(c, p.config(ids, c)));
  assert.ok(!after.some((r) => ["logs", "logging", "automod", "security"].includes(r.key)));
});

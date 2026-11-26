import { PermissionFlagsBits, SlashCommandBuilder, type TextBasedChannel } from "discord.js";
import { and, desc, eq, sql } from "drizzle-orm";
import { ACHIEVEMENTS, economyAccounts, getDb, getGuildConfig, giveaways, levelFromXp, memberLevels, parseDuration, userAchievements, formatDuration } from "@moth/core";
import type { SlashCommand } from "./types.js";
import { claimDaily, getAccount, transfer, addCurrency } from "../modules/economy.js";
import { startGiveaway, endGiveaway } from "../modules/giveaways.js";
import { createPoll } from "../modules/polls.js";
import { checkAchievements } from "../modules/achievements.js";
import { brandEmbed, ok, fail } from "../lib/embeds.js";
import { hasAccess } from "../lib/permissions.js";

const bar = (cur: number, max: number, len = 16) => { const f = Math.round((cur / Math.max(1, max)) * len); return "█".repeat(f) + "░".repeat(len - f); };

export const communityCommands: SlashCommand[] = [
  {
    data: new SlashCommandBuilder().setName("rank").setDescription("Show your level").setDMPermission(false).addUserOption((o) => o.setName("user").setDescription("User")).toJSON(),
    async execute(i) {
      const u = i.options.getUser("user") ?? i.user;
      const db = getDb();
      const [row] = await db.select().from(memberLevels).where(and(eq(memberLevels.guildId, i.guildId), eq(memberLevels.userId, u.id)));
      const xp = row?.xp ?? 0; const l = levelFromXp(xp);
      const [{ rank }] = await db.select({ rank: sql<number>`count(*) + 1` }).from(memberLevels).where(and(eq(memberLevels.guildId, i.guildId), sql`${memberLevels.xp} > ${xp}`));
      await i.reply({ embeds: [brandEmbed(`${u.username} · Level ${l.level}`, `**Rank:** #${rank}\n**XP:** ${l.current} / ${l.needed}\n\`${bar(l.current, l.needed)}\`\n**Messages:** ${row?.messages ?? 0} · **Voice:** ${Math.round((row?.voiceMinutes ?? 0) / 60)}h`).setThumbnail(u.displayAvatarURL())] });
    },
  },
  {
    data: new SlashCommandBuilder().setName("leaderboard").setDescription("Server leaderboard").setDMPermission(false)
      .addStringOption((o) => o.setName("type").setDescription("Board").addChoices({ name: "XP", value: "xp" }, { name: "Economy", value: "economy" }, { name: "Messages", value: "messages" })).toJSON(),
    async execute(i) {
      const type = i.options.getString("type") ?? "xp";
      const db = getDb();
      const medal = (n: number) => ["🥇", "🥈", "🥉"][n] ?? `**${n + 1}.**`;
      let lines: string[];
      if (type === "economy") {
        const cfg = await getGuildConfig(i.guildId);
        const rows = await db.select().from(economyAccounts).where(eq(economyAccounts.guildId, i.guildId)).orderBy(desc(economyAccounts.balance)).limit(10);
        lines = rows.map((r, n) => `${medal(n)} <@${r.userId}> — ${cfg.economy.currencyEmoji} ${r.balance.toLocaleString()}`);
      } else {
        const rows = await db.select().from(memberLevels).where(eq(memberLevels.guildId, i.guildId)).orderBy(desc(type === "messages" ? memberLevels.messages : memberLevels.xp)).limit(10);
        lines = rows.map((r, n) => `${medal(n)} <@${r.userId}> — ${type === "messages" ? `${r.messages.toLocaleString()} messages` : `Level ${levelFromXp(r.xp).level} · ${r.xp.toLocaleString()} XP`}`);
      }
      await i.reply({ embeds: [brandEmbed(`🏆 ${i.guild.name} · ${type === "xp" ? "Levels" : type === "economy" ? "Richest" : "Most active"}`, lines.join("\n") || "Nobody yet — start chatting!")], allowedMentions: { parse: [] } });
    },
  },
  {
    data: new SlashCommandBuilder().setName("profile").setDescription("View a member profile").setDMPermission(false).addUserOption((o) => o.setName("user").setDescription("User")).toJSON(),
    async execute(i) {
      const u = i.options.getUser("user") ?? i.user;
      const member = await i.guild.members.fetch(u.id).catch(() => null);
      if (member && u.id === i.user.id) await checkAchievements(member, null, true);
      const db = getDb();
      const cfg = await getGuildConfig(i.guildId);
      const [[lv], [eco], achs] = await Promise.all([
        db.select().from(memberLevels).where(and(eq(memberLevels.guildId, i.guildId), eq(memberLevels.userId, u.id))),
        db.select().from(economyAccounts).where(and(eq(economyAccounts.guildId, i.guildId), eq(economyAccounts.userId, u.id))),
        db.select().from(userAchievements).where(and(eq(userAchievements.guildId, i.guildId), eq(userAchievements.userId, u.id))),
      ]);
      const badges = achs.map((a) => ACHIEVEMENTS.find((x) => x.key === a.key)).filter(Boolean).map((a) => `${a!.icon} ${a!.name}`);
      const e = brandEmbed(member?.displayName ?? u.username).setThumbnail(u.displayAvatarURL({ size: 256 })).addFields(
        { name: "Level", value: `${levelFromXp(lv?.xp ?? 0).level}`, inline: true }, { name: "XP", value: `${(lv?.xp ?? 0).toLocaleString()}`, inline: true },
        { name: "Messages", value: `${(lv?.messages ?? 0).toLocaleString()}`, inline: true },
        ...(cfg.economy.enabled ? [{ name: "Balance", value: `${cfg.economy.currencyEmoji} ${(eco?.balance ?? 0).toLocaleString()}`, inline: true }, { name: "Daily streak", value: `🔥 ${eco?.streak ?? 0}`, inline: true }] : []),
        { name: "Joined", value: member?.joinedAt ? `<t:${Math.floor(member.joinedAt.getTime() / 1000)}:R>` : "—", inline: true },
        { name: `Achievements (${badges.length}/${ACHIEVEMENTS.length})`, value: badges.join(" · ").slice(0, 1024) || "None yet" },
      );
      await i.reply({ embeds: [e] });
    },
  },
  {
    data: new SlashCommandBuilder().setName("daily").setDescription("Claim your daily reward").setDMPermission(false).toJSON(),
    async execute(i) {
      const cfg = await getGuildConfig(i.guildId);
      if (!cfg.economy.enabled) return void i.reply({ embeds: [fail("The economy is disabled on this server.")], ephemeral: true });
      const r = await claimDaily(i.guildId, i.user.id, cfg.economy.dailyAmount, cfg.economy.streakBonus, cfg.economy.maxStreakBonusDays);
      if (!r.ok) return void i.reply({ embeds: [fail(`Already claimed — come back <t:${Math.floor(r.nextAt.getTime() / 1000)}:R>.`)], ephemeral: true });
      await i.reply({ embeds: [ok(`You claimed **${cfg.economy.currencyEmoji} ${r.amount}** ${cfg.economy.currencyName}! 🔥 Streak: **${r.streak}** · Balance: **${r.balance.toLocaleString()}**`)] });
      void checkAchievements(i.member, i.channel, true);
    },
  },
  {
    data: new SlashCommandBuilder().setName("balance").setDescription("Check a balance").setDMPermission(false).addUserOption((o) => o.setName("user").setDescription("User")).toJSON(),
    async execute(i) {
      const cfg = await getGuildConfig(i.guildId);
      if (!cfg.economy.enabled) return void i.reply({ embeds: [fail("The economy is disabled on this server.")], ephemeral: true });
      const u = i.options.getUser("user") ?? i.user;
      const a = await getAccount(i.guildId, u.id);
      await i.reply({ embeds: [brandEmbed(`${u.username}'s wallet`, `${cfg.economy.currencyEmoji} **${a.balance.toLocaleString()}** ${cfg.economy.currencyName}\nLifetime earned: ${a.lifetimeEarned.toLocaleString()}`)] });
    },
  },
  {
    data: new SlashCommandBuilder().setName("pay").setDescription("Send currency to someone").setDMPermission(false)
      .addUserOption((o) => o.setName("user").setDescription("Recipient").setRequired(true)).addIntegerOption((o) => o.setName("amount").setDescription("Amount").setMinValue(1).setRequired(true)).toJSON(),
    async execute(i) {
      const cfg = await getGuildConfig(i.guildId);
      if (!cfg.economy.enabled) return void i.reply({ embeds: [fail("The economy is disabled.")], ephemeral: true });
      const to = i.options.getUser("user", true); const amount = i.options.getInteger("amount", true);
      if (to.id === i.user.id || to.bot) return void i.reply({ embeds: [fail("Invalid recipient.")], ephemeral: true });
      if (!(await transfer(i.guildId, i.user.id, to.id, amount))) return void i.reply({ embeds: [fail("Insufficient funds.")], ephemeral: true });
      await i.reply({ embeds: [ok(`Sent ${cfg.economy.currencyEmoji} **${amount.toLocaleString()}** to <@${to.id}>.`)] });
    },
  },
  {
    data: new SlashCommandBuilder().setName("shop").setDescription("Browse or buy from the server shop").setDMPermission(false)
      .addStringOption((o) => o.setName("buy").setDescription("Item ID to buy")).toJSON(),
    async execute(i) {
      const cfg = await getGuildConfig(i.guildId);
      if (!cfg.economy.enabled) return void i.reply({ embeds: [fail("The economy is disabled.")], ephemeral: true });
      const id = i.options.getString("buy");
      if (!id) return void i.reply({ embeds: [brandEmbed("🛒 Shop", cfg.economy.shop.map((s) => `\`${s.id}\` **${s.name}** — ${cfg.economy.currencyEmoji} ${s.price.toLocaleString()}${s.roleId ? ` · <@&${s.roleId}>` : ""}${s.description ? `\n${s.description}` : ""}`).join("\n\n") || "The shop is empty. Admins can add items in the dashboard.")] });
      const item = cfg.economy.shop.find((s) => s.id === id);
      if (!item) return void i.reply({ embeds: [fail("Unknown item.")], ephemeral: true });
      if (item.roleId && i.member.roles.cache.has(item.roleId)) return void i.reply({ embeds: [fail("You already own this.")], ephemeral: true });
      const acc = await getAccount(i.guildId, i.user.id);
      if (acc.balance < item.price) return void i.reply({ embeds: [fail("Insufficient funds.")], ephemeral: true });
      await addCurrency(i.guildId, i.user.id, -item.price);
      if (item.roleId) await i.member.roles.add(item.roleId, "Shop purchase").catch(async () => { await addCurrency(i.guildId, i.user.id, item.price); throw new Error("Couldn't grant role — refunded."); });
      await i.reply({ embeds: [ok(`You bought **${item.name}**!`)] });
    },
  },
  {
    data: new SlashCommandBuilder().setName("giveaway").setDescription("Run giveaways").setDMPermission(false)
      .addSubcommand((s) => s.setName("start").setDescription("Start a giveaway")
        .addStringOption((o) => o.setName("prize").setDescription("Prize").setRequired(true).setMaxLength(200))
        .addStringOption((o) => o.setName("duration").setDescription("e.g. 1h, 2d").setRequired(true))
        .addIntegerOption((o) => o.setName("winners").setDescription("Number of winners").setMinValue(1).setMaxValue(20))
        .addRoleOption((o) => o.setName("required_role").setDescription("Role required to enter"))
        .addIntegerOption((o) => o.setName("min_level").setDescription("Minimum level to enter").setMinValue(1))
        .addStringOption((o) => o.setName("description").setDescription("Description").setMaxLength(1000)))
      .addSubcommand((s) => s.setName("end").setDescription("End a giveaway now").addStringOption((o) => o.setName("id").setDescription("Giveaway").setRequired(true).setAutocomplete(true)))
      .addSubcommand((s) => s.setName("reroll").setDescription("Reroll winners").addStringOption((o) => o.setName("id").setDescription("Giveaway").setRequired(true).setAutocomplete(true))).toJSON(),
    async autocomplete(i) {
      const rows = await getDb().select().from(giveaways).where(eq(giveaways.guildId, i.guildId)).orderBy(desc(giveaways.createdAt)).limit(25);
      await i.respond(rows.map((g) => ({ name: `${g.ended ? "[ended] " : ""}${g.prize}`.slice(0, 100), value: g.id })));
    },
    async execute(i) {
      const cfg = await getGuildConfig(i.guildId);
      if (!cfg.community.giveawaysEnabled) return void i.reply({ embeds: [fail("Giveaways are disabled.")], ephemeral: true });
      const allowed = i.member.permissions.has(PermissionFlagsBits.ManageGuild) || cfg.community.giveawayManagerRoleIds.some((r) => i.member.roles.cache.has(r)) || await hasAccess(i.member, "moderator");
      if (!allowed) return void i.reply({ embeds: [fail("You can't manage giveaways.")], ephemeral: true });
      const sub = i.options.getSubcommand();
      if (sub === "start") {
        const ms = parseDuration(i.options.getString("duration", true));
        if (!ms || ms < 30_000) return void i.reply({ embeds: [fail("Invalid duration (min 30s).")], ephemeral: true });
        if (!i.channel || !("send" in i.channel)) return;
        await startGiveaway(i.channel as TextBasedChannel & { send: Function }, { guildId: i.guildId, prize: i.options.getString("prize", true), description: i.options.getString("description") ?? undefined, winners: i.options.getInteger("winners") ?? 1, durationMs: ms, hostId: i.user.id, requiredRoleId: i.options.getRole("required_role")?.id, minLevel: i.options.getInteger("min_level") });
        return void i.reply({ embeds: [ok(`Giveaway started — ends in ${formatDuration(ms)}.`)], ephemeral: true });
      }
      await i.deferReply({ ephemeral: true });
      try { const w = await endGiveaway(i.guild, i.options.getString("id", true), sub === "reroll"); await i.editReply({ embeds: [ok(`Winners: ${w.map((x) => `<@${x}>`).join(", ") || "none"}`)] }); }
      catch (err) { await i.editReply({ embeds: [fail((err as Error).message)] }); }
    },
  },
  {
    data: new SlashCommandBuilder().setName("poll").setDescription("Create a poll").setDMPermission(false)
      .addStringOption((o) => o.setName("question").setDescription("Question").setRequired(true).setMaxLength(250))
      .addStringOption((o) => o.setName("options").setDescription("Options separated by | (2–10)").setRequired(true))
      .addStringOption((o) => o.setName("duration").setDescription("e.g. 1h (optional)"))
      .addBooleanOption((o) => o.setName("multiple").setDescription("Allow multiple choices")).toJSON(),
    async execute(i) {
      const cfg = await getGuildConfig(i.guildId);
      if (!cfg.community.pollsEnabled) return void i.reply({ embeds: [fail("Polls are disabled.")], ephemeral: true });
      const options = i.options.getString("options", true).split("|").map((s) => s.trim()).filter(Boolean);
      if (options.length < 2 || options.length > 10) return void i.reply({ embeds: [fail("Provide 2–10 options separated by |")], ephemeral: true });
      const d = i.options.getString("duration"); const ms = d ? parseDuration(d) : null;
      if (d && !ms) return void i.reply({ embeds: [fail("Invalid duration.")], ephemeral: true });
      if (!i.channel || !("send" in i.channel)) return;
      await createPoll(i.channel as TextBasedChannel & { send: Function }, { guildId: i.guildId, question: i.options.getString("question", true), options, multiple: !!i.options.getBoolean("multiple"), creatorId: i.user.id, durationMs: ms });
      await i.reply({ embeds: [ok("Poll created.")], ephemeral: true });
    },
  },
];

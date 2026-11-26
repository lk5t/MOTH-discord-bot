import { PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { getGuildConfig, resolveAIClient, userHistory, recordAIUsage, buildPersonalityPrompt } from "@moth/core";
import type { SlashCommand } from "./types.js";
import { askAI, canUseAI, summarizeChannel } from "../modules/ai.js";
import { brandEmbed, BRAND, fail } from "../lib/embeds.js";

export const aiCommands: SlashCommand[] = [
  {
    data: new SlashCommandBuilder().setName("ask").setDescription("Ask the MOTH AI assistant").setDMPermission(false)
      .addStringOption((o) => o.setName("question").setDescription("Your question").setRequired(true).setMaxLength(2000))
      .addBooleanOption((o) => o.setName("private").setDescription("Only you can see the answer")).toJSON(),
    async execute(i) {
      const cfg = await getGuildConfig(i.guildId);
      const denied = await canUseAI(i.member, cfg);
      if (denied) return void i.reply({ embeds: [fail(denied)], ephemeral: true });
      await i.deferReply({ ephemeral: !!i.options.getBoolean("private") });
      try {
        const q = i.options.getString("question", true);
        const a = await askAI(i.guild, i.member, q, [], "ask");
        await i.editReply({ embeds: [brandEmbed(undefined, a.slice(0, 4000)).setAuthor({ name: `${i.member.displayName} asked: ${q.slice(0, 200)}`, iconURL: i.user.displayAvatarURL() }).setFooter({ text: `${cfg.ai.personality.name} · AI-generated, may be inaccurate` })] });
      } catch (err) { await i.editReply({ embeds: [fail(`AI error: ${(err as Error).message.slice(0, 300)}`)] }); }
    },
  },
  {
    data: new SlashCommandBuilder().setName("summarize").setDescription("Summarise recent messages in this channel").setDMPermission(false)
      .addIntegerOption((o) => o.setName("messages").setDescription("How many (10–100)").setMinValue(10).setMaxValue(100)).toJSON(),
    async execute(i) {
      const cfg = await getGuildConfig(i.guildId);
      const denied = await canUseAI(i.member, cfg);
      if (denied || !i.channel) return void i.reply({ embeds: [fail(denied ?? "Unavailable here.")], ephemeral: true });
      await i.deferReply({ ephemeral: true });
      try { await i.editReply({ embeds: [brandEmbed(`Summary of the last ${i.options.getInteger("messages") ?? 50} messages`, (await summarizeChannel(i.channel, i.member, i.options.getInteger("messages") ?? 50)).slice(0, 4000))] }); }
      catch (err) { await i.editReply({ embeds: [fail(`AI error: ${(err as Error).message.slice(0, 300)}`)] }); }
    },
  },
  {
    data: new SlashCommandBuilder().setName("modassist").setDescription("AI moderation recommendation for a user (advisory only)").setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers).setDMPermission(false)
      .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true))
      .addStringOption((o) => o.setName("context").setDescription("What happened?").setMaxLength(1000)).toJSON(),
    access: "moderator",
    async execute(i) {
      const cfg = await getGuildConfig(i.guildId);
      const ai = await resolveAIClient(i.guildId, cfg.ai.providerId);
      if (!ai) return void i.reply({ embeds: [fail("No AI provider configured.")], ephemeral: true });
      await i.deferReply({ ephemeral: true });
      const u = i.options.getUser("user", true);
      const history = await userHistory(i.guildId, u.id, 15);
      const recent = i.channel ? [...(await i.channel.messages.fetch({ limit: 100 })).filter((m) => m.author.id === u.id).values()].slice(0, 15).map((m) => m.content.slice(0, 200)) : [];
      const r = await ai.complete([
        { role: "system", content: `${buildPersonalityPrompt(cfg.ai, i.guild.name)}\nYou advise moderators. Recommend a proportionate action (none / note / warn / timeout with duration / kick / ban) based on the server's escalation policy: ${JSON.stringify(cfg.moderation.escalation)}. Explain your reasoning briefly. You cannot take actions yourself.` },
        { role: "user", content: `User: ${u.username}\nAccount age: ${Math.round((Date.now() - u.createdTimestamp) / 86_400_000)} days\nModeration history:\n${history.map((c) => `- #${c.caseNumber} ${c.type}: ${c.reason} (${c.createdAt.toISOString().slice(0, 10)})`).join("\n") || "none"}\nRecent messages in this channel:\n${recent.join("\n") || "none"}\nModerator context: ${i.options.getString("context") ?? "none"}` },
      ], { maxTokens: 500 });
      await recordAIUsage({ guildId: i.guildId, userId: i.user.id, feature: "modassist", inputTokens: r.inputTokens, outputTokens: r.outputTokens, providerKind: ai.config.kind });
      await i.editReply({ embeds: [brandEmbed(`🤖 Recommendation · ${u.username}`, r.text.slice(0, 4000), BRAND.info).setFooter({ text: "Advisory only — MOTH never acts on AI recommendations without a moderator" })] });
    },
  },
];

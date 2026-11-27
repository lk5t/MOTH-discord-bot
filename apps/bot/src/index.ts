import { AuditLogEvent, Client, Events, GatewayIntentBits, Options, Partials } from "discord.js";
import { EventSubscriber, closeDb, ensureGuild, getDb, guilds, invalidateGuildConfig, runMigrations, startHeartbeat, waitForDatabase, publishEvent, memberLevels } from "@moth/core";
import { eq, sql } from "drizzle-orm";
import { env } from "./env.js";
import { log, runtime } from "./context.js";
import { handleInteraction } from "./interactions.js";
import { scheduleGuildCommandSync, syncAllCommands, syncGuildCommands } from "./sync.js";
import { startInternalApi } from "./internal/api.js";
import { analytics } from "./modules/analytics.js";
import { checkMessage } from "./modules/automod.js";
import { onMemberJoin as securityJoin, trackDestructive } from "./modules/security.js";
import { onJoin, onLeave } from "./modules/welcome.js";
import { handleMessageXp } from "./modules/leveling.js";
import { fireAutomations, invalidateAutomations, startScheduledAutomations } from "./modules/automation.js";
import { invalidateCustomCommands, runTriggerCommands } from "./modules/customCommands.js";
import { onReaction } from "./modules/roleMenus.js";
import { handleAIMessage } from "./modules/ai.js";
import { trackTicketActivity } from "./modules/tickets.js";
import { startScheduler, stopScheduler } from "./modules/scheduler.js";
import { addCurrency } from "./modules/economy.js";
import { getGuildConfig } from "@moth/core";
import * as serverLogs from "./modules/serverLogs.js";
import { loadTempVoice, onTempVoiceDeleted, onTempVoiceState } from "./modules/tempVoice.js";
import { handleSuggestionMessage } from "./modules/suggestions.js";
import { dehoist, rememberRoles, restoreRoles, scheduleAutopilot, welcomeNewGuild } from "./modules/autopilot.js";
import { onStarboardReaction } from "./modules/starboard.js";
import { applyChannelRules, handleSticky, refreshStickies, updateStatsChannels } from "./modules/channelTools.js";

process.on("unhandledRejection", (err) => log.error({ err }, "unhandled rejection"));
process.on("uncaughtException", (err) => { log.fatal({ err }, "uncaught exception — exiting for supervisor restart"); process.exit(1); });

await waitForDatabase();
await runMigrations();
log.info("database ready");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildModeration, GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessageReactions, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.DirectMessages, GatewayIntentBits.GuildInvites,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.GuildMember, Partials.User],
  // Small caches keep memory low; anything missing is fetched on demand.
  makeCache: Options.cacheWithLimits({
    ...Options.DefaultMakeCacheSettings,
    MessageManager: 50, ThreadMemberManager: 0, PresenceManager: 0, GuildEmojiManager: 0, GuildStickerManager: 0,
    GuildScheduledEventManager: 0, StageInstanceManager: 0, AutoModerationRuleManager: 0, ReactionUserManager: 0, GuildBanManager: 0,
  }),
  sweepers: {
    ...Options.DefaultSweeperSettings,
    messages: { interval: 600, lifetime: 900 },
    threads: { interval: 3600, lifetime: 3600 },
    users: { interval: 3600, filter: () => (u) => u.bot && u.id !== u.client.user.id },
  },
  allowedMentions: { parse: ["users"] },
});
runtime.client = client;

const api = startInternalApi();
const stopHeartbeat = startHeartbeat("bot", () => ({ ready: runtime.ready, ping: client.ws.ping, guilds: client.guilds.cache.size, memoryMb: Math.round(process.memoryUsage().rss / 1048576), uptime: Math.round(process.uptime()) }));

const register = async (g: { id: string; name: string; icon: string | null; ownerId: string; memberCount: number }) =>
  ensureGuild({ id: g.id, name: g.name, icon: g.icon, ownerId: g.ownerId, memberCount: g.memberCount }).catch((err) => log.warn({ err, guild: g.id }, "guild registration failed"));

client.once(Events.ClientReady, async (c) => {
  log.info({ user: c.user.tag, guilds: c.guilds.cache.size }, "connected to Discord");
  for (const g of c.guilds.cache.values()) await register(g);
  // Mark guilds MOTH was removed from while offline.
  const ids = [...c.guilds.cache.keys()];
  if (ids.length) await getDb().update(guilds).set({ active: false }).where(sql`${guilds.id} not in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
  await syncAllCommands(c);
  await startScheduledAutomations(ids);
  analytics.start();
  startScheduler();
  await loadTempVoice().catch((err) => log.warn({ err }, "temp voice recovery failed"));
  for (const g of c.guilds.cache.values()) void serverLogs.cacheInvites(g);
  runtime.ready = true;
  log.info("MOTH is ready");
});

client.on(Events.GuildCreate, async (g) => { await register(g); void serverLogs.cacheInvites(g); void welcomeNewGuild(g).catch(() => undefined); await syncGuildCommands(g); await startScheduledAutomations([g.id]); log.info({ guild: g.id, name: g.name }, "joined guild"); });
client.on(Events.GuildDelete, async (g) => { await getDb().update(guilds).set({ active: false, leftAt: new Date() }).where(eq(guilds.id, g.id)); log.info({ guild: g.id }, "left guild"); });
client.on(Events.GuildUpdate, (_o, g) => void register(g));
client.on(Events.InteractionCreate, (i) => void handleInteraction(i));

client.on(Events.MessageCreate, async (message) => {
  if (!message.inGuild()) return;
  try {
    analytics.message(message.guildId, message.channelId, message.author.id);
    void handleSticky(message);
    if (message.author.bot) {
      // Bot messages can still trigger automations that opt in (e.g. bump reminders).
      void fireAutomations(message.guild, "message", { member: message.member, message, channel: message.channel });
      return;
    }
    if (await checkMessage(message)) return; // removed by automod
    if (await handleSuggestionMessage(message)) return;
    if (await applyChannelRules(message)) return;
    void trackTicketActivity(message);
    void handleMessageXp(message);
    void (async () => { const cfg = await getGuildConfig(message.guildId); if (cfg.economy.enabled && cfg.economy.messageReward) await addCurrency(message.guildId, message.author.id, cfg.economy.messageReward); })().catch(() => undefined);
    void runTriggerCommands(message);
    void fireAutomations(message.guild, "message", { member: message.member, message, channel: message.channel });
    await handleAIMessage(message);
  } catch (err) { log.warn({ err }, "message handling failed"); }
});
client.on(Events.MessageUpdate, async (old, message) => {
  if (!message.inGuild() || message.partial || message.author.bot) return;
  serverLogs.logMessageEdit(old, message);
  await checkMessage(message).catch(() => undefined);
});
client.on(Events.MessageDelete, (message) => {
  serverLogs.logMessageDelete(message);
  // One of MOTH's panels may have been deleted — Autopilot re-posts it.
  if (message.inGuild() && message.author?.id === client.user?.id && message.components?.length) scheduleAutopilot(message.guild, "a MOTH panel was deleted", 30_000);
  if (message.inGuild() && !message.author?.bot) void fireAutomations(message.guild, "message_delete", { member: message.member, user: message.author, channel: message.channel, text: message.content ?? "" });
});
client.on(Events.MessageBulkDelete, (messages, channel) => serverLogs.logBulkDelete(messages, channel));
client.on(Events.ThreadCreate, async (thread, newly) => {
  if (!newly) return;
  const owner = thread.ownerId ? await thread.guild.members.fetch(thread.ownerId).catch(() => null) : null;
  if (owner?.user.bot) return;
  const starter = await thread.fetchStarterMessage().catch(() => null);
  void fireAutomations(thread.guild, "thread_create", { member: owner, user: owner?.user, channel: thread, parentId: thread.parentId, text: starter?.content ?? thread.name });
});

client.on(Events.GuildMemberAdd, async (member) => {
  analytics.join(member.guild.id);
  await securityJoin(member).catch((err) => log.warn({ err }, "security join check failed"));
  if (!member.guild.members.cache.has(member.id)) return; // removed by raid protection
  const invite = await serverLogs.resolveJoinInvite(member).catch(() => null);
  serverLogs.logMemberJoin(member, invite);
  await onJoin(member).catch((err) => log.warn({ err }, "welcome failed"));
  await restoreRoles(member).catch(() => undefined);
  void dehoist(member);
  void fireAutomations(member.guild, "member_join", { member, user: member.user, invite });
  void publishEvent("member.joined", member.guild.id, { userId: member.id, memberCount: member.guild.memberCount });
});
client.on(Events.GuildMemberRemove, async (member) => {
  analytics.leave(member.guild.id);
  await onLeave(member).catch(() => undefined);
  void rememberRoles(member);
  serverLogs.logMemberLeave(member);
  void serverLogs.markInviteLeft(member.guild.id, member.id);
  void fireAutomations(member.guild, "member_leave", { user: member.user });
  void publishEvent("member.left", member.guild.id, { userId: member.id, memberCount: member.guild.memberCount });
});
client.on(Events.GuildMemberUpdate, (oldM, newM) => {
  serverLogs.logMemberUpdate(oldM, newM);
  if (oldM.displayName !== newM.displayName) void dehoist(newM);
  if (oldM.partial) return;
  for (const r of newM.roles.cache.keys()) if (!oldM.roles.cache.has(r)) void fireAutomations(newM.guild, "role_added", { member: newM, roleId: r });
  for (const r of oldM.roles.cache.keys()) if (!newM.roles.cache.has(r)) void fireAutomations(newM.guild, "role_removed", { member: newM, roleId: r });
  if (!oldM.premiumSince && newM.premiumSince) void fireAutomations(newM.guild, "boost", { member: newM });
});
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  await onReaction(reaction, user, true).catch(() => undefined);
  onStarboardReaction(reaction, user);
  const guild = reaction.message.guild;
  if (guild && !user.bot) {
    const member = await guild.members.fetch(user.id).catch(() => null);
    const msg = reaction.message.partial ? await reaction.message.fetch().catch(() => null) : reaction.message;
    void fireAutomations(guild, "reaction_add", { member, user: member?.user, emoji: reaction.emoji.id ? `<:${reaction.emoji.name}:${reaction.emoji.id}>` : reaction.emoji.name ?? "", message: msg?.inGuild() ? msg : null, channel: reaction.message.channel as never });
  }
});
client.on(Events.MessageReactionRemove, (reaction, user) => { void onReaction(reaction, user, false).catch(() => undefined); onStarboardReaction(reaction, user); });

// Voice tracking: XP + analytics minutes, and voice triggers.
const voiceSessions = new Map<string, number>();
client.on(Events.VoiceStateUpdate, async (oldS, newS) => {
  const key = `${newS.guild.id}:${newS.id}`;
  serverLogs.logVoice(oldS, newS);
  void onTempVoiceState(oldS, newS).catch((err) => log.warn({ err }, "temp voice failed"));
  if (!oldS.channelId && newS.channelId) { voiceSessions.set(key, Date.now()); void fireAutomations(newS.guild, "voice_join", { member: newS.member, channel: newS.channel }); }
  if (oldS.channelId && !newS.channelId) {
    void fireAutomations(newS.guild, "voice_leave", { member: oldS.member, channel: oldS.channel });
    const started = voiceSessions.get(key); voiceSessions.delete(key);
    if (!started || !oldS.member || oldS.member.user.bot) return;
    const minutes = Math.floor((Date.now() - started) / 60_000);
    if (minutes < 1) return;
    analytics.voice(newS.guild.id, minutes);
    await getDb().insert(memberLevels).values({ guildId: newS.guild.id, userId: newS.id, voiceMinutes: minutes }).onConflictDoUpdate({ target: [memberLevels.guildId, memberLevels.userId], set: { voiceMinutes: sql`${memberLevels.voiceMinutes} + ${minutes}` } }).catch(() => undefined);
    const cfg = await getGuildConfig(newS.guild.id);
    if (cfg.leveling.enabled && cfg.leveling.voiceXpPerMinute) {
      const { addXp } = await import("./modules/leveling.js");
      await addXp(oldS.member, Math.min(minutes, 240) * cfg.leveling.voiceXpPerMinute, null).catch(() => undefined);
    }
  }
});

// Anti-nuke monitoring.
client.on(Events.ChannelDelete, (ch) => {
  void onTempVoiceDeleted(ch.id);
  serverLogs.logChannel(ch, "deleted");
  if ("guild" in ch && ch.guild) scheduleAutopilot(ch.guild, `#${"name" in ch ? ch.name : "channel"} was deleted`);
  if ("guild" in ch && ch.guild) void trackDestructive(ch.guild, "channel", AuditLogEvent.ChannelDelete);
});
client.on(Events.GuildRoleDelete, (role) => { serverLogs.logRole(role, "deleted"); void trackDestructive(role.guild, "role", AuditLogEvent.RoleDelete); });
client.on(Events.GuildBanAdd, (ban) => { serverLogs.logBan(ban, true); void trackDestructive(ban.guild, "ban", AuditLogEvent.MemberBanAdd); });
client.on(Events.GuildBanRemove, (ban) => serverLogs.logBan(ban, false));
client.on(Events.ChannelCreate, (ch) => {
  serverLogs.logChannel(ch, "created");
  if ("guild" in ch && ch.guild) scheduleAutopilot(ch.guild, `#${ch.name} was created`);
});
client.on(Events.ChannelUpdate, (a, b) => serverLogs.logChannelUpdate(a, b));
client.on(Events.GuildRoleCreate, (role) => serverLogs.logRole(role, "created"));
client.on(Events.GuildRoleUpdate, (a, b) => serverLogs.logRoleUpdate(a, b));
client.on(Events.InviteCreate, (inv) => serverLogs.onInviteCreate(inv));
client.on(Events.InviteDelete, (inv) => serverLogs.onInviteDelete(inv));

client.on(Events.ShardDisconnect, (_e, id) => log.warn({ shard: id }, "gateway disconnected"));
client.on(Events.ShardReconnecting, (id) => log.info({ shard: id }, "gateway reconnecting"));
client.on(Events.ShardResume, (id) => log.info({ shard: id }, "gateway resumed"));
client.on(Events.Error, (err) => log.error({ err }, "client error"));
client.on(Events.Warn, (m) => log.warn(m));

// Dashboard → bot synchronisation.
const events = new EventSubscriber(env.DATABASE_URL, (m) => log.warn(m));
events.on((e) => {
  if (e.type === "config.updated") {
    invalidateGuildConfig(e.guildId);
    const g = client.guilds.cache.get(e.guildId);
    if (g) setTimeout(() => { void refreshStickies(g).catch(() => undefined); void updateStatsChannels(g).catch(() => undefined); }, 1500);
  }
  if (e.type === "automations.updated") invalidateAutomations(e.guildId);
  if (e.type === "commands.updated") {
    invalidateCustomCommands(e.guildId);
    const g = client.guilds.cache.get(e.guildId);
    if (g) scheduleGuildCommandSync(g);
  }
});
await events.start();

async function shutdown(signal: string) {
  log.info({ signal }, "shutting down");
  runtime.ready = false;
  stopScheduler(); stopHeartbeat();
  await analytics.stop().catch(() => undefined);
  await events.stop();
  api.close();
  await client.destroy();
  await closeDb();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await client.login(env.DISCORD_TOKEN);

import { sql } from "drizzle-orm";
import { analyticsHourly, channelActivity, getDb, publishEvent } from "@moth/core";
import { log, runtime } from "../context.js";

type Counter = { messages: number; joins: number; leaves: number; voiceMinutes: number; commands: number; users: Set<string> };

/**
 * Buffers activity counters in memory and flushes them to Postgres every
 * minute with additive upserts. Live counters are broadcast to the dashboard.
 */
class Analytics {
  private hourly = new Map<string, Counter>();
  private channels = new Map<string, number>(); // guild:channel -> count
  private timer: NodeJS.Timeout | null = null;

  private c(guildId: string): Counter {
    let c = this.hourly.get(guildId);
    if (!c) { c = { messages: 0, joins: 0, leaves: 0, voiceMinutes: 0, commands: 0, users: new Set() }; this.hourly.set(guildId, c); }
    return c;
  }
  message(guildId: string, channelId: string, userId: string) {
    const c = this.c(guildId); c.messages++; c.users.add(userId);
    const k = `${guildId}:${channelId}`; this.channels.set(k, (this.channels.get(k) ?? 0) + 1);
  }
  join(guildId: string) { this.c(guildId).joins++; }
  leave(guildId: string) { this.c(guildId).leaves++; }
  voice(guildId: string, minutes: number) { this.c(guildId).voiceMinutes += minutes; }
  command(guildId: string) { this.c(guildId).commands++; }

  start() {
    this.timer = setInterval(() => void this.flush(), 60_000);
    this.timer.unref();
  }

  async flush() {
    const hour = new Date(); hour.setUTCMinutes(0, 0, 0);
    const day = new Date(); day.setUTCHours(0, 0, 0, 0);
    const batch = this.hourly; this.hourly = new Map();
    const chans = this.channels; this.channels = new Map();
    const db = getDb();
    for (const [guildId, c] of batch) {
      const memberCount = runtime.client?.guilds.cache.get(guildId)?.memberCount ?? null;
      try {
        await db.insert(analyticsHourly).values({ guildId, hour, messages: c.messages, joins: c.joins, leaves: c.leaves, voiceMinutes: c.voiceMinutes, commands: c.commands, activeUsers: c.users.size, memberCount })
          .onConflictDoUpdate({
            target: [analyticsHourly.guildId, analyticsHourly.hour],
            set: {
              messages: sql`${analyticsHourly.messages} + ${c.messages}`, joins: sql`${analyticsHourly.joins} + ${c.joins}`, leaves: sql`${analyticsHourly.leaves} + ${c.leaves}`,
              voiceMinutes: sql`${analyticsHourly.voiceMinutes} + ${c.voiceMinutes}`, commands: sql`${analyticsHourly.commands} + ${c.commands}`,
              // Approximation: active users across flushes within the hour uses the max of the partial sets.
              activeUsers: sql`greatest(${analyticsHourly.activeUsers}, ${c.users.size})`, memberCount,
            },
          });
        await publishEvent("analytics.tick", guildId, { messages: c.messages, joins: c.joins, leaves: c.leaves, activeUsers: c.users.size, memberCount });
      } catch (err) { log.warn({ err, guildId }, "analytics flush failed"); }
    }
    for (const [k, n] of chans) {
      const [guildId, channelId] = k.split(":");
      await db.insert(channelActivity).values({ guildId, channelId, day, messages: n })
        .onConflictDoUpdate({ target: [channelActivity.guildId, channelActivity.channelId, channelActivity.day], set: { messages: sql`${channelActivity.messages} + ${n}` } })
        .catch(() => undefined);
    }
  }

  async stop() { if (this.timer) clearInterval(this.timer); await this.flush(); }
}

export const analytics = new Analytics();

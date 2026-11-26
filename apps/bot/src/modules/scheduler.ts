import { Cron } from "croner";
import { and, eq, lte, sql } from "drizzle-orm";
import { getDb, getGuildConfig, scheduledJobs, tickets, dashboardSessions } from "@moth/core";
import { log, runtime } from "../context.js";
import { endDueGiveaways } from "./giveaways.js";
import { endDuePolls } from "./polls.js";
import { recoverExpiredRaids } from "./security.js";
import { executeModAction, expireTimeoutCases } from "./moderation.js";
import { autoCloseInactive } from "./tickets.js";
import { createBackup, pruneBackups } from "./backups.js";

/** Durable job runner (jobs live in Postgres, so they survive restarts) + periodic maintenance. */
async function runDueJobs() {
  const db = getDb();
  const jobs = await db.select().from(scheduledJobs).where(and(eq(scheduledJobs.done, false), lte(scheduledJobs.runAt, new Date()), sql`${scheduledJobs.attempts} < 5`)).limit(50);
  for (const job of jobs) {
    const guild = runtime.client?.guilds.cache.get(job.guildId);
    try {
      if (!guild) throw new Error("guild unavailable");
      const p = job.payload as Record<string, string>;
      if (job.kind === "unban") {
        const user = await guild.client.users.fetch(p.userId);
        await executeModAction({ guild, target: user, moderator: guild.client.user, type: "unban", reason: `Temporary ban expired (case #${p.caseNumber})`, automated: true });
      } else if (job.kind === "ticket-delete") {
        const ch = await guild.channels.fetch(p.channelId).catch(() => null);
        await ch?.delete("Ticket closed").catch(() => undefined);
        await db.update(tickets).set({ status: "archived", channelId: null }).where(eq(tickets.id, p.ticketId));
      }
      await db.update(scheduledJobs).set({ done: true }).where(eq(scheduledJobs.id, job.id));
    } catch (err) {
      await db.update(scheduledJobs).set({ attempts: job.attempts + 1, lastError: (err as Error).message, runAt: new Date(Date.now() + 60_000 * (job.attempts + 1)) }).where(eq(scheduledJobs.id, job.id));
    }
  }
}

const crons: Cron[] = [];
export function startScheduler(): void {
  const safe = (name: string, fn: () => Promise<unknown>) => async () => { try { await fn(); } catch (err) { log.warn({ err, task: name }, "scheduled task failed"); } };
  crons.push(
    new Cron("*/15 * * * * *", { protect: true }, safe("jobs", runDueJobs)),
    new Cron("*/20 * * * * *", { protect: true }, safe("giveaways+polls", async () => { await endDueGiveaways(); await endDuePolls(); })),
    new Cron("*/30 * * * * *", { protect: true }, safe("raid-recovery", async () => runtime.client && recoverExpiredRaids(runtime.client.guilds.cache))),
    new Cron("*/5 * * * *", { protect: true }, safe("maintenance", async () => {
      await expireTimeoutCases();
      await getDb().delete(dashboardSessions).where(lte(dashboardSessions.expiresAt, new Date()));
      for (const g of runtime.client?.guilds.cache.values() ?? []) await autoCloseInactive(g);
    })),
    new Cron("17 3 * * *", { protect: true }, safe("daily-backups", async () => {
      for (const g of runtime.client?.guilds.cache.values() ?? []) {
        const cfg = await getGuildConfig(g.id);
        if (!cfg.backups.autoDaily) continue;
        await createBackup(g, `Daily backup ${new Date().toISOString().slice(0, 10)}`, "auto").catch((err) => log.warn({ err, guild: g.id }, "auto backup failed"));
        await pruneBackups(g.id, cfg.backups.keep);
      }
    })),
  );
}
export function stopScheduler() { crons.forEach((c) => c.stop()); }

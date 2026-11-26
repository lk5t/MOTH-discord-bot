import type { Guild } from "discord.js";
import { and, eq, sql } from "drizzle-orm";
import { decryptSecret, encryptSecret, featureState, getDb, getGuildConfig, memberBackups, OAuthRevokedError, refreshDiscordToken, sleep } from "@moth/core";
import { env } from "../env.js";
import { log } from "../context.js";

/**
 * Member backup restore: adds members who verified with Discord sign-in
 * ("join servers for you") to a server, e.g. a replacement after a nuke.
 * Progress is stored in feature_state so the dashboard can follow it.
 */

export interface PullStatus {
  running: boolean; sourceGuildId: string; total: number; added: number; already: number; failed: number; revoked: number;
  startedAt: string; finishedAt?: string; error?: string;
}

const KEY = "member-pull";
const running = new Set<string>();

async function save(guildId: string, s: PullStatus) {
  await getDb().insert(featureState).values({ guildId, key: KEY, value: s as never })
    .onConflictDoUpdate({ target: [featureState.guildId, featureState.key], set: { value: s as never, updatedAt: new Date() } });
}

export async function pullStatus(guildId: string): Promise<PullStatus | null> {
  const [row] = await getDb().select().from(featureState).where(and(eq(featureState.guildId, guildId), eq(featureState.key, KEY)));
  return (row?.value as PullStatus) ?? null;
}

export async function backupCount(guildId: string) {
  const [r] = await getDb().select({ total: sql<number>`count(*)::int`, active: sql<number>`count(*) filter (where not ${memberBackups.revoked})::int` }).from(memberBackups).where(eq(memberBackups.guildId, guildId));
  return r;
}

/** Starts pulling members backed up in `sourceGuildId` into `target`. Returns immediately. */
export async function startPull(target: Guild, sourceGuildId: string): Promise<PullStatus> {
  if (!env.DISCORD_CLIENT_SECRET) throw new Error("DISCORD_CLIENT_SECRET is missing from the bot's environment — run `sudo moth update` so the installer passes it through.");
  if (running.has(target.id)) throw new Error("A restore is already running for this server.");
  const rows = await getDb().select().from(memberBackups).where(and(eq(memberBackups.guildId, sourceGuildId), eq(memberBackups.revoked, false)));
  if (!rows.length) throw new Error("No backed-up members for that server yet.");
  const status: PullStatus = { running: true, sourceGuildId, total: rows.length, added: 0, already: 0, failed: 0, revoked: 0, startedAt: new Date().toISOString() };
  await save(target.id, status);
  running.add(target.id);
  void (async () => {
    const cfg = await getGuildConfig(target.id);
    const vr = cfg.verification.verifiedRoleId ? target.roles.cache.get(cfg.verification.verifiedRoleId) : undefined;
    const roles = vr?.editable ? [vr.id] : [];
    const started = Date.now();
    for (const [n, row] of rows.entries()) {
      try {
        let access = decryptSecret(row.accessTokenEnc);
        if (row.expiresAt.getTime() < Date.now() + 120_000) {
          const t = await refreshDiscordToken(env.DISCORD_CLIENT_ID, env.DISCORD_CLIENT_SECRET!, decryptSecret(row.refreshTokenEnc));
          access = t.access_token;
          await getDb().update(memberBackups).set({ accessTokenEnc: encryptSecret(t.access_token), refreshTokenEnc: encryptSecret(t.refresh_token), expiresAt: new Date(Date.now() + t.expires_in * 1000), updatedAt: new Date() })
            .where(and(eq(memberBackups.guildId, row.guildId), eq(memberBackups.userId, row.userId)));
        }
        const member = await target.members.add(row.userId, { accessToken: access, roles, fetchWhenExisting: true });
        if (member && member.joinedTimestamp && member.joinedTimestamp < started) status.already++; else status.added++;
        await getDb().update(memberBackups).set({ lastPulledAt: new Date() }).where(and(eq(memberBackups.guildId, row.guildId), eq(memberBackups.userId, row.userId)));
      } catch (err) {
        if (err instanceof OAuthRevokedError || /invalid|unauthori[sz]ed|40001|50025/i.test((err as Error).message)) {
          status.revoked++;
          await getDb().update(memberBackups).set({ revoked: true }).where(and(eq(memberBackups.guildId, row.guildId), eq(memberBackups.userId, row.userId)));
        } else { status.failed++; log.debug({ err, user: row.userId }, "member pull failed"); }
      }
      if (n % 10 === 9) await save(target.id, status);
      await sleep(250); // stay well under Discord's rate limits
    }
    status.running = false; status.finishedAt = new Date().toISOString();
    await save(target.id, status);
    log.info({ guild: target.id, ...status }, "member restore finished");
  })().catch(async (err) => { status.running = false; status.error = (err as Error).message; await save(target.id, status); })
    .finally(() => running.delete(target.id));
  return status;
}

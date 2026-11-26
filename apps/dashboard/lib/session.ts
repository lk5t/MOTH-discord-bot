import "server-only";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { dashboardSessions, decryptSecret, encryptSecret, getDb, randomToken, sha256 } from "@moth/core";
import { fetchGuilds, refreshToken, type DiscordGuild } from "./discord";

export const SESSION_COOKIE = "moth_session";
export const SESSION_DAYS = 7;

export type Session = typeof dashboardSessions.$inferSelect;

export async function createSession(input: { user: Session["user"]; accessToken: string; refreshToken: string; expiresIn: number; userAgent?: string | null; ip?: string | null }): Promise<string> {
  const token = randomToken(32);
  await getDb().insert(dashboardSessions).values({
    id: sha256(token), userId: input.user.id, user: input.user,
    accessTokenEnc: encryptSecret(input.accessToken), refreshTokenEnc: encryptSecret(input.refreshToken),
    tokenExpiresAt: new Date(Date.now() + input.expiresIn * 1000), expiresAt: new Date(Date.now() + SESSION_DAYS * 86_400_000),
    userAgent: input.userAgent?.slice(0, 300) ?? null, ip: input.ip ?? null,
  });
  return token;
}

export async function getSession(): Promise<Session | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const db = getDb();
  const [s] = await db.select().from(dashboardSessions).where(eq(dashboardSessions.id, sha256(token)));
  if (!s || s.expiresAt.getTime() < Date.now()) return null;
  if (Date.now() - s.lastSeenAt.getTime() > 5 * 60_000) await db.update(dashboardSessions).set({ lastSeenAt: new Date() }).where(eq(dashboardSessions.id, s.id));
  return s;
}

export async function destroySession(): Promise<void> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token) await getDb().delete(dashboardSessions).where(eq(dashboardSessions.id, sha256(token)));
}

async function accessToken(s: Session): Promise<string> {
  if (s.tokenExpiresAt.getTime() - Date.now() > 60_000) return decryptSecret(s.accessTokenEnc);
  if (!s.refreshTokenEnc) throw new Error("Discord session expired");
  const t = await refreshToken(decryptSecret(s.refreshTokenEnc));
  await getDb().update(dashboardSessions).set({ accessTokenEnc: encryptSecret(t.access_token), refreshTokenEnc: encryptSecret(t.refresh_token), tokenExpiresAt: new Date(Date.now() + t.expires_in * 1000) }).where(eq(dashboardSessions.id, s.id));
  return t.access_token;
}

/** The user's Discord guilds, cached on the session for 5 minutes. */
export async function userGuilds(s: Session, force = false): Promise<DiscordGuild[]> {
  if (!force && s.guildCache && s.guildCacheAt && Date.now() - s.guildCacheAt.getTime() < 5 * 60_000) return s.guildCache;
  try {
    const guilds = await fetchGuilds(await accessToken(s));
    const slim = guilds.map((g) => ({ id: g.id, name: g.name, icon: g.icon, owner: g.owner, permissions: g.permissions }));
    await getDb().update(dashboardSessions).set({ guildCache: slim, guildCacheAt: new Date() }).where(eq(dashboardSessions.id, s.id));
    return slim;
  } catch (err) {
    if (s.guildCache) return s.guildCache;
    throw err;
  }
}

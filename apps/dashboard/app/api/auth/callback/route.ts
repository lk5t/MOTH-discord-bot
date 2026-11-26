import { NextResponse } from "next/server";
import { cookies, headers } from "next/headers";
import { createLogger, encryptSecret, getDb, memberBackups } from "@moth/core";
import { bot } from "@/lib/bot";
import { exchangeCode, fetchUser } from "@/lib/discord";
import { createSession, SESSION_COOKIE, SESSION_DAYS } from "@/lib/session";
import { env } from "@/lib/env";

const log = createLogger("dashboard");

export async function GET(req: Request) {
  const url = new URL(req.url);
  const base = env().DASHBOARD_URL.replace(/\/$/, "");
  const jar = await cookies();
  const raw = jar.get("moth_oauth_state")?.value;
  let saved: { state: string; next: string; verify?: string } | null = null;
  try { saved = raw ? JSON.parse(raw) : null; } catch { saved = null; }
  const code = url.searchParams.get("code");
  if (saved?.verify && !code) return NextResponse.redirect(`${base}/verified?${new URLSearchParams({ status: "error", message: "Verification was cancelled — press Verify in Discord to try again." })}`);
  if (!code || !saved || saved.state !== url.searchParams.get("state")) return NextResponse.redirect(`${base}/?error=state`);
  if (saved.verify) return verifyCallback(code, saved.verify, base);
  try {
    const token = await exchangeCode(code);
    const u = await fetchUser(token.access_token);
    const h = await headers();
    const sessionToken = await createSession({
      user: { id: u.id, username: u.username, globalName: u.global_name, avatar: u.avatar },
      accessToken: token.access_token, refreshToken: token.refresh_token, expiresIn: token.expires_in,
      userAgent: h.get("user-agent"), ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    });
    const res = NextResponse.redirect(`${base}${saved.next}`);
    res.cookies.set(SESSION_COOKIE, sessionToken, { httpOnly: true, sameSite: "lax", secure: base.startsWith("https://"), maxAge: SESSION_DAYS * 86400, path: "/" });
    res.cookies.delete("moth_oauth_state");
    log.info({ user: u.id }, "dashboard login");
    return res;
  } catch (err) {
    log.warn({ err }, "oauth callback failed");
    return NextResponse.redirect(`${base}/?error=oauth`);
  }
}

/** "Verify with Discord": stores the member backup grant and gives the verified role. */
async function verifyCallback(code: string, guildId: string, base: string) {
  const done = (q: Record<string, string>) => { const res = NextResponse.redirect(`${base}/verified?${new URLSearchParams(q)}`); res.cookies.delete("moth_oauth_state"); return res; };
  try {
    const token = await exchangeCode(code);
    const u = await fetchUser(token.access_token);
    if (token.scope.split(" ").includes("guilds.join")) {
      const row = { username: u.username, accessTokenEnc: encryptSecret(token.access_token), refreshTokenEnc: encryptSecret(token.refresh_token), expiresAt: new Date(Date.now() + token.expires_in * 1000), scopes: token.scope, revoked: false, updatedAt: new Date() };
      await getDb().insert(memberBackups).values({ guildId, userId: u.id, ...row }).onConflictDoUpdate({ target: [memberBackups.guildId, memberBackups.userId], set: row });
    }
    const r = await bot<{ ok: boolean; message: string }>(`/guilds/${guildId}/oauth-verified`, { body: { userId: u.id } });
    log.info({ user: u.id, guild: guildId, ok: r.ok }, "oauth verification");
    return done({ status: r.ok ? "ok" : "error", message: r.message, name: u.global_name ?? u.username });
  } catch (err) {
    log.warn({ err }, "verification callback failed");
    return done({ status: "error", message: "Verification failed — go back to Discord and press Verify again." });
  }
}

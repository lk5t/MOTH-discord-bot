import { NextResponse } from "next/server";
import { cookies, headers } from "next/headers";
import { createLogger } from "@moth/core";
import { exchangeCode, fetchUser } from "@/lib/discord";
import { createSession, SESSION_COOKIE, SESSION_DAYS } from "@/lib/session";
import { env } from "@/lib/env";

const log = createLogger("dashboard");

export async function GET(req: Request) {
  const url = new URL(req.url);
  const base = env().DASHBOARD_URL.replace(/\/$/, "");
  const jar = await cookies();
  const raw = jar.get("moth_oauth_state")?.value;
  let saved: { state: string; next: string } | null = null;
  try { saved = raw ? JSON.parse(raw) : null; } catch { saved = null; }
  const code = url.searchParams.get("code");
  if (!code || !saved || saved.state !== url.searchParams.get("state")) return NextResponse.redirect(`${base}/?error=state`);
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

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, getGuildConfig, guilds, randomToken } from "@moth/core";
import { oauthUrl } from "@/lib/discord";
import { env } from "@/lib/env";

/** Starts "Verify with Discord" for a server (linked from the verify button in Discord). */
export async function GET(req: Request) {
  const base = env().DASHBOARD_URL.replace(/\/$/, "");
  const guildId = new URL(req.url).searchParams.get("guild") ?? "";
  if (!/^\d{15,22}$/.test(guildId)) return NextResponse.redirect(`${base}/verified?status=error&message=${encodeURIComponent("Invalid verification link.")}`);
  const [g] = await getDb().select().from(guilds).where(eq(guilds.id, guildId));
  const cfg = g?.active ? await getGuildConfig(guildId) : null;
  if (!cfg?.verification.enabled || cfg.verification.mode !== "oauth") return NextResponse.redirect(`${base}/verified?status=error&message=${encodeURIComponent("Discord sign-in verification isn't enabled on this server.")}`);
  const state = randomToken(16);
  const res = NextResponse.redirect(oauthUrl(state, "identify guilds.join"));
  res.cookies.set("moth_oauth_state", JSON.stringify({ state, next: "/", verify: guildId }), { httpOnly: true, sameSite: "lax", secure: base.startsWith("https://"), maxAge: 600, path: "/" });
  return res;
}

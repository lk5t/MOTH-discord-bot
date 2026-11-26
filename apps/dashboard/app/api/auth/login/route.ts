import { NextResponse } from "next/server";
import { randomToken } from "@moth/core";
import { oauthUrl } from "@/lib/discord";
import { env } from "@/lib/env";

export async function GET(req: Request) {
  const state = randomToken(16);
  const next = new URL(req.url).searchParams.get("next") ?? "/dashboard";
  const res = NextResponse.redirect(oauthUrl(state));
  const secure = env().DASHBOARD_URL.startsWith("https://");
  res.cookies.set("moth_oauth_state", JSON.stringify({ state, next: next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard" }), { httpOnly: true, sameSite: "lax", secure, maxAge: 600, path: "/" });
  return res;
}

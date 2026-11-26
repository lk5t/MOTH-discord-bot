import { NextResponse } from "next/server";
import { destroySession, SESSION_COOKIE } from "@/lib/session";
import { env } from "@/lib/env";

export async function POST() {
  await destroySession();
  const res = NextResponse.redirect(`${env().DASHBOARD_URL.replace(/\/$/, "")}/`, 303);
  res.cookies.delete(SESSION_COOKIE);
  return res;
}

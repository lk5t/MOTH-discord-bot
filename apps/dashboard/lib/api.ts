import "server-only";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ConfigConflictError, createLogger } from "@moth/core";
import { getSession, type Session } from "./session";
import { atLeast, guildAccess, type Level } from "./access";
import { BotError } from "./bot";
import { env } from "./env";

export const log = createLogger("dashboard");

export class ApiError extends Error { constructor(readonly status: number, message: string) { super(message); } }

export interface GuildCtx { session: Session; guildId: string; level: Level; userId: string; req: Request; params: string[]; query: URLSearchParams; p: Record<string, string> }

export function json(data: unknown, status = 200) {
  return new NextResponse(JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

/** Rejects cross-site state-changing requests (CSRF defence in addition to SameSite cookies). */
export function checkOrigin(req: Request) {
  if (req.method === "GET" || req.method === "HEAD") return;
  const origin = req.headers.get("origin");
  if (!origin) throw new ApiError(403, "Missing origin");
  const allowed = new Set([new URL(env().DASHBOARD_URL).host, req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? ""]);
  if (!allowed.has(new URL(origin).host)) throw new ApiError(403, "Cross-site request blocked");
}

export async function body<T extends z.ZodTypeAny>(req: Request, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try { raw = await req.json(); } catch { throw new ApiError(400, "Invalid JSON body"); }
  const r = schema.safeParse(raw);
  if (!r.success) throw new ApiError(400, r.error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return r.data;
}

export function requireLevel(ctx: { level: Level }, level: Level) {
  if (!atLeast(ctx.level, level)) throw new ApiError(403, `This requires ${level} access`);
}

export function handleError(err: unknown) {
  if (err instanceof ApiError) return json({ error: err.message }, err.status);
  if (err instanceof BotError) return json({ error: err.message }, err.status >= 500 ? 502 : err.status);
  if (err instanceof ConfigConflictError) return json({ error: err.message }, 409);
  if (err instanceof z.ZodError) return json({ error: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
  log.error({ err }, "api error");
  return json({ error: "Internal error" }, 500);
}

export async function guildContext(req: Request, guildId: string, params: string[] = [], named: Record<string, string> = {}): Promise<GuildCtx> {
  checkOrigin(req);
  const session = await getSession();
  if (!session) throw new ApiError(401, "Not signed in");
  if (!/^\d{15,22}$/.test(guildId)) throw new ApiError(400, "Invalid guild");
  const level = await guildAccess(session, guildId);
  if (level === "none") throw new ApiError(403, "You don't have access to this server");
  return { session, guildId, level, userId: session.userId, req, params, query: new URL(req.url).searchParams, p: named };
}

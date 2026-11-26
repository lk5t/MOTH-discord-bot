import { getPool } from "@moth/core";

export const dynamic = "force-dynamic";

/** Liveness/readiness probe used by Docker and the installer. */
export async function GET() {
  try {
    await getPool().query("select 1");
    return Response.json({ status: "ok", service: "dashboard", version: process.env.MOTH_VERSION ?? "dev" });
  } catch {
    return Response.json({ status: "degraded", database: "unreachable" }, { status: 503 });
  }
}

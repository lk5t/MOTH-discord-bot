import { guildContext, handleError, json } from "@/lib/api";
import { matchRoute } from "@/lib/routes";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ guildId: string; path: string[] }> };

async function dispatch(req: Request, { params }: Ctx) {
  try {
    const { guildId, path } = await params;
    const m = matchRoute(req.method, path);
    if (!m) return json({ error: "Not found" }, 404);
    const ctx = await guildContext(req, guildId, path, m.named);
    return await m.handler(ctx);
  } catch (err) { return handleError(err); }
}

export { dispatch as GET, dispatch as POST, dispatch as PATCH, dispatch as PUT, dispatch as DELETE };

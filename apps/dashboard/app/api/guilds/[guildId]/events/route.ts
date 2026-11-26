import { guildContext, handleError } from "@/lib/api";
import { liveEvents } from "@/lib/live";

export const dynamic = "force-dynamic";

/** Server-Sent Events stream of live guild events (Discord ↔ dashboard sync). */
export async function GET(req: Request, { params }: { params: Promise<{ guildId: string }> }) {
  try {
    const { guildId } = await params;
    await guildContext(req, guildId);
    const bus = await liveEvents();
    const enc = new TextEncoder();
    let cleanup = () => {};
    const stream = new ReadableStream({
      start(controller) {
        const send = (s: string) => { try { controller.enqueue(enc.encode(s)); } catch { cleanup(); } };
        send(`retry: 5000\n\n`);
        const off = bus.on((e) => { if (e.guildId === guildId) send(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`); });
        const ping = setInterval(() => send(`: ping\n\n`), 25_000);
        cleanup = () => { off(); clearInterval(ping); };
        req.signal.addEventListener("abort", () => { cleanup(); try { controller.close(); } catch { /* closed */ } });
      },
      cancel() { cleanup(); },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" } });
  } catch (err) { return handleError(err); }
}

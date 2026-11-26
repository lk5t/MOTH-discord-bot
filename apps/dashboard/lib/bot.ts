import "server-only";

/** Client for the bot's internal API (private Docker network). */
export class BotError extends Error { constructor(readonly status: number, message: string) { super(message); } }

export async function bot<T = unknown>(path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  const base = (process.env.BOT_INTERNAL_URL ?? "http://bot:4100").replace(/\/$/, "");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 30_000);
  try {
    const res = await fetch(`${base}/v1${path}`, {
      method: init.method ?? (init.body ? "POST" : "GET"),
      headers: { authorization: `Bearer ${process.env.INTERNAL_API_SECRET}`, "content-type": "application/json" },
      body: init.body ? JSON.stringify(init.body) : undefined, cache: "no-store", signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new BotError(res.status, (data as { error?: string }).error ?? `Bot returned ${res.status}`);
    return data as T;
  } catch (err) {
    if (err instanceof BotError) throw err;
    throw new BotError(503, (err as Error).name === "AbortError" ? "The bot took too long to respond" : "The MOTH bot is offline or unreachable");
  } finally { clearTimeout(t); }
}

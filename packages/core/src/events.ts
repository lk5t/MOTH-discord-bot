import pg from "pg";
import { getPool } from "./db/client.js";

/**
 * Cross-service event bus built on Postgres LISTEN/NOTIFY.
 * Used to keep the bot and the dashboard in sync without extra infrastructure.
 */
export const EVENT_CHANNEL = "moth_events";

export type MothEventType =
  | "config.updated"
  | "commands.updated"
  | "automations.updated"
  | "ticket.updated"
  | "case.created"
  | "security.event"
  | "architect.updated"
  | "rolemenu.updated"
  | "ticketpanel.updated"
  | "analytics.tick"
  | "member.joined"
  | "member.left"
  | "guild.updated";

export interface MothEvent<T = unknown> {
  type: MothEventType;
  guildId: string;
  data?: T;
  source?: string;
  at: string;
}

export async function publishEvent<T>(type: MothEventType, guildId: string, data?: T, source?: string): Promise<void> {
  const event: MothEvent<T> = { type, guildId, data, source, at: new Date().toISOString() };
  let payload = JSON.stringify(event);
  // NOTIFY payloads are limited to 8000 bytes; drop the data if too large (consumers refetch).
  if (payload.length > 7800) payload = JSON.stringify({ ...event, data: undefined, truncated: true });
  await getPool().query("select pg_notify($1, $2)", [EVENT_CHANNEL, payload]);
}

type Listener = (event: MothEvent) => void;

/**
 * A resilient LISTEN subscriber: uses a dedicated connection and reconnects with
 * backoff when Postgres restarts.
 */
export class EventSubscriber {
  private client: pg.Client | null = null;
  private listeners = new Set<Listener>();
  private stopped = false;
  private retry = 0;

  constructor(private readonly url = process.env.DATABASE_URL, private readonly log: (msg: string) => void = console.warn) {}

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get size(): number {
    return this.listeners.size;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const client = new pg.Client({ connectionString: this.url });
    client.on("notification", (msg) => {
      if (!msg.payload) return;
      try {
        const event = JSON.parse(msg.payload) as MothEvent;
        for (const l of this.listeners) {
          try { l(event); } catch (err) { this.log(`[moth:events] listener error: ${(err as Error).message}`); }
        }
      } catch { /* ignore malformed payload */ }
    });
    client.on("error", (err) => {
      this.log(`[moth:events] connection error: ${err.message}`);
      this.scheduleReconnect();
    });
    client.on("end", () => this.scheduleReconnect());
    try {
      await client.connect();
      await client.query(`LISTEN ${EVENT_CHANNEL}`);
      this.client = client;
      this.retry = 0;
    } catch (err) {
      this.log(`[moth:events] failed to connect: ${(err as Error).message}`);
      this.scheduleReconnect();
    }
  }

  private reconnectTimer: NodeJS.Timeout | null = null;
  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.client?.removeAllListeners();
    this.client = null;
    const delay = Math.min(30_000, 1000 * 2 ** this.retry++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    await this.client?.end().catch(() => undefined);
    this.client = null;
  }
}


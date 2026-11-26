import "server-only";
import { EventSubscriber } from "@moth/core";

/** One LISTEN connection per dashboard process, fanned out to SSE clients. */
const g = globalThis as unknown as { __mothEvents?: EventSubscriber; __mothEventsStarted?: Promise<void> };

export async function liveEvents(): Promise<EventSubscriber> {
  if (!g.__mothEvents) {
    g.__mothEvents = new EventSubscriber(process.env.DATABASE_URL, (m) => console.warn(m));
    g.__mothEventsStarted = g.__mothEvents.start();
  }
  await g.__mothEventsStarted;
  return g.__mothEvents;
}

import type { Client } from "discord.js";
import { createLogger, type Logger } from "@moth/core";

export const log: Logger = createLogger("bot");

/** Late-bound Discord client reference shared by modules. */
export const runtime: { client: Client | null; startedAt: Date; ready: boolean } = { client: null, startedAt: new Date(), ready: false };

export function client(): Client {
  if (!runtime.client) throw new Error("Discord client not initialised");
  return runtime.client;
}

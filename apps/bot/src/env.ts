import { z } from "zod";
import { baseEnvSchema, loadEnv } from "@moth/core";

export const env = loadEnv(baseEnvSchema.extend({
  DISCORD_TOKEN: z.string().min(50, "DISCORD_TOKEN is required"),
  DISCORD_CLIENT_ID: z.string().regex(/^\d+$/, "DISCORD_CLIENT_ID is required"),
  INTERNAL_API_PORT: z.coerce.number().int().default(4100),
  DASHBOARD_URL: z.string().default("http://localhost:3000"),
  /** Needed to refresh member-backup tokens when pulling members into a server. */
  DISCORD_CLIENT_SECRET: z.string().optional(),
  /** Register slash commands per-guild for instant updates (recommended for self-hosting). */
  COMMAND_SCOPE: z.enum(["guild", "global"]).default("guild"),
}));
export type BotEnv = typeof env;

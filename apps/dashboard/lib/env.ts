import "server-only";
import { z } from "zod";
import { baseEnvSchema } from "@moth/core";

const schema = baseEnvSchema.extend({
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_CLIENT_SECRET: z.string().min(1),
  DASHBOARD_URL: z.string().url().default("http://localhost:3000"),
});

let cached: z.infer<typeof schema> | null = null;
/** Lazily validated so `next build` works without runtime secrets. */
export function env() {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) throw new Error(`Invalid dashboard environment: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  cached = parsed.data;
  return cached;
}

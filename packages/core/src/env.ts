import { z } from "zod";

/**
 * Environment configuration shared by every MOTH service.
 * Each service validates only what it needs via `loadEnv(schema)`.
 */
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("production"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  /** 32+ char secret used to derive the AES-256-GCM key for stored credentials. */
  MOTH_ENCRYPTION_KEY: z.string().min(32, "MOTH_ENCRYPTION_KEY must be at least 32 characters"),
  /** Shared secret for dashboard -> bot internal API calls. */
  INTERNAL_API_SECRET: z.string().min(24, "INTERNAL_API_SECRET must be at least 24 characters"),
  BOT_INTERNAL_URL: z.string().url().default("http://bot:4100"),
  /** Comma separated Discord user IDs with platform-owner (System page) access. */
  MOTH_OWNER_IDS: z.string().default(""),
  /** Optional global AI provider (used when a guild has none configured). */
  AI_PROVIDER: z.preprocess((v) => (v === "" ? undefined : v), z.enum(["openai", "anthropic", "ollama", "openai-compatible", "none"]).default("none")),
  AI_BASE_URL: z.string().optional(),
  AI_MODEL: z.string().optional(),
  AI_API_KEY: z.string().optional(),
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;

export function loadEnv<T extends z.ZodTypeAny>(schema: T, source: NodeJS.ProcessEnv = process.env): z.infer<T> {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    // eslint-disable-next-line no-console
    console.error(`[moth] Invalid environment configuration:\n${issues}`);
    process.exit(78); // EX_CONFIG
  }
  return parsed.data;
}

export function ownerIds(env: Pick<BaseEnv, "MOTH_OWNER_IDS">): Set<string> {
  return new Set(env.MOTH_OWNER_IDS.split(",").map((s) => s.trim()).filter(Boolean));
}

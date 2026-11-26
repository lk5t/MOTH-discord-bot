import pino, { type Logger } from "pino";

export type { Logger };

/** Structured JSON logger. Pretty output in development when pino-pretty is installed. */
export function createLogger(service: string, level = process.env.LOG_LEVEL ?? "info"): Logger {
  const pretty = process.env.NODE_ENV === "development" && process.env.MOTH_PRETTY_LOGS !== "0";
  return pino({
    name: service,
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ["*.token", "*.apiKey", "*.password", "*.secret", "*.authorization", "headers.authorization"],
      censor: "[redacted]",
    },
    ...(pretty ? { transport: { target: "pino-pretty", options: { colorize: true } } } : {}),
  });
}

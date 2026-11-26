import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const ALGO = "aes-256-gcm";
let cachedKey: { secret: string; key: Buffer } | null = null;

function keyFor(secret: string): Buffer {
  if (cachedKey?.secret === secret) return cachedKey.key;
  const key = scryptSync(secret, "moth-credential-store-v1", 32);
  cachedKey = { secret, key };
  return key;
}

/** Encrypts a secret for at-rest storage. Format: v1:<iv>:<tag>:<ciphertext> (base64url). */
export function encryptSecret(plain: string, secret = process.env.MOTH_ENCRYPTION_KEY ?? ""): string {
  if (!secret) throw new Error("MOTH_ENCRYPTION_KEY is not configured");
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, keyFor(secret), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), data.toString("base64url")].join(":");
}

export function decryptSecret(payload: string, secret = process.env.MOTH_ENCRYPTION_KEY ?? ""): string {
  const [version, iv, tag, data] = payload.split(":");
  if (version !== "v1" || !iv || !tag || !data) throw new Error("Unsupported secret payload");
  const decipher = createDecipheriv(ALGO, keyFor(secret), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Masks a secret for display, e.g. "sk-…a1b2". */
export function maskSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.length <= 8 ? "••••" : `${value.slice(0, 3)}…${value.slice(-4)}`;
}

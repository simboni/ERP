import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { loadConfig } from "../config";

/**
 * Application-layer encryption for high-sensitivity PII (05-security.md §2)
 * — currently employee national IDs. AES-256-GCM with a versioned wire
 * format `v1:<iv>:<tag>:<ciphertext>` (base64url) so key rotation can
 * introduce v2 without a migration scramble. The key derives from
 * DATA_ENCRYPTION_KEY (production) — dev falls back to a fixed dev key.
 */
function key(): Buffer {
  const secret =
    process.env.DATA_ENCRYPTION_KEY ??
    (loadConfig().jwtSecret === "dev-only-secret-do-not-use-in-production"
      ? "dev-only-data-key"
      : undefined);
  if (!secret) {
    throw new Error("DATA_ENCRYPTION_KEY must be set in production");
  }
  return createHash("sha256").update(secret).digest();
}

export function encryptPii(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${ct.toString("base64url")}`;
}

export function decryptPii(stored: string): string {
  const [version, ivB64, tagB64, ctB64] = stored.split(":");
  if (version !== "v1" || !ivB64 || !tagB64 || !ctB64) {
    throw new Error("Unrecognized PII ciphertext format");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key(),
    Buffer.from(ivB64, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function isEncryptedPii(value: string | null): boolean {
  return typeof value === "string" && value.startsWith("v1:");
}

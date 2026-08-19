import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";

const KEY_PREFIX_HEADER = "gwk_";

export function generateApiKey(): { plaintext: string; prefix: string; hash: string } {
  const prefix = randomBytes(6).toString("hex");
  const secret = randomBytes(24).toString("hex");
  const plaintext = `${KEY_PREFIX_HEADER}${prefix}_${secret}`;
  return {
    plaintext,
    prefix,
    hash: hashApiKey(plaintext)
  };
}

export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(env.apiKeyPepper).update(plaintext).digest("hex");
}

export function extractPrefix(plaintext: string): string | null {
  if (!plaintext.startsWith(KEY_PREFIX_HEADER)) {
    return null;
  }
  const rest = plaintext.slice(KEY_PREFIX_HEADER.length);
  const underscore = rest.indexOf("_");
  if (underscore <= 0) {
    return null;
  }
  return rest.slice(0, underscore);
}

export function hashesEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  if (a.length === 0 || a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

export function secretsEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) {
    const padded = Buffer.alloc(Math.max(a.length, b.length));
    timingSafeEqual(padded.subarray(0, Math.min(a.length, padded.length)), padded.subarray(0, Math.min(a.length, padded.length)));
    return false;
  }
  return timingSafeEqual(a, b);
}

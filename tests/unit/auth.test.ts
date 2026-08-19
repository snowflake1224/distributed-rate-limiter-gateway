import { describe, expect, it } from "vitest";
import { extractPrefix, generateApiKey, hashApiKey, hashesEqual, secretsEqual } from "../../src/auth/apiKeys.js";

describe("API key hashing", () => {
  it("never returns the plaintext as the stored hash", () => {
    const generated = generateApiKey();
    expect(generated.hash).not.toBe(generated.plaintext);
    expect(generated.hash).toHaveLength(64);
    expect(generated.plaintext.startsWith("gwk_")).toBe(true);
    expect(extractPrefix(generated.plaintext)).toBe(generated.prefix);
  });

  it("uses constant-time comparison for equal hashes", () => {
    const generated = generateApiKey();
    expect(hashesEqual(generated.hash, hashApiKey(generated.plaintext))).toBe(true);
    expect(hashesEqual(generated.hash, hashApiKey("gwk_ffffffff_deadbeef"))).toBe(false);
  });

  it("rejects different-length secrets without throwing", () => {
    expect(secretsEqual("abc", "ab")).toBe(false);
    expect(secretsEqual("admin", "admin")).toBe(true);
  });
});

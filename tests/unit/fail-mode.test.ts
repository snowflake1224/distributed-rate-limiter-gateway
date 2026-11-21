import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../src/errors.js";
import { evaluateRateLimit } from "../../src/ratelimit/engine.js";
import { redis } from "../../src/redis/client.js";
import type { Policy } from "../../src/types.js";

const basePolicy: Policy = {
  id: "pol-1",
  tenantId: "ten-1",
  name: "default",
  algorithm: "token_bucket",
  limitCount: 10,
  windowMs: 1000,
  refillRatePerSec: 10,
  burstCapacity: 10,
  dimensions: ["tenant"],
  customHeader: null,
  failMode: "fail_closed",
  status: "active",
  version: 1
};

describe("evaluateRateLimit Redis failure fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws 503 service_unavailable when failMode is fail_closed and Redis fails", async () => {
    vi.spyOn(redis, "tokenBucket").mockRejectedValueOnce(new Error("Command timed out"));

    await expect(evaluateRateLimit({ ...basePolicy, failMode: "fail_closed" }, "rl:k1")).rejects.toMatchObject({
      statusCode: 503,
      code: "service_unavailable"
    } satisfies Partial<HttpError>);
  });

  it("allows the request with remaining=-1 when failMode is fail_open and Redis fails", async () => {
    vi.spyOn(redis, "tokenBucket").mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const decision = await evaluateRateLimit({ ...basePolicy, failMode: "fail_open" }, "rl:k2");
    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(-1);
    expect(decision.limit).toBe(10);
  });
});

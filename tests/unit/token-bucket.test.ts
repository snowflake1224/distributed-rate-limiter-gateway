import { describe, expect, it } from "vitest";
import { applyTokenBucket } from "../../src/ratelimit/algorithms.js";

describe("token bucket mathematics", () => {
  it("allows a full burst then rejects until refill", () => {
    let state = null;
    let now = 1_000_000;
    let allowed = 0;
    let denied = 0;
    for (let i = 0; i < 12; i += 1) {
      const result = applyTokenBucket(state, now, 10, 10, 1);
      state = result.state;
      if (result.allowed) {
        allowed += 1;
      } else {
        denied += 1;
      }
    }
    expect(allowed).toBe(10);
    expect(denied).toBe(2);
  });

  it("refills at the configured rate", () => {
    let result = applyTokenBucket(null, 0, 10, 10, 10);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(0);
    result = applyTokenBucket(result.state, 500, 10, 10, 1);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it("never exceeds capacity after a long idle period", () => {
    let result = applyTokenBucket(null, 0, 5, 100, 1);
    result = applyTokenBucket(result.state, 60_000, 5, 100, 1);
    expect(result.remaining).toBe(4);
    expect(result.state.tokens).toBeLessThanOrEqual(5);
  });

  it("computes retry-after from missing tokens", () => {
    let result = applyTokenBucket(null, 0, 1, 2, 1);
    result = applyTokenBucket(result.state, 0, 1, 2, 1);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBe(500);
  });
});

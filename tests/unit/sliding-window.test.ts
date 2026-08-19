import { describe, expect, it } from "vitest";
import { applySlidingWindow } from "../../src/ratelimit/algorithms.js";

describe("sliding window mathematics", () => {
  it("allows exactly limit requests inside the window", () => {
    let timestamps: number[] = [];
    const now = 10_000;
    let allowed = 0;
    for (let i = 0; i < 6; i += 1) {
      const result = applySlidingWindow(timestamps, now + i, 1_000, 5);
      timestamps = result.timestamps;
      if (result.allowed) {
        allowed += 1;
      }
    }
    expect(allowed).toBe(5);
  });

  it("admits a new request once the oldest event exits the window", () => {
    let timestamps = [1000, 1100, 1200];
    let result = applySlidingWindow(timestamps, 1500, 1000, 3);
    expect(result.allowed).toBe(false);
    result = applySlidingWindow(result.timestamps, 2001, 1000, 3);
    expect(result.allowed).toBe(true);
  });

  it("sets retry-after from the oldest timestamp", () => {
    const result = applySlidingWindow([1000, 1100], 1500, 1000, 2);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBe(500);
    expect(result.resetMs).toBe(2000);
  });
});

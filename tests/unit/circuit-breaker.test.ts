import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "../../src/circuitbreaker/breaker.js";

describe("circuit breaker", () => {
  it("stays closed below the failure threshold", () => {
    const breaker = new CircuitBreaker({
      name: "u1",
      failureThreshold: 3,
      recoveryMs: 50,
      halfOpenMaxProbes: 1
    });
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe("closed");
    expect(breaker.canPass()).toBe(true);
  });

  it("opens after the threshold and rejects traffic", () => {
    const breaker = new CircuitBreaker({
      name: "u2",
      failureThreshold: 2,
      recoveryMs: 60_000,
      halfOpenMaxProbes: 1
    });
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe("open");
    expect(breaker.canPass()).toBe(false);
  });

  it("moves to half-open after recovery and closes on a successful probe", async () => {
    const breaker = new CircuitBreaker({
      name: "u3",
      failureThreshold: 1,
      recoveryMs: 20,
      halfOpenMaxProbes: 1
    });
    breaker.recordFailure();
    expect(breaker.getState()).toBe("open");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(breaker.canPass()).toBe(true);
    expect(breaker.getState()).toBe("half_open");
    expect(breaker.canPass()).toBe(false);
    breaker.recordSuccess();
    expect(breaker.getState()).toBe("closed");
  });

  it("re-opens when a half-open probe fails", async () => {
    const breaker = new CircuitBreaker({
      name: "u4",
      failureThreshold: 1,
      recoveryMs: 15,
      halfOpenMaxProbes: 1
    });
    breaker.recordFailure();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(breaker.canPass()).toBe(true);
    breaker.recordFailure();
    expect(breaker.getState()).toBe("open");
  });
});

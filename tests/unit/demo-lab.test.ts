import request from "supertest";
import { describe, expect, it } from "vitest";
import { CircuitBreaker, getBreaker, peekBreaker, removeBreaker } from "../../src/circuitbreaker/breaker.js";
import { labBasePath, parseLabPath } from "../../src/demo/labSpec.js";
import { classifyOutcome } from "../../src/demo/runner.js";
import { policyConfigSchema, runSchema, sandboxCreateSchema, upstreamConfigSchema } from "../../src/demo/schemas.js";
import { buildUpstreamUrl } from "../../src/proxy/upstream.js";
import { createUpstreamApp } from "../../src/upstream/app.js";

const basePolicy = {
  algorithm: "token_bucket" as const,
  burstCapacity: 10,
  refillRatePerSec: 1,
  limitCount: 10,
  windowMs: 10_000,
  dimensions: ["tenant", "api_key", "route"] as Array<"tenant" | "api_key" | "route" | "ip" | "custom">
};

describe("sandbox schemas", () => {
  it("accepts a valid policy and fills defaults", () => {
    const parsed = policyConfigSchema.parse(basePolicy);
    expect(parsed.failMode).toBe("fail_closed");
    expect(parsed.customHeader).toBe("x-user-id");
  });

  it("rejects values outside the public bounds", () => {
    expect(policyConfigSchema.safeParse({ ...basePolicy, burstCapacity: 101 }).success).toBe(false);
    expect(policyConfigSchema.safeParse({ ...basePolicy, refillRatePerSec: 0 }).success).toBe(false);
    expect(policyConfigSchema.safeParse({ ...basePolicy, windowMs: 500 }).success).toBe(false);
    expect(policyConfigSchema.safeParse({ ...basePolicy, dimensions: [] }).success).toBe(false);
    expect(policyConfigSchema.safeParse({ ...basePolicy, dimensions: ["tenant", "tenant"] }).success).toBe(false);
    expect(policyConfigSchema.safeParse({ ...basePolicy, customHeader: "Authorization" }).success).toBe(false);
  });

  it("never accepts a user-supplied upstream URL", () => {
    const parsed = upstreamConfigSchema.parse({ baseUrl: "http://169.254.169.254/" } as unknown);
    expect(parsed).not.toHaveProperty("baseUrl");
  });

  it("defaults the upstream block when omitted", () => {
    const parsed = sandboxCreateSchema.parse({ policy: basePolicy });
    expect(parsed.upstream.cbFailureThreshold).toBe(3);
    expect(parsed.upstream.errorStatus).toBe(503);
  });

  it("bounds runner requests and blocks runner-controlled headers", () => {
    const ok = { path: "/sbx/abc/orders", count: 50, concurrency: 10 };
    expect(runSchema.safeParse(ok).success).toBe(true);
    expect(runSchema.safeParse({ ...ok, count: 201 }).success).toBe(false);
    expect(runSchema.safeParse({ ...ok, concurrency: 51 }).success).toBe(false);
    expect(runSchema.safeParse({ ...ok, headers: { "x-forwarded-for": "1.2.3.4" } }).success).toBe(false);
    expect(runSchema.safeParse({ ...ok, headers: { "x-api-key": "gwk_x_y" } }).success).toBe(false);
    expect(runSchema.safeParse({ ...ok, headers: { "x-user-id": "u1" } }).success).toBe(true);
  });
});

describe("lab spec", () => {
  const spec = { sandboxId: "a1b2c3d4e5", revision: 3, delayMs: 200, failRatePct: 25, failFirstN: 3, errorStatus: 503 };

  it("round-trips through the upstream base path", () => {
    const parsed = parseLabPath(`${labBasePath(spec)}/orders/42`);
    expect(parsed?.spec).toEqual(spec);
    expect(parsed?.rest).toBe("/orders/42");
  });

  it("rejects unknown shapes and status codes", () => {
    expect(parseLabPath("/lab/x/r1/d0/f0/n0/s404/a")).toBeNull();
    expect(parseLabPath("/something/else")).toBeNull();
  });
});

describe("programmable lab upstream", () => {
  const path = labBasePath({ sandboxId: "abc123", revision: 1, delayMs: 0, failRatePct: 0, failFirstN: 2, errorStatus: 502 });

  it("fails exactly the first N requests, then succeeds", async () => {
    const app = createUpstreamApp({ mode: "lab" });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      statuses.push((await request(app).get(`${path}/orders`)).status);
    }
    expect(statuses).toEqual([502, 502, 200, 200]);
  });

  it("restarts the counter when the revision changes", async () => {
    const app = createUpstreamApp({ mode: "lab" });
    await request(app).get(`${path}/a`);
    await request(app).get(`${path}/a`);
    const next = path.replace("/r1/", "/r2/");
    expect((await request(app).get(`${next}/a`)).status).toBe(502);
  });

  it("applies the fail rate using the injected random source", async () => {
    const always = labBasePath({ sandboxId: "abc124", revision: 1, delayMs: 0, failRatePct: 50, failFirstN: 0, errorStatus: 500 });
    const low = createUpstreamApp({ mode: "lab", random: () => 0.1 });
    const high = createUpstreamApp({ mode: "lab", random: () => 0.9 });
    expect((await request(low).get(`${always}/x`)).status).toBe(500);
    expect((await request(high).get(`${always}/x`)).status).toBe(200);
  });
});

describe("runner outcome classification", () => {
  it("separates edge, limiter, breaker and upstream outcomes", () => {
    expect(classifyOutcome(200, "{}", true)).toBe("allowed");
    expect(classifyOutcome(503, "<html>", false)).toBe("edge_rejected");
    expect(classifyOutcome(429, JSON.stringify({ error: { code: "rate_limited", message: "x" } }), true)).toBe("rate_limited");
    expect(
      classifyOutcome(503, JSON.stringify({ error: { code: "service_unavailable", message: "Upstream circuit open" } }), true)
    ).toBe("circuit_open");
    expect(classifyOutcome(503, JSON.stringify({ error: "lab upstream failure" }), true)).toBe("upstream_error");
    expect(classifyOutcome(504, JSON.stringify({ error: { code: "gateway_timeout", message: "t" } }), true)).toBe("upstream_error");
    expect(classifyOutcome(401, JSON.stringify({ error: { code: "unauthorized", message: "x" } }), true)).toBe("gateway_error");
  });
});

describe("upstream URL building", () => {
  it("keeps base paths and still works for bare hosts", () => {
    expect(buildUpstreamUrl("http://up:4000", "/api/orders", "?a=1").toString()).toBe("http://up:4000/api/orders?a=1");
    expect(buildUpstreamUrl("http://lab:4000/lab/x/r1", "/orders", "").toString()).toBe("http://lab:4000/lab/x/r1/orders");
    expect(buildUpstreamUrl("http://lab:4000/base/", "/", "").toString()).toBe("http://lab:4000/base/");
  });
});

describe("breaker reconfiguration", () => {
  it("applies new thresholds to an existing breaker without losing state", () => {
    const options = { name: "reconf-1", failureThreshold: 5, recoveryMs: 60_000, halfOpenMaxProbes: 1 };
    getBreaker(options).recordFailure();
    const breaker = getBreaker({ ...options, failureThreshold: 2 });
    breaker.recordFailure();
    expect(breaker.getState()).toBe("open");
    expect(peekBreaker("reconf-1")?.failureThreshold).toBe(2);
    removeBreaker("reconf-1");
    expect(peekBreaker("reconf-1")).toBeNull();
  });

  it("reports remaining recovery time while open", () => {
    const breaker = new CircuitBreaker({ name: "snap-1", failureThreshold: 1, recoveryMs: 10_000, halfOpenMaxProbes: 1 });
    breaker.recordFailure();
    const snap = breaker.snapshot();
    expect(snap.state).toBe("open");
    expect(snap.retryInMs).toBeGreaterThan(9_000);
  });
});

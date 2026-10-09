import { describe, expect, it } from "vitest";
import { expectationFor, percentile, simulateSlidingWindow, simulateTokenBucket, startingCapacity, summarize } from "./analysis";
import { classifyOutcome } from "./classify";
import { DEFAULT_POLICY, DEFAULT_RUN } from "./defaults";
import { toCsv, toCurl, toK6, toPowerShell } from "./exporters";
import type { ResultRow, Run, RunOutcome } from "./types";
import { validatePolicy, validateRun } from "./validation";

function row(seq: number, outcome: RunOutcome, extra: Partial<ResultRow> = {}): ResultRow {
  return {
    seq,
    target: "http://x",
    instance: seq % 2 === 0 ? "gateway-1" : "gateway-2",
    status: outcome === "allowed" ? 200 : outcome === "rate_limited" ? 429 : 503,
    outcome,
    startedAtMs: seq * 10,
    latencyMs: 5,
    limit: 10,
    remaining: null,
    reset: null,
    retryAfter: null,
    policyVersion: 1,
    requestId: `r${seq}`,
    headers: {},
    body: "",
    ...extra
  };
}

function burstRun(allowed: number, limited: number, concurrency = 1): Run {
  const rows: ResultRow[] = [];
  for (let i = 0; i < allowed; i += 1) {
    rows.push(row(i, "allowed", { remaining: 9 - i, startedAtMs: i }));
  }
  for (let i = 0; i < limited; i += 1) {
    rows.push(row(allowed + i, "rate_limited", { remaining: 0, startedAtMs: allowed + i }));
  }
  return {
    id: "r",
    label: "burst",
    startedAt: new Date().toISOString(),
    durationMs: 50,
    config: { ...DEFAULT_RUN, path: "/sbx/abc/orders", count: rows.length, concurrency },
    policy: { ...DEFAULT_POLICY, burstCapacity: 10, refillRatePerSec: 0.1, version: 1 },
    upstream: null,
    rows,
    targets: []
  };
}

describe("classifyOutcome", () => {
  it("distinguishes nginx, limiter, breaker and upstream", () => {
    expect(classifyOutcome(503, "<html>", false)).toBe("edge_rejected");
    expect(classifyOutcome(429, '{"error":{"code":"rate_limited","message":"x"}}', true)).toBe("rate_limited");
    expect(classifyOutcome(503, '{"error":{"code":"service_unavailable","message":"Upstream circuit open"}}', true)).toBe("circuit_open");
    expect(classifyOutcome(503, '{"error":"lab upstream failure"}', true)).toBe("upstream_error");
    expect(classifyOutcome(0, "", false)).toBe("network_error");
    expect(classifyOutcome(200, "{}", true)).toBe("allowed");
  });
});

describe("token bucket and sliding window models", () => {
  it("allows the burst then refills over time", () => {
    expect(simulateTokenBucket(Array.from({ length: 20 }, () => 0), 10, 10, 1)).toBe(10);
    expect(simulateTokenBucket([0, 0, 0, 1000, 2000], 3, 3, 1)).toBe(5);
  });

  it("enforces the rolling window", () => {
    const starts = Array.from({ length: 10 }, (_, i) => i * 500);
    expect(simulateSlidingWindow(starts, 0, 5, 10_000)).toBe(5);
    expect(simulateSlidingWindow([0, 0, 0, 1_100, 1_100], 0, 3, 1_000)).toBe(5);
  });

  it("reads starting capacity from the highest remaining in the opening slice", () => {
    const rows = [row(0, "allowed", { remaining: 3 }), row(1, "allowed", { remaining: 9 }), row(2, "rate_limited")];
    expect(startingCapacity(rows, 1, 10)).toBe(4);
    expect(startingCapacity(rows, 2, 10)).toBe(10);
    expect(startingCapacity([row(0, "rate_limited")], 1, 10)).toBe(0);
  });
});

describe("expectationFor", () => {
  it("matches an exact burst", () => {
    const e = expectationFor(burstRun(10, 5));
    expect(e.expectedAllowed).toBe(10);
    expect(e.observedAllowed).toBe(10);
    expect(e.verdict).toBe("match");
    expect(e.naivePerInstanceAllowed).toBe(15);
  });

  it("flags a real deviation", () => {
    const run = burstRun(10, 5);
    run.rows[11] = { ...run.rows[11]!, outcome: "allowed", status: 200 };
    run.rows[12] = { ...run.rows[12]!, outcome: "allowed", status: 200 };
    const e = expectationFor(run);
    expect(e.difference).toBe(2);
    expect(e.verdict).toBe("deviation");
  });

  it("excludes edge rejections and explains them", () => {
    const run = burstRun(10, 0);
    run.rows.push(row(99, "edge_rejected", { instance: null }));
    const e = expectationFor(run);
    expect(e.limiterDecisions).toBe(10);
    expect(e.notes.join(" ")).toMatch(/Nginx/);
  });

  it("is not applicable without a known sandbox policy", () => {
    const run = { ...burstRun(1, 0), policy: null };
    expect(expectationFor(run).applicable).toBe(false);
  });
});

describe("summarize", () => {
  it("computes percentiles and instance split", () => {
    const s = summarize(burstRun(4, 2).rows);
    expect(s.total).toBe(6);
    expect(s.byInstance.map((i) => i.instance)).toEqual(["gateway-1", "gateway-2"]);
    expect(s.firstRateLimitedSeq).toBe(4);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
  });
});

describe("exporters", () => {
  const run = burstRun(2, 1);

  it("writes CSV with a header and one line per request", () => {
    const lines = toCsv(run).trim().split("\n");
    expect(lines[0]).toContain("seq,startedAtMs");
    expect(lines).toHaveLength(4);
  });

  it("produces reproducible commands with the sandbox key", () => {
    const config = { ...run.config, rotateHeader: { name: "x-user-id", values: 3 } };
    expect(toCurl(config, "https://lab.example", "gwk_a_b")).toContain("x-api-key: gwk_a_b");
    expect(toCurl(config, "https://lab.example", "gwk_a_b")).toContain("user-$((i % 3))");
    expect(toPowerShell(config, "https://lab.example", "gwk_a_b")).toContain("Invoke-WebRequest");
    expect(toK6(config, "https://lab.example", "gwk_a_b")).toContain("shared-iterations");
  });
});

describe("validation", () => {
  it("validates policy bounds and custom header shape", () => {
    expect(validatePolicy(DEFAULT_POLICY)).toEqual([]);
    expect(validatePolicy({ ...DEFAULT_POLICY, burstCapacity: 0 })).not.toEqual([]);
    expect(validatePolicy({ ...DEFAULT_POLICY, dimensions: ["custom"], customHeader: "User" })).not.toEqual([]);
  });

  it("keeps sandbox runs inside the sandbox route and caps browser concurrency", () => {
    const base = { ...DEFAULT_RUN, path: "/sbx/abc/orders" };
    expect(validateRun(base, "/sbx/abc")).toEqual([]);
    expect(validateRun({ ...base, path: "/api/orders" }, "/sbx/abc")).not.toEqual([]);
    expect(validateRun({ ...base, concurrency: 20 }, "/sbx/abc").join(" ")).toMatch(/server-side/);
    expect(validateRun({ ...base, mode: "server", concurrency: 20 }, "/sbx/abc")).toEqual([]);
    expect(validateRun({ ...base, headers: { "x-forwarded-for": "1.1.1.1" } }, "/sbx/abc")).not.toEqual([]);
  });
});

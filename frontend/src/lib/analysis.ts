import { OUTCOME_ORDER } from "./classify";
import type { ResultRow, Run, RunOutcome } from "./types";

export interface RunSummary {
  total: number;
  outcomes: Record<RunOutcome, number>;
  byInstance: Array<{ instance: string; total: number; allowed: number }>;
  latency: { p50: number; p95: number; p99: number; max: number };
  firstRateLimitedSeq: number | null;
  elapsedSec: number;
  observedAllowedPerSec: number;
  policyVersions: number[];
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!;
}

export function byStartTime(rows: ResultRow[]): ResultRow[] {
  return [...rows].sort((a, b) => a.startedAtMs - b.startedAtMs || a.seq - b.seq);
}

export function summarize(rows: ResultRow[]): RunSummary {
  const outcomes = Object.fromEntries(OUTCOME_ORDER.map((o) => [o, 0])) as Record<RunOutcome, number>;
  const instances = new Map<string, { total: number; allowed: number }>();
  for (const row of rows) {
    outcomes[row.outcome] += 1;
    const name = row.instance ?? (row.outcome === "edge_rejected" ? "nginx (edge)" : "no response");
    const entry = instances.get(name) ?? { total: 0, allowed: 0 };
    entry.total += 1;
    if (row.outcome === "allowed") {
      entry.allowed += 1;
    }
    instances.set(name, entry);
  }
  const latencies = rows.filter((r) => r.status !== 0).map((r) => r.latencyMs).sort((a, b) => a - b);
  const ordered = byStartTime(rows);
  const firstLimited = ordered.find((r) => r.outcome === "rate_limited");
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const elapsedSec = first && last ? Math.max(0, (last.startedAtMs + last.latencyMs - first.startedAtMs) / 1000) : 0;
  return {
    total: rows.length,
    outcomes,
    byInstance: [...instances.entries()]
      .map(([instance, v]) => ({ instance, ...v }))
      .sort((a, b) => a.instance.localeCompare(b.instance)),
    latency: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      max: latencies[latencies.length - 1] ?? 0
    },
    firstRateLimitedSeq: firstLimited ? firstLimited.seq : null,
    elapsedSec,
    observedAllowedPerSec: elapsedSec > 0 ? outcomes.allowed / elapsedSec : outcomes.allowed,
    policyVersions: [...new Set(rows.map((r) => r.policyVersion).filter((v): v is number => v !== null))].sort((a, b) => a - b)
  };
}

export function dimensionValueOf(row: ResultRow, run: Run): string {
  if (row.dimensionValue) {
    return row.dimensionValue;
  }
  if (run.config.rotateHeader) {
    return `user-${row.seq % run.config.rotateHeader.values}`;
  }
  return "all";
}

export interface ExpectationGroup {
  key: string;
  requests: number;
  startTokens: number | null;
  expectedAllowed: number;
  observedAllowed: number;
}

export interface Expectation {
  applicable: boolean;
  reason?: string;
  model: string;
  expectedAllowed: number;
  observedAllowed: number;
  limiterDecisions: number;
  difference: number;
  tolerance: number;
  verdict: "match" | "within_tolerance" | "deviation" | "not_applicable";
  groups: ExpectationGroup[];
  notes: string[];
  naivePerInstanceAllowed: number | null;
}

function limiterRows(rows: ResultRow[]): ResultRow[] {
  return rows.filter((r) => r.outcome === "allowed" || r.outcome === "rate_limited" || r.outcome === "upstream_error" || r.outcome === "circuit_open");
}

export function startingCapacity(rows: ResultRow[], concurrency: number, fallback: number): number {
  const opening = rows.slice(0, Math.max(1, concurrency));
  if (opening.length === 0) {
    return fallback;
  }
  const passed = opening.filter((r) => r.outcome !== "rate_limited");
  if (passed.length === 0) {
    return 0;
  }
  const remaining = passed.map((r) => r.remaining).filter((v): v is number => v !== null && v >= 0);
  return remaining.length > 0 ? Math.max(...remaining) + 1 : fallback;
}

export function simulateTokenBucket(
  startsMs: number[],
  startTokens: number,
  capacity: number,
  refillPerSec: number
): number {
  let tokens = Math.min(capacity, startTokens);
  let last = startsMs[0] ?? 0;
  let allowed = 0;
  for (const t of startsMs) {
    tokens = Math.min(capacity, tokens + ((t - last) * refillPerSec) / 1000);
    last = t;
    if (tokens >= 1) {
      tokens -= 1;
      allowed += 1;
    }
  }
  return allowed;
}

export function simulateSlidingWindow(startsMs: number[], priorCount: number, limit: number, windowMs: number): number {
  const accepted: number[] = [];
  const first = startsMs[0] ?? 0;
  const prior = Array.from({ length: Math.min(limit, priorCount) }, () => first);
  let allowed = 0;
  for (const t of startsMs) {
    const live = [...prior, ...accepted].filter((at) => at > t - windowMs).length;
    if (live < limit) {
      accepted.push(t);
      allowed += 1;
    }
  }
  return allowed;
}

export function expectationFor(run: Run): Expectation {
  const base: Expectation = {
    applicable: false,
    model: "",
    expectedAllowed: 0,
    observedAllowed: 0,
    limiterDecisions: 0,
    difference: 0,
    tolerance: 0,
    verdict: "not_applicable",
    groups: [],
    notes: [],
    naivePerInstanceAllowed: null
  };
  const policy = run.policy;
  if (!policy || run.config.credential !== "sandbox") {
    return { ...base, reason: "Expected values are computed only for runs against your sandbox, where the policy is known." };
  }
  if (policy.failMode === "fail_open" && run.rows.some((r) => r.remaining === -1)) {
    base.notes.push("Some decisions were made in fail-open mode (Redis unreachable), so they bypassed the limiter.");
  }

  const decided = limiterRows(run.rows);
  const edge = run.rows.filter((r) => r.outcome === "edge_rejected").length;
  const network = run.rows.filter((r) => r.outcome === "network_error").length;
  const gateway = run.rows.filter((r) => r.outcome === "gateway_error").length;

  const groupsMap = new Map<string, ResultRow[]>();
  const customActive = policy.dimensions.includes("custom") && run.config.rotateHeader?.name === policy.customHeader;
  for (const row of byStartTime(decided)) {
    const key = customActive ? dimensionValueOf(row, run) : "all";
    groupsMap.set(key, [...(groupsMap.get(key) ?? []), row]);
  }

  const concurrency = run.config.mode === "single" ? 1 : run.config.concurrency;
  const groups: ExpectationGroup[] = [];
  for (const [key, rows] of groupsMap) {
    const starts = rows.map((r) => r.startedAtMs);
    const observedAllowed = rows.filter((r) => r.outcome !== "rate_limited").length;
    if (policy.algorithm === "token_bucket") {
      const startTokens = startingCapacity(rows, concurrency, policy.burstCapacity);
      groups.push({
        key,
        requests: rows.length,
        startTokens,
        expectedAllowed: simulateTokenBucket(starts, startTokens, policy.burstCapacity, policy.refillRatePerSec),
        observedAllowed
      });
    } else {
      const startTokens = startingCapacity(rows, concurrency, policy.limitCount);
      groups.push({
        key,
        requests: rows.length,
        startTokens,
        expectedAllowed: simulateSlidingWindow(starts, policy.limitCount - startTokens, policy.limitCount, policy.windowMs),
        observedAllowed
      });
    }
  }

  const expectedAllowed = groups.reduce((sum, g) => sum + g.expectedAllowed, 0);
  const observedAllowed = groups.reduce((sum, g) => sum + g.observedAllowed, 0);
  const difference = observedAllowed - expectedAllowed;
  const refillDuringFlight =
    policy.algorithm === "token_bucket"
      ? Math.ceil((policy.refillRatePerSec * Math.max(...decided.map((r) => r.latencyMs), 0)) / 1000)
      : 0;
  const tolerance = groups.length * (concurrency > 1 ? 1 + refillDuringFlight : refillDuringFlight > 0 ? 1 : 0);

  const notes = [...base.notes];
  notes.push(
    "Start state comes from the first response's RateLimit-Remaining header, so earlier runs that drained the bucket are accounted for."
  );
  if (concurrency > 1) {
    notes.push(
      `Requests were in flight ${concurrency} at a time, so the order Redis saw them can differ slightly from the browser's send order. Tolerance: ±${tolerance}.`
    );
  }
  if (edge > 0) {
    notes.push(
      `${edge} request(s) were rejected by Nginx limit_req (per-IP edge protection) before reaching a gateway. They are excluded from the limiter math.`
    );
  }
  if (network > 0) {
    notes.push(`${network} request(s) failed at the network level and are excluded.`);
  }
  if (gateway > 0) {
    notes.push(`${gateway} request(s) got a gateway error (e.g. 401/404/503 limiter unavailable) and are excluded.`);
  }
  if (run.rows.some((r) => r.policyVersion !== null && r.policyVersion !== policy.version)) {
    notes.push(
      "Some responses were decided with a different policy version than the one shown. That is the per-instance config cache (TTL) catching up after an edit."
    );
  }

  const instances = new Set(decided.map((r) => r.instance).filter(Boolean)).size;
  const capacity = policy.algorithm === "token_bucket" ? policy.burstCapacity : policy.limitCount;
  const naive = instances > 1 ? Math.min(decided.length, capacity * instances * groups.length) : null;

  const abs = Math.abs(difference);
  return {
    applicable: decided.length > 0,
    reason: decided.length === 0 ? "No request reached the rate limiter." : undefined,
    model:
      policy.algorithm === "token_bucket"
        ? `Token bucket: capacity ${policy.burstCapacity}, refill ${policy.refillRatePerSec}/s, replayed against the actual send times`
        : `Sliding window: ${policy.limitCount} per ${policy.windowMs / 1000}s, replayed against the actual send times`,
    expectedAllowed,
    observedAllowed,
    limiterDecisions: decided.length,
    difference,
    tolerance,
    verdict: decided.length === 0 ? "not_applicable" : abs === 0 ? "match" : abs <= tolerance ? "within_tolerance" : "deviation",
    groups,
    notes,
    naivePerInstanceAllowed: naive
  };
}

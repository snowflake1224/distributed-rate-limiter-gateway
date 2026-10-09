import { expectationFor, simulateTokenBucket } from "./analysis";
import type { InstanceState, PolicyConfig, ResultRow, Run, RunConfig, RunOutcome, SandboxSession, UpstreamConfig } from "./types";

export interface LabContext {
  configure(
    policy: Partial<PolicyConfig>,
    upstream?: Partial<UpstreamConfig>,
    options?: { restartCounter?: boolean; resetCircuit?: boolean }
  ): Promise<SandboxSession & { handledBy?: string }>;
  patchPolicy(partial: Partial<PolicyConfig>): Promise<SandboxSession & { handledBy?: string }>;
  run(partial: Partial<RunConfig>, label: string, signal?: AbortSignal): Promise<Run>;
  state(): Promise<InstanceState[]>;
  session(): SandboxSession | null;
  signal: AbortSignal;
  log(text: string): void;
}

export interface ExperimentParam {
  key: string;
  label: string;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  defaultValue: number;
  options?: Array<{ value: number; label: string }>;
}

export type Params = Record<string, number>;
export type StepStatus = "pending" | "running" | "done" | "failed";

export interface StepUpdate {
  status: StepStatus;
  result?: string;
  runId?: string;
}

export interface Check {
  label: string;
  status: "pass" | "fail" | "info";
  detail: string;
}

export interface ExperimentOutcome {
  checks: Check[];
  conclusion: string;
}

export interface ExperimentEnv {
  policyCacheTtlMs: number;
}

export type Reporter = (index: number, update: StepUpdate) => void;

export interface Experiment {
  id: string;
  title: string;
  teaser: string;
  params: ExperimentParam[];
  hypothesis(p: Params): string;
  steps(p: Params): string[];
  commands?: string;
  execute(ctx: LabContext, p: Params, report: Reporter, env: ExperimentEnv): Promise<ExperimentOutcome>;
}

const BASE_POLICY: Partial<PolicyConfig> = { dimensions: ["tenant", "api_key", "route"], failMode: "fail_closed" };
const HEALTHY: Partial<UpstreamConfig> = { delayMs: 0, failRatePct: 0, failFirstN: 0 };

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Experiment stopped", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Experiment stopped", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function step<T>(report: Reporter, index: number, action: () => Promise<T>, describe: (value: T) => string | StepUpdate): Promise<T> {
  report(index, { status: "running" });
  try {
    const value = await action();
    const described = describe(value);
    report(index, typeof described === "string" ? { status: "done", result: described } : described);
    return value;
  } catch (error) {
    report(index, { status: "failed", result: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

function count(run: Run, outcome: RunOutcome): number {
  return run.rows.filter((r) => r.outcome === outcome).length;
}

function instancesOf(run: Run): string[] {
  return [...new Set(run.rows.map((r) => r.instance).filter((i): i is string => Boolean(i)))].sort();
}

function describeRun(run: Run): StepUpdate {
  const parts = [`${count(run, "allowed")} allowed`, `${count(run, "rate_limited")} rate limited`];
  if (count(run, "upstream_error") > 0) {
    parts.push(`${count(run, "upstream_error")} upstream errors`);
  }
  if (count(run, "circuit_open") > 0) {
    parts.push(`${count(run, "circuit_open")} fast-failed`);
  }
  if (count(run, "edge_rejected") > 0) {
    parts.push(`${count(run, "edge_rejected")} stopped at Nginx`);
  }
  const instances = instancesOf(run);
  return {
    status: run.error ? "failed" : "done",
    result: run.error ?? `${parts.join(", ")} · answered by ${instances.join(" + ") || "no instance"}`,
    runId: run.id
  };
}

function ensureRun(run: Run): Run {
  if (run.error) {
    throw new Error(run.error);
  }
  return run;
}

function decidedRows(run: Run): ResultRow[] {
  return run.rows.filter((r) => r.outcome === "allowed" || r.outcome === "rate_limited").sort((a, b) => a.startedAtMs - b.startedAtMs);
}

function absoluteStart(run: Run, row: ResultRow): number {
  return Date.parse(run.startedAt) + row.startedAtMs;
}

function versionLabel(session: SandboxSession & { handledBy?: string }): string {
  return `Policy v${session.sandbox.policy.version}${session.handledBy ? ` · change handled by ${session.handledBy}` : ""}`;
}

export async function waitForPolicy(ctx: LabContext, version: number, maxMs: number): Promise<{ waitedMs: number; consistent: boolean }> {
  const started = Date.now();
  for (;;) {
    const states = await ctx.state();
    const stale = states.filter((s) => !s.error && (s.cachedPolicyVersions ?? []).some((c) => c.policyVersion !== version));
    if (stale.length === 0) {
      return { waitedMs: Date.now() - started, consistent: true };
    }
    if (Date.now() - started > maxMs + 1_500) {
      return { waitedMs: Date.now() - started, consistent: false };
    }
    await sleep(400, ctx.signal);
  }
}

function describeWait(result: { waitedMs: number; consistent: boolean }): string {
  if (!result.consistent) {
    return `Still stale after ${(result.waitedMs / 1000).toFixed(1)}s; continuing anyway`;
  }
  return result.waitedMs < 100 ? "Every instance already agrees" : `Every instance agreed after ${(result.waitedMs / 1000).toFixed(1)}s`;
}

function pass(label: string, ok: boolean, detail: string): Check {
  return { label, status: ok ? "pass" : "fail", detail };
}

function info(label: string, detail: string): Check {
  return { label, status: "info", detail };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export type BreakerModelOutcome = "allowed" | "upstream_error" | "circuit_open";

export function simulateBreakers(instances: string[], failFirstN: number, threshold: number): BreakerModelOutcome[] {
  const failures = new Map<string, number>();
  const open = new Set<string>();
  let upstreamCalls = 0;
  return instances.map((instance) => {
    if (open.has(instance)) {
      return "circuit_open";
    }
    upstreamCalls += 1;
    if (upstreamCalls <= failFirstN) {
      const next = (failures.get(instance) ?? 0) + 1;
      failures.set(instance, next);
      if (next >= threshold) {
        open.add(instance);
      }
      return "upstream_error";
    }
    failures.set(instance, 0);
    return "allowed";
  });
}

const burst: Experiment = {
  id: "burst",
  title: "Burst, then throttle",
  teaser: "Spend the bucket and find the first 429.",
  params: [
    { key: "capacity", label: "Capacity", min: 1, max: 100, defaultValue: 10, unit: "tokens" },
    { key: "refill", label: "Refill rate", min: 0.1, max: 50, step: 0.1, defaultValue: 1, unit: "/ sec" },
    { key: "requests", label: "Requests", min: 2, max: 200, defaultValue: 30 }
  ],
  hypothesis: (p) =>
    `A token bucket with capacity ${p.capacity} lets a fast burst of ${p.requests} requests through until the bucket is empty (about ${p.capacity}, plus whatever refills at ${p.refill}/s while the burst runs). After that it returns 429 with Retry-After.`,
  steps: (p) => [
    `Set the sandbox policy to token bucket, capacity ${p.capacity}, refill ${p.refill}/s`,
    "Wait until every gateway instance has loaded the new policy version",
    `Send ${p.requests} requests from the browser through Nginx, one after another`
  ],
  async execute(ctx, p, report, env) {
    const session = await step(
      report,
      0,
      () => ctx.configure({ ...BASE_POLICY, algorithm: "token_bucket", burstCapacity: p.capacity, refillRatePerSec: p.refill }, HEALTHY),
      versionLabel
    );
    await step(report, 1, () => waitForPolicy(ctx, session.sandbox.policy.version, env.policyCacheTtlMs), describeWait);
    const run = ensureRun(await step(report, 2, () => ctx.run({ mode: "browser", count: p.requests, concurrency: 1, intervalMs: 0 }, "Experiment: burst then throttle", ctx.signal), describeRun));

    const e = expectationFor(run);
    const limited = run.rows.filter((r) => r.outcome === "rate_limited");
    const first = [...limited].sort((a, b) => a.startedAtMs - b.startedAtMs)[0];
    const instances = instancesOf(run);
    return {
      checks: [
        pass(
          "Allowed count matches the token-bucket model",
          e.verdict === "match" || e.verdict === "within_tolerance",
          `Model expected ${e.expectedAllowed}, the gateways allowed ${e.observedAllowed} (tolerance ±${e.tolerance}).`
        ),
        pass("Excess requests were rejected with 429", limited.length > 0, `${limited.length} requests got 429.`),
        pass(
          "429 responses tell the client when to retry",
          limited.length > 0 && limited.every((r) => r.retryAfter !== null && r.retryAfter >= 1),
          first ? `First 429 was request #${first.seq} with Retry-After ${first.retryAfter ?? "missing"}s.` : "No 429 to inspect."
        ),
        info("Instances involved", `${instances.join(", ") || "none"}: Nginx spread the burst, but the quota is one Redis key.`)
      ],
      conclusion: `${e.observedAllowed} of ${p.requests} requests passed. The bucket drained at request #${first?.seq ?? "–"}, which matches capacity ${p.capacity} plus refill during the burst. Open the run to see RateLimit-Remaining fall across both instances.`
    };
  }
};

const refill: Experiment = {
  id: "refill",
  title: "Refill over time",
  teaser: "Drain, wait, and measure how many tokens came back.",
  params: [
    { key: "capacity", label: "Capacity", min: 1, max: 50, defaultValue: 5, unit: "tokens" },
    { key: "refill", label: "Refill rate", min: 0.1, max: 20, step: 0.1, defaultValue: 2, unit: "/ sec" },
    { key: "waitSec", label: "Wait", min: 0.5, max: 20, step: 0.5, defaultValue: 2, unit: "sec" }
  ],
  hypothesis: (p) =>
    `After the bucket is empty, waiting ${p.waitSec}s should restore about ${Math.min(p.capacity, Math.floor(p.refill * p.waitSec))} tokens (${p.refill}/s × ${p.waitSec}s, capped at capacity ${p.capacity}).`,
  steps: (p) => [
    `Set token bucket capacity ${p.capacity}, refill ${p.refill}/s`,
    "Wait until every instance uses the new policy",
    `Drain the bucket with ${p.capacity + 3} requests`,
    `Wait ${p.waitSec}s`,
    `Send ${p.capacity + 3} more requests and count how many pass`
  ],
  async execute(ctx, p, report, env) {
    const session = await step(
      report,
      0,
      () => ctx.configure({ ...BASE_POLICY, algorithm: "token_bucket", burstCapacity: p.capacity, refillRatePerSec: p.refill }, HEALTHY),
      versionLabel
    );
    await step(report, 1, () => waitForPolicy(ctx, session.sandbox.policy.version, env.policyCacheTtlMs), describeWait);
    const drain = ensureRun(await step(report, 2, () => ctx.run({ mode: "browser", count: p.capacity + 3, concurrency: 1, intervalMs: 0 }, "Experiment: refill (drain)", ctx.signal), describeRun));
    await step(report, 3, () => sleep(p.waitSec * 1000, ctx.signal), () => `Waited ${p.waitSec}s`);
    const after = ensureRun(await step(report, 4, () => ctx.run({ mode: "browser", count: p.capacity + 3, concurrency: 1, intervalMs: 0 }, "Experiment: refill (after wait)", ctx.signal), describeRun));

    const drainRows = decidedRows(drain);
    const afterRows = decidedRows(after);
    const lastDrain = drainRows[drainRows.length - 1];
    const firstAfter = afterRows[0];
    const gapMs = lastDrain && firstAfter ? absoluteStart(after, firstAfter) - absoluteStart(drain, lastDrain) : p.waitSec * 1000;
    const starts = afterRows.map((r) => r.startedAtMs);
    const restored = Math.min(p.capacity, (p.refill * gapMs) / 1000);
    const low = simulateTokenBucket(starts, restored, p.capacity, p.refill);
    const high = simulateTokenBucket(starts, Math.min(p.capacity, restored + 1), p.capacity, p.refill);
    const observed = count(after, "allowed");
    const drained = drainRows.some((r) => r.outcome === "rate_limited");
    return {
      checks: [
        pass("The first phase emptied the bucket", drained, drained ? "The drain ended in 429s." : "The drain never hit 429; tokens were left over."),
        pass(
          "Tokens came back at the configured rate",
          observed >= low && observed <= high,
          `Gap between phases was ${(gapMs / 1000).toFixed(2)}s, so ${restored.toFixed(2)} tokens should have refilled. Expected ${low === high ? low : `${low}–${high}`} to pass, observed ${observed}.`
        ),
        info("Why a range", "The drain can leave a fraction of a token behind, which may round up to one extra request.")
      ],
      conclusion: `${observed} requests passed after waiting ${(gapMs / 1000).toFixed(2)}s at ${p.refill} tokens/s. Refill is computed inside the Lua script from Redis TIME, so it does not depend on which gateway answered.`
    };
  }
};

const algorithms: Experiment = {
  id: "algorithms",
  title: "Sliding window vs token bucket",
  teaser: "Same average rate, different behavior after a burst.",
  params: [
    { key: "limit", label: "Limit", min: 2, max: 50, defaultValue: 10, unit: "requests" },
    { key: "windowSec", label: "Window", min: 2, max: 30, defaultValue: 10, unit: "sec" }
  ],
  hypothesis: (p) =>
    `Both policies allow about ${p.limit} requests in a burst. Half a window later, the token bucket has refilled about ${Math.floor(p.limit / 2)} tokens, while the sliding window still counts all ${p.limit} recent requests and allows none.`,
  steps: (p) => [
    `Token bucket: capacity ${p.limit}, refill ${clamp(Math.round((p.limit / p.windowSec) * 10) / 10, 0.1, 50)}/s (same average rate)`,
    `Token bucket: burst of ${p.limit + 5} requests`,
    `Token bucket: wait ${p.windowSec / 2}s, then send ${p.limit} more`,
    `Sliding window: ${p.limit} per ${p.windowSec}s`,
    `Sliding window: burst of ${p.limit + 5} requests`,
    `Sliding window: wait ${p.windowSec / 2}s, then send ${p.limit} more`
  ],
  async execute(ctx, p, report, env) {
    const half = (p.windowSec / 2) * 1000;
    const refillRate = clamp(Math.round((p.limit / p.windowSec) * 10) / 10, 0.1, 50);

    const tb = await step(
      report,
      0,
      async () => {
        const s = await ctx.configure({ ...BASE_POLICY, algorithm: "token_bucket", burstCapacity: p.limit, refillRatePerSec: refillRate }, HEALTHY);
        await waitForPolicy(ctx, s.sandbox.policy.version, env.policyCacheTtlMs);
        return s;
      },
      versionLabel
    );
    const tbBurst = ensureRun(await step(report, 1, () => ctx.run({ mode: "browser", count: p.limit + 5, concurrency: 1, intervalMs: 0 }, "Experiment: token bucket burst", ctx.signal), describeRun));
    const tbLater = ensureRun(
      await step(
        report,
        2,
        async () => {
          await sleep(half, ctx.signal);
          return ctx.run({ mode: "browser", count: p.limit, concurrency: 1, intervalMs: 0 }, "Experiment: token bucket after half a window", ctx.signal);
        },
        describeRun
      )
    );

    const sw = await step(
      report,
      3,
      async () => {
        const s = await ctx.configure({ ...BASE_POLICY, algorithm: "sliding_window", limitCount: p.limit, windowMs: p.windowSec * 1000 }, HEALTHY);
        await waitForPolicy(ctx, s.sandbox.policy.version, env.policyCacheTtlMs);
        return s;
      },
      versionLabel
    );
    const swBurst = ensureRun(await step(report, 4, () => ctx.run({ mode: "browser", count: p.limit + 5, concurrency: 1, intervalMs: 0 }, "Experiment: sliding window burst", ctx.signal), describeRun));
    const swLater = ensureRun(
      await step(
        report,
        5,
        async () => {
          await sleep(half, ctx.signal);
          return ctx.run({ mode: "browser", count: p.limit, concurrency: 1, intervalMs: 0 }, "Experiment: sliding window after half a window", ctx.signal);
        },
        describeRun
      )
    );

    const tbLaterAllowed = count(tbLater, "allowed");
    const swLaterAllowed = count(swLater, "allowed");
    const tbExpected = expectationFor(tbLater);
    return {
      checks: [
        pass("Both allowed roughly the limit in a burst", Math.abs(count(tbBurst, "allowed") - p.limit) <= 1 && count(swBurst, "allowed") === p.limit, `Token bucket ${count(tbBurst, "allowed")}, sliding window ${count(swBurst, "allowed")} (limit ${p.limit}).`),
        pass("Token bucket recovered gradually", tbLaterAllowed >= 1 && tbExpected.verdict !== "deviation", `${tbLaterAllowed} passed half a window later (model: ${tbExpected.expectedAllowed}).`),
        pass("Sliding window stayed closed until requests age out", swLaterAllowed === 0, `${swLaterAllowed} passed half a window later (expected 0).`),
        info("Policy versions", `Token bucket ran as v${tb.sandbox.policy.version}, sliding window as v${sw.sandbox.policy.version}. Each version uses its own Redis key.`)
      ],
      conclusion: `Same average rate, different shape: the token bucket let ${tbLaterAllowed} through after ${p.windowSec / 2}s, the sliding window let ${swLaterAllowed}. Pick the token bucket for smooth recovery and the sliding window when "never more than N in any window" must hold exactly. Use "Compare with" in the results panel to view the runs side by side.`
    };
  }
};

const dimensions: Experiment = {
  id: "dimensions",
  title: "Per-user quotas with dimensions",
  teaser: "Rotate X-User-Id and watch quotas split.",
  params: [
    { key: "users", label: "Simulated users", min: 2, max: 10, defaultValue: 3 },
    { key: "capacity", label: "Capacity per key", min: 1, max: 20, defaultValue: 5, unit: "tokens" }
  ],
  hypothesis: (p) =>
    `With the custom dimension on X-User-Id, each of ${p.users} users gets its own bucket of ${p.capacity}, so about ${p.users * p.capacity} requests pass in total. Without it, all users share one bucket and only about ${p.capacity} pass.`,
  steps: (p) => [
    `Policy: capacity ${p.capacity}, dimensions tenant + api_key + route + custom (x-user-id)`,
    `Send ${p.users * p.capacity * 2} requests rotating x-user-id across user-0…user-${p.users - 1}`,
    "Policy: same capacity, without the custom dimension",
    "Send the same traffic again"
  ],
  async execute(ctx, p, report, env) {
    const total = Math.min(200, p.users * p.capacity * 2);
    const runConfig: Partial<RunConfig> = { mode: "browser", count: total, concurrency: 1, intervalMs: 0, rotateHeader: { name: "x-user-id", values: p.users } };
    await step(
      report,
      0,
      async () => {
        const s = await ctx.configure(
          { algorithm: "token_bucket", burstCapacity: p.capacity, refillRatePerSec: 0.1, dimensions: ["tenant", "api_key", "route", "custom"], customHeader: "x-user-id", failMode: "fail_closed" },
          HEALTHY
        );
        await waitForPolicy(ctx, s.sandbox.policy.version, env.policyCacheTtlMs);
        return s;
      },
      versionLabel
    );
    const perUser = ensureRun(await step(report, 1, () => ctx.run(runConfig, "Experiment: per-user dimension", ctx.signal), describeRun));
    await step(
      report,
      2,
      async () => {
        const s = await ctx.configure({ ...BASE_POLICY, algorithm: "token_bucket", burstCapacity: p.capacity, refillRatePerSec: 0.1 }, HEALTHY);
        await waitForPolicy(ctx, s.sandbox.policy.version, env.policyCacheTtlMs);
        return s;
      },
      versionLabel
    );
    const shared = ensureRun(await step(report, 3, () => ctx.run(runConfig, "Experiment: shared quota", ctx.signal), describeRun));

    const e = expectationFor(perUser);
    const groupsOk = e.groups.length === p.users && e.groups.every((g) => Math.abs(g.observedAllowed - p.capacity) <= 1);
    const sharedAllowed = count(shared, "allowed");
    return {
      checks: [
        pass(
          "Each user got its own bucket",
          groupsOk,
          e.groups.map((g) => `${g.key}: ${g.observedAllowed}`).join(", ") || "No per-user groups found."
        ),
        pass("Total with per-user quotas ≈ users × capacity", Math.abs(count(perUser, "allowed") - p.users * p.capacity) <= p.users, `${count(perUser, "allowed")} passed (expected about ${p.users * p.capacity}).`),
        pass("Without the dimension, everyone shared one bucket", Math.abs(sharedAllowed - p.capacity) <= 1, `${sharedAllowed} passed (expected about ${p.capacity}).`)
      ],
      conclusion: `Dimensions decide what is hashed into the Redis key. Adding x-user-id turned one quota of ${p.capacity} into ${p.users} independent quotas. That is how per-user limits sit inside a per-tenant API key.`
    };
  }
};

const consistency: Experiment = {
  id: "consistency",
  title: "Two instances, one limit",
  teaser: "A real race against both gateways at once.",
  params: [
    { key: "capacity", label: "Capacity", min: 1, max: 50, defaultValue: 10, unit: "tokens" },
    { key: "requests", label: "Requests", min: 10, max: 200, defaultValue: 100 },
    { key: "concurrency", label: "In flight at once", min: 2, max: 50, defaultValue: 50 }
  ],
  hypothesis: (p) =>
    `Even when ${p.concurrency} requests hit gateway-1 and gateway-2 at the same moment, the atomic Lua script admits at most ${p.capacity}. Two independent in-memory counters would admit up to ${p.capacity * 2}.`,
  steps: (p) => [
    `Token bucket capacity ${p.capacity}, near-zero refill (0.1/s)`,
    "Wait until every instance uses the new policy",
    `Server-side runner fires ${p.requests} requests, ${p.concurrency} at once, alternating between instances directly`
  ],
  async execute(ctx, p, report, env) {
    const session = await step(report, 0, () => ctx.configure({ ...BASE_POLICY, algorithm: "token_bucket", burstCapacity: p.capacity, refillRatePerSec: 0.1 }, HEALTHY), versionLabel);
    await step(report, 1, () => waitForPolicy(ctx, session.sandbox.policy.version, env.policyCacheTtlMs), describeWait);
    const run = ensureRun(await step(report, 2, () => ctx.run({ mode: "server", count: p.requests, concurrency: p.concurrency }, "Experiment: two instances, one limit", ctx.signal), describeRun));

    const allowed = count(run, "allowed");
    const instances = instancesOf(run);
    const e = expectationFor(run);
    const maxAllowed = p.capacity + e.tolerance;
    return {
      checks: [
        pass("Both gateway instances took part", instances.length >= 2, `Answered by ${instances.join(", ") || "none"}.`),
        pass("Never admitted more than the limit", allowed <= maxAllowed, `${allowed} allowed out of ${run.rows.length} (limit ${p.capacity}${e.tolerance ? `, +${e.tolerance} for refill during the run` : ""}).`),
        info(
          "What a per-instance counter would have done",
          `Each of ${Math.max(1, instances.length)} instances would have allowed ${p.capacity}: up to ${p.capacity * Math.max(1, instances.length)} in total.`
        )
      ],
      conclusion: `${allowed} of ${run.rows.length} concurrent requests were admitted across ${instances.length} instances. The check-and-decrement happens inside one Redis Lua script, so there is no read-modify-write race between gateways.`
    };
  }
};

const livePolicy: Experiment = {
  id: "live-policy",
  title: "Live policy change and cache staleness",
  teaser: "Edit the policy mid-traffic and catch the stale instance.",
  params: [
    { key: "before", label: "Capacity before", min: 1, max: 50, defaultValue: 3, unit: "tokens" },
    { key: "after", label: "Capacity after", min: 1, max: 100, defaultValue: 20, unit: "tokens" },
    { key: "probes", label: "Requests right after", min: 2, max: 20, defaultValue: 8 }
  ],
  hypothesis: (p) =>
    `Changing capacity from ${p.before} to ${p.after} takes effect at once on the instance that handled the change. The other instance keeps its cached copy until the config cache TTL expires, so for a few seconds the two instances decide with different policy versions.`,
  steps: (p) => [
    `Set capacity ${p.before}, wait for every instance to load it`,
    "Warm both instance caches with a few requests",
    `Change capacity to ${p.after} (a PATCH handled by one instance)`,
    "Read cached policy versions from every instance immediately",
    `Send ${p.probes} requests alternating between instances`,
    "Wait for the cache TTL, then send the same requests again"
  ],
  async execute(ctx, p, report, env) {
    const initial = await step(
      report,
      0,
      async () => {
        const s = await ctx.configure({ ...BASE_POLICY, algorithm: "token_bucket", burstCapacity: p.before, refillRatePerSec: 0.1 }, HEALTHY);
        await waitForPolicy(ctx, s.sandbox.policy.version, env.policyCacheTtlMs);
        return s;
      },
      versionLabel
    );
    const oldVersion = initial.sandbox.policy.version;
    ensureRun(await step(report, 1, () => ctx.run({ mode: "server", count: 4, concurrency: 1 }, "Experiment: warm caches", ctx.signal), describeRun));
    const patched = await step(report, 2, () => ctx.patchPolicy({ burstCapacity: p.after }), versionLabel);
    const newVersion = patched.sandbox.policy.version;
    const states = await step(
      report,
      3,
      () => ctx.state(),
      (list) =>
        list
          .map((s) => `${s.instance}: ${(s.cachedPolicyVersions ?? []).map((c) => `v${c.policyVersion}`).join(", ") || "not cached"}`)
          .join(" · ")
    );
    const during = ensureRun(await step(report, 4, () => ctx.run({ mode: "server", count: p.probes, concurrency: 1 }, "Experiment: right after the change", ctx.signal), describeRun));
    const settled = ensureRun(
      await step(
        report,
        5,
        async () => {
          await sleep(env.policyCacheTtlMs + 500, ctx.signal);
          return ctx.run({ mode: "server", count: p.probes, concurrency: 1 }, "Experiment: after the cache TTL", ctx.signal);
        },
        describeRun
      )
    );

    const staleInstances = states.filter((s) => (s.cachedPolicyVersions ?? []).some((c) => c.policyVersion === oldVersion)).map((s) => s.instance);
    const staleRows = during.rows.filter((r) => r.policyVersion === oldVersion);
    const settledVersions = [...new Set(settled.rows.map((r) => r.policyVersion))];
    const limitHeaders = [...new Set(settled.rows.map((r) => r.limit).filter((v) => v !== null))];
    return {
      checks: [
        pass(
          "The instance that handled the PATCH switched immediately",
          states.some((s) => s.instance === patched.handledBy && !(s.cachedPolicyVersions ?? []).some((c) => c.policyVersion === oldVersion)),
          `${patched.handledBy ?? "unknown"} handled the change.`
        ),
        info(
          "Stale window observed",
          staleRows.length > 0
            ? `${staleRows.length} of ${during.rows.length} requests were still decided with v${oldVersion} by ${[...new Set(staleRows.map((r) => r.instance))].join(", ")}. Instances holding v${oldVersion} right after the change: ${staleInstances.join(", ") || "none"}.`
            : `No request used v${oldVersion}: the other instance's cache had already expired, which happens when its entry was loaded close to ${env.policyCacheTtlMs / 1000}s earlier. Run it again to catch it.`
        ),
        pass("After the TTL every instance used the new version", settledVersions.length === 1 && settledVersions[0] === newVersion, `Versions seen: ${settledVersions.map((v) => (v === null ? "none" : `v${v}`)).join(", ")}.`),
        pass("The new capacity is what clients see", limitHeaders.length === 1 && limitHeaders[0] === p.after, `RateLimit-Limit after the TTL: ${limitHeaders.join(", ") || "missing"}.`)
      ],
      conclusion: `Config lives in PostgreSQL and each gateway caches it for ${env.policyCacheTtlMs / 1000}s. That is a deliberate trade-off: no database read per request, at the cost of a bounded stale window after edits. The version is part of the Redis key, so old and new decisions never share a bucket.`
    };
  }
};

const breaker: Experiment = {
  id: "breaker",
  title: "Circuit breaker lifecycle",
  teaser: "Break the upstream, watch closed → open → half-open → closed.",
  params: [
    { key: "failFirstN", label: "Upstream fails first", min: 1, max: 20, defaultValue: 6, unit: "requests" },
    { key: "threshold", label: "Open after", min: 1, max: 10, defaultValue: 3, unit: "failures" },
    { key: "recoverySec", label: "Stay open for", min: 1, max: 30, defaultValue: 5, unit: "sec" }
  ],
  hypothesis: (p) =>
    `The upstream fails its first ${p.failFirstN} calls. Each gateway instance opens its own breaker after ${p.threshold} consecutive failures and then fails fast without calling the upstream. After ${p.recoverySec}s a probe goes through, succeeds, and the breaker closes.`,
  steps: (p) => [
    `Upstream fails the first ${p.failFirstN} calls; breaker opens after ${p.threshold}, recovers after ${p.recoverySec}s; reset counters and breakers`,
    "Wait for both instances to load the new upstream config",
    `Send ${p.failFirstN + 4} requests one at a time, alternating between instances`,
    "Read breaker state from every instance",
    `Wait ${p.recoverySec}s for the recovery window`,
    "Send 4 more requests (half-open probes)",
    "Read breaker state again"
  ],
  async execute(ctx, p, report, env) {
    await step(
      report,
      0,
      () =>
        ctx.configure(
          { ...BASE_POLICY, algorithm: "token_bucket", burstCapacity: 100, refillRatePerSec: 50 },
          { delayMs: 0, failRatePct: 0, failFirstN: p.failFirstN, cbFailureThreshold: p.threshold, cbRecoveryMs: p.recoverySec * 1000, cbHalfOpenMaxProbes: 1 },
          { restartCounter: true, resetCircuit: true }
        ),
      versionLabel
    );
    await step(report, 1, () => sleep(env.policyCacheTtlMs + 300, ctx.signal), () => "Config cache TTL elapsed on every instance");
    const failing = ensureRun(await step(report, 2, () => ctx.run({ mode: "server", count: p.failFirstN + 4, concurrency: 1 }, "Experiment: breaker opens", ctx.signal), describeRun));
    const openStates = await step(report, 3, () => ctx.state(), describeBreakers);
    await step(report, 4, () => sleep(p.recoverySec * 1000 + 300, ctx.signal), () => `Waited ${p.recoverySec}s`);
    const recovering = ensureRun(await step(report, 5, () => ctx.run({ mode: "server", count: 4, concurrency: 1 }, "Experiment: breaker recovers", ctx.signal), describeRun));
    const closedStates = await step(report, 6, () => ctx.state(), describeBreakers);

    const ordered = [...failing.rows].sort((a, b) => a.seq - b.seq);
    const model = simulateBreakers(ordered.map((r) => r.instance ?? "unknown"), p.failFirstN, p.threshold);
    const observed = ordered.map((r) => r.outcome);
    const mismatches = observed.filter((o, i) => o !== model[i]).length;
    const fastFails = ordered.filter((r) => r.outcome === "circuit_open");
    const upstreamLatency = ordered.filter((r) => r.outcome === "upstream_error").map((r) => r.latencyMs);
    const fastLatency = fastFails.map((r) => r.latencyMs);
    const avg = (values: number[]) => (values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0);
    return {
      checks: [
        pass(
          "Outcome sequence matches the breaker model",
          mismatches === 0,
          `Observed ${observed.map(shortOutcome).join(" ")} · model ${model.map(shortOutcome).join(" ")}`
        ),
        pass("Breakers were open after the failures", openStates.some((s) => s.breaker?.state === "open"), describeBreakers(openStates)),
        pass("Probes succeeded after the recovery window", count(recovering, "allowed") === recovering.rows.length, `${count(recovering, "allowed")} of ${recovering.rows.length} passed.`),
        pass("Breakers closed again", closedStates.every((s) => s.error || !s.breaker || s.breaker.state === "closed"), describeBreakers(closedStates)),
        info("Fast-fail is cheap", fastFails.length ? `Fast-fail averaged ${avg(fastLatency).toFixed(1)} ms vs ${avg(upstreamLatency).toFixed(1)} ms for real upstream failures.` : "No fast-fails in this run.")
      ],
      conclusion: `Each instance tracks failures on its own: ${p.failFirstN} upstream failures split across instances, each opened after ${p.threshold}. While open, requests got 503 without touching the upstream. After ${p.recoverySec}s the first probe on each instance succeeded and closed its breaker.`
    };
  }
};

function shortOutcome(outcome: string): string {
  return outcome === "allowed" ? "OK" : outcome === "upstream_error" ? "ERR" : outcome === "circuit_open" ? "OPEN" : outcome === "rate_limited" ? "429" : "?";
}

function describeBreakers(states: InstanceState[]): string {
  if (states.length === 0) {
    return "No instance state available";
  }
  return states
    .map((s) => (s.error ? `${s.instance}: unreachable` : `${s.instance}: ${s.breaker?.state ?? "closed"}${s.breaker ? ` (${s.breaker.consecutiveFailures}/${s.breaker.failureThreshold})` : ""}`))
    .join(" · ");
}

const failMode: Experiment = {
  id: "fail-mode",
  title: "Fail closed vs fail open",
  teaser: "What happens when Redis is down. Run locally.",
  params: [
    {
      key: "mode",
      label: "Fail mode",
      min: 0,
      max: 1,
      defaultValue: 0,
      options: [
        { value: 0, label: "Fail closed" },
        { value: 1, label: "Fail open" }
      ]
    }
  ],
  hypothesis: (p) =>
    p.mode === 0
      ? "With fail closed, if Redis cannot be reached the gateway returns 503 instead of letting traffic through unmetered. The upstream stays protected."
      : "With fail open, if Redis cannot be reached the gateway lets requests through without a limit (RateLimit-Remaining -1). Availability wins over protection.",
  steps: (p) => [
    `Set the sandbox policy to ${p.mode === 0 ? "fail_closed" : "fail_open"}`,
    "Send 3 requests while Redis is healthy",
    "Stopping Redis is not exposed on the public demo; run the commands below on a local copy to see the failure path"
  ],
  commands: `docker compose up -d --build
docker compose stop redis
# use the sandbox key and route shown in the lab, or a seeded key:
curl -i -H "x-api-key: <key>" http://localhost:8080/sbx/<id>/orders
docker compose start redis`,
  async execute(ctx, p, report, env) {
    const session = await step(report, 0, () => ctx.configure({ failMode: p.mode === 0 ? "fail_closed" : "fail_open" }, HEALTHY), versionLabel);
    await waitForPolicy(ctx, session.sandbox.policy.version, env.policyCacheTtlMs);
    const run = ensureRun(await step(report, 1, () => ctx.run({ mode: "browser", count: 3, concurrency: 1, intervalMs: 0 }, `Experiment: ${p.mode === 0 ? "fail closed" : "fail open"} (Redis healthy)`, ctx.signal), describeRun));
    report(2, { status: "done", result: "See commands below" });
    return {
      checks: [
        pass("Normal decisions while Redis is up", count(run, "allowed") > 0 && run.rows.every((r) => r.remaining === null || r.remaining >= 0), `${count(run, "allowed")} allowed with real RateLimit-Remaining values.`),
        info("Stored fail mode", `Policy v${session.sandbox.policy.version} is ${session.sandbox.policy.failMode}.`),
        info("Failure path", "With Redis stopped, fail_closed returns 503 (limiter unavailable) and fail_open returns 200 with RateLimit-Remaining -1.")
      ],
      conclusion: "Fail mode is a per-policy decision. Payment-style routes should fail closed; read-heavy, low-risk routes can fail open. The public demo does not let visitors stop Redis, so the failure path is shown through local commands."
    };
  }
};

export const EXPERIMENTS: Experiment[] = [burst, refill, algorithms, dimensions, consistency, livePolicy, breaker, failMode];

export function defaultParams(experiment: Experiment): Params {
  return Object.fromEntries(experiment.params.map((param) => [param.key, param.defaultValue]));
}

export function validateParams(experiment: Experiment, params: Params): string[] {
  return experiment.params
    .filter((param) => !Number.isFinite(params[param.key]) || params[param.key]! < param.min || params[param.key]! > param.max)
    .map((param) => `${param.label} must be between ${param.min} and ${param.max}`);
}

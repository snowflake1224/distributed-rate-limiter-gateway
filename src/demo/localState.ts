import { cachedPolicyVersions } from "../cache/configCache.js";
import { peekBreaker, removeBreaker, type BreakerSnapshot } from "../circuitbreaker/breaker.js";
import { env } from "../config/env.js";

export type Outcome =
  | "allowed"
  | "rate_limited"
  | "upstream_error"
  | "circuit_open"
  | "gateway_error";

interface SandboxCounters {
  upstreamName: string | null;
  lastSeen: number;
  counts: Record<Outcome, number>;
}

const counters = new Map<string, SandboxCounters>();

function emptyCounts(): Record<Outcome, number> {
  return { allowed: 0, rate_limited: 0, upstream_error: 0, circuit_open: 0, gateway_error: 0 };
}

export function breakerNameFor(tenantId: string, upstreamId: string): string {
  return `${tenantId}:${upstreamId}`;
}

export function recordSandboxOutcome(tenantId: string, outcome: Outcome, upstreamId?: string): void {
  let entry = counters.get(tenantId);
  if (!entry) {
    entry = { upstreamName: null, lastSeen: Date.now(), counts: emptyCounts() };
    counters.set(tenantId, entry);
  }
  entry.lastSeen = Date.now();
  entry.counts[outcome] += 1;
  if (upstreamId) {
    entry.upstreamName = breakerNameFor(tenantId, upstreamId);
  }
}

export interface LocalSandboxState {
  instance: string;
  breaker: BreakerSnapshot | null;
  cachedPolicyVersions: Array<{ policyVersion: number; expiresInMs: number }>;
  counts: Record<Outcome, number>;
}

export function localSandboxState(tenantId: string, upstreamId: string): LocalSandboxState {
  return {
    instance: env.instanceId,
    breaker: peekBreaker(breakerNameFor(tenantId, upstreamId)),
    cachedPolicyVersions: cachedPolicyVersions(tenantId),
    counts: { ...(counters.get(tenantId)?.counts ?? emptyCounts()) }
  };
}

export function forgetSandbox(tenantId: string, upstreamId: string): void {
  counters.delete(tenantId);
  removeBreaker(breakerNameFor(tenantId, upstreamId));
}

export function pruneIdleSandboxState(maxIdleMs: number): number {
  const cutoff = Date.now() - maxIdleMs;
  let removed = 0;
  for (const [tenantId, entry] of counters) {
    if (entry.lastSeen < cutoff) {
      counters.delete(tenantId);
      if (entry.upstreamName) {
        removeBreaker(entry.upstreamName);
      }
      removed += 1;
    }
  }
  return removed;
}

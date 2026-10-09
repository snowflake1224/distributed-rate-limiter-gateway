import type { PolicyConfig, RunConfig, UpstreamConfig } from "./types";

export const DEFAULT_POLICY: PolicyConfig = {
  algorithm: "token_bucket",
  burstCapacity: 10,
  refillRatePerSec: 1,
  limitCount: 10,
  windowMs: 10_000,
  dimensions: ["tenant", "api_key", "route"],
  customHeader: "x-user-id",
  failMode: "fail_closed"
};

export const DEFAULT_UPSTREAM: UpstreamConfig = {
  delayMs: 0,
  failRatePct: 0,
  failFirstN: 0,
  errorStatus: 503,
  timeoutMs: 2_000,
  cbFailureThreshold: 3,
  cbRecoveryMs: 5_000,
  cbHalfOpenMaxProbes: 1
};

export const DEFAULT_RUN: RunConfig = {
  mode: "browser",
  method: "GET",
  path: "",
  count: 20,
  concurrency: 1,
  intervalMs: 0,
  headers: {},
  credential: "sandbox"
};

export const UPSTREAM_PRESETS: Array<{ id: string; label: string; description: string; values: Partial<UpstreamConfig> }> = [
  { id: "healthy", label: "Healthy", description: "Responds immediately with 200.", values: { delayMs: 0, failRatePct: 0, failFirstN: 0 } },
  { id: "slow", label: "Slow", description: "Adds 800 ms of latency to every response.", values: { delayMs: 800, failRatePct: 0, failFirstN: 0 } },
  {
    id: "timeout",
    label: "Times out",
    description: "Slower than the gateway's upstream timeout, so the gateway returns 504.",
    values: { delayMs: 2_500, failRatePct: 0, failFirstN: 0, timeoutMs: 1_000 }
  },
  { id: "flaky", label: "Flaky", description: "Half of the responses are 503.", values: { delayMs: 0, failRatePct: 50, failFirstN: 0 } },
  { id: "outage", label: "Outage then recovery", description: "The first 6 requests fail, then it recovers.", values: { delayMs: 0, failRatePct: 0, failFirstN: 6 } }
];

export const DIMENSION_HELP: Record<string, string> = {
  tenant: "One shared quota for the whole tenant.",
  api_key: "Separate quota per API key.",
  route: "Separate quota per route.",
  ip: "Separate quota per client IP (from X-Forwarded-For set by Nginx).",
  custom: "Separate quota per value of a header you choose, e.g. X-User-Id."
};

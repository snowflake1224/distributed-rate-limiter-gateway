export type Algorithm = "token_bucket" | "sliding_window";
export type Dimension = "tenant" | "api_key" | "route" | "ip" | "custom";
export type FailMode = "fail_closed" | "fail_open";
export type CircuitState = "closed" | "open" | "half_open";

export interface PolicyConfig {
  algorithm: Algorithm;
  burstCapacity: number;
  refillRatePerSec: number;
  limitCount: number;
  windowMs: number;
  dimensions: Dimension[];
  customHeader: string;
  failMode: FailMode;
}

export interface UpstreamConfig {
  delayMs: number;
  failRatePct: number;
  failFirstN: number;
  errorStatus: 500 | 502 | 503;
  timeoutMs: number;
  cbFailureThreshold: number;
  cbRecoveryMs: number;
  cbHalfOpenMaxProbes: number;
}

export interface SandboxView {
  id: string;
  tenantSlug: string;
  routePrefix: string;
  routePattern: string;
  expiresAt: string;
  createdAt: string;
  policy: PolicyConfig & { version: number; redisKeyFormat: string };
  upstream: UpstreamConfig & { revision: number };
}

export interface SandboxSession {
  sandbox: SandboxView;
  apiKey: string;
  token: string;
}

export interface Bound {
  min: number;
  max: number;
}

export interface Manifest {
  instance: string;
  sandboxEnabled: boolean;
  sandboxTtlMs: number;
  policyCacheTtlMs: number;
  apiKeyCacheTtlMs: number;
  gatewayInstances: number;
  bounds: Record<string, Bound>;
  edge: { nginxRatePerSecond: number; nginxBurst: number };
  presets: {
    available: boolean;
    acmeKey: string | null;
    globexKey: string | null;
    routes: Array<{ path: string; tenant: string; algorithm: Algorithm; summary: string }>;
  };
}

export interface BreakerSnapshot {
  state: CircuitState;
  consecutiveFailures: number;
  failureThreshold: number;
  recoveryMs: number;
  retryInMs: number;
}

export type OutcomeCounts = Record<"allowed" | "rate_limited" | "upstream_error" | "circuit_open" | "gateway_error", number>;

export interface InstanceState {
  instance: string;
  breaker?: BreakerSnapshot | null;
  cachedPolicyVersions?: Array<{ policyVersion: number; expiresInMs: number }>;
  counts?: OutcomeCounts;
  error?: string;
}

export type RunOutcome =
  | "allowed"
  | "rate_limited"
  | "circuit_open"
  | "upstream_error"
  | "gateway_error"
  | "edge_rejected"
  | "network_error";

export interface ResultRow {
  seq: number;
  target: string;
  instance: string | null;
  status: number;
  outcome: RunOutcome;
  startedAtMs: number;
  latencyMs: number;
  limit: number | null;
  remaining: number | null;
  reset: number | null;
  retryAfter: number | null;
  policyVersion: number | null;
  requestId: string;
  headers: Record<string, string>;
  body: string;
  sentHeaders?: Record<string, string>;
  dimensionValue?: string;
}

export type RunMode = "browser" | "server" | "single";

export interface RunConfig {
  mode: RunMode;
  method: "GET" | "POST";
  path: string;
  count: number;
  concurrency: number;
  intervalMs: number;
  headers: Record<string, string>;
  rotateHeader?: { name: string; values: number };
  body?: string;
  credential: "sandbox" | "none" | "invalid" | "preset";
  presetKey?: string;
}

export interface Run {
  id: string;
  label: string;
  startedAt: string;
  durationMs: number;
  config: RunConfig;
  policy: (PolicyConfig & { version: number }) | null;
  upstream: UpstreamConfig | null;
  rows: ResultRow[];
  targets: string[];
  cancelled?: boolean;
  error?: string;
}

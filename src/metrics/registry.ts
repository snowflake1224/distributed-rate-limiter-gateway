import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";
import { env } from "../config/env.js";

export const registry = new Registry();
registry.setDefaultLabels({ instance: env.instanceId });
collectDefaultMetrics({ register: registry, prefix: "gateway_" });

export const httpRequestsTotal = new Counter({
  name: "gateway_http_requests_total",
  help: "Total HTTP requests received by the gateway",
  labelNames: ["method", "route_group", "status"] as const,
  registers: [registry]
});

export const rateLimitAllowedTotal = new Counter({
  name: "gateway_ratelimit_allowed_total",
  help: "Requests allowed by the rate limiter",
  labelNames: ["tenant", "algorithm"] as const,
  registers: [registry]
});

export const rateLimitRejectedTotal = new Counter({
  name: "gateway_ratelimit_rejected_total",
  help: "Requests rejected by the rate limiter",
  labelNames: ["tenant", "algorithm", "reason"] as const,
  registers: [registry]
});

export const requestDurationSeconds = new Histogram({
  name: "gateway_request_duration_seconds",
  help: "End-to-end gateway request duration",
  labelNames: ["route_group", "status"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry]
});

export const decisionDurationSeconds = new Histogram({
  name: "gateway_ratelimit_decision_duration_seconds",
  help: "Time spent making a Redis rate-limit decision",
  labelNames: ["algorithm"] as const,
  buckets: [0.0005, 0.001, 0.002, 0.005, 0.01, 0.025, 0.05, 0.1],
  registers: [registry]
});

export const redisLatencySeconds = new Histogram({
  name: "gateway_redis_latency_seconds",
  help: "Redis command latency",
  labelNames: ["command"] as const,
  buckets: [0.0005, 0.001, 0.002, 0.005, 0.01, 0.025, 0.05, 0.1],
  registers: [registry]
});

export const postgresLatencySeconds = new Histogram({
  name: "gateway_postgres_latency_seconds",
  help: "PostgreSQL query latency",
  labelNames: ["operation"] as const,
  buckets: [0.001, 0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25],
  registers: [registry]
});

export const policyCacheHitsTotal = new Counter({
  name: "gateway_policy_cache_hits_total",
  help: "Policy cache hits",
  registers: [registry]
});

export const policyCacheMissesTotal = new Counter({
  name: "gateway_policy_cache_misses_total",
  help: "Policy cache misses",
  registers: [registry]
});

export const apiKeyCacheHitsTotal = new Counter({
  name: "gateway_apikey_cache_hits_total",
  help: "API key cache hits",
  registers: [registry]
});

export const apiKeyCacheMissesTotal = new Counter({
  name: "gateway_apikey_cache_misses_total",
  help: "API key cache misses",
  registers: [registry]
});

export const circuitBreakerState = new Gauge({
  name: "gateway_circuit_breaker_state",
  help: "Circuit breaker state (0=closed, 1=half_open, 2=open)",
  labelNames: ["upstream"] as const,
  registers: [registry]
});

export const circuitBreakerTransitionsTotal = new Counter({
  name: "gateway_circuit_breaker_transitions_total",
  help: "Circuit breaker state transitions",
  labelNames: ["upstream", "from", "to"] as const,
  registers: [registry]
});

export const upstreamFailuresTotal = new Counter({
  name: "gateway_upstream_failures_total",
  help: "Upstream failures seen by the proxy",
  labelNames: ["upstream", "reason"] as const,
  registers: [registry]
});

export const upstreamLatencySeconds = new Histogram({
  name: "gateway_upstream_latency_seconds",
  help: "Upstream response latency",
  labelNames: ["upstream", "status"] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry]
});

export const eventLoopLagSeconds = new Gauge({
  name: "gateway_eventloop_lag_seconds",
  help: "Sampled Node.js event-loop lag from a 500ms interval",
  registers: [registry]
});

export const activeTenants = new Gauge({
  name: "gateway_active_tenants",
  help: "Active tenants loaded from PostgreSQL",
  registers: [registry]
});

export const activePolicies = new Gauge({
  name: "gateway_active_policies",
  help: "Active policies loaded from PostgreSQL",
  registers: [registry]
});

export const redisUnavailableTotal = new Counter({
  name: "gateway_redis_unavailable_total",
  help: "Rate-limit decisions that could not contact Redis",
  labelNames: ["fail_mode"] as const,
  registers: [registry]
});

let lagTimer: NodeJS.Timeout | undefined;

export function startEventLoopLagSampler(): void {
  const intervalMs = 500;
  let last = process.hrtime.bigint();
  lagTimer = setInterval(() => {
    const now = process.hrtime.bigint();
    const expected = BigInt(intervalMs) * 1_000_000n;
    const lagNs = now - last - expected;
    last = now;
    eventLoopLagSeconds.set(Math.max(0, Number(lagNs) / 1e9));
  }, intervalMs);
  lagTimer.unref();
}

export function stopEventLoopLagSampler(): void {
  if (lagTimer) {
    clearInterval(lagTimer);
  }
}

# Distributed Rate Limiter & API Gateway — Architecture (HLD)

![Distributed Rate Limiter & API Gateway Architecture](diagrams/architecture.svg)

## Design Goal

Enforce **globally shared multi-tenant rate limits** across horizontally scaled, stateless Node.js gateway instances behind Nginx (`least_conn`), while protecting slow or failing upstreams with per-instance circuit breakers and preserving low-latency hot-path execution.

## System Topology

| Component | Source | Responsibility |
| --- | --- | --- |
| **Nginx Edge (`:8080`)** | `nginx/nginx.conf` | `least_conn` load balancing across `gateway-1` and `gateway-2`; serves Gateway Lab UI on `/`, redirects `/demo/` -> `/`, applies edge `limit_req_zone` (`demo`, `lab_control`), blocks `/admin/` and `/metrics` from external traffic (`404`). |
| **Stateless Gateways (`:3000`, `:3002`)** | `src/app.ts`, `src/api/gateway.ts` | Authenticates `X-API-Key` (SHA-256 hash), caches keys/routes/policies (`TtlLruCache`, 5s TTL), computes Redis limit keys, executes atomic Lua rate limits, enforces circuit breakers, proxies to upstreams. |
| **PostgreSQL 16 (Control Plane)** | `src/db/migrations/` | Durable store for `tenants`, `api_keys`, `policies`, `routes`, `upstreams`, `audit_logs`, and `demo_sandboxes` (30-minute TTL with `pg_advisory_xact_lock`). |
| **Redis 7 (Shared Limit State)** | `src/redis/client.ts`, `src/redis/lua/` | Executes `token_bucket.lua` and `sliding_window.lua` atomically using server-side `TIME`; enforces `200 ms` `commandTimeout` (`fail_closed` -> `503` by default). |
| **Upstreams & Gateway Lab** | `src/upstream/`, `src/demo/` | Mock/lab upstreams (`upstream-ok`, `upstream-flaky`, `upstream-lab`) with programmable delay, error rate, and fail-first-N behavior for interactive verification. |
| **Prometheus + Grafana (`:9090`, `:3001`)** | `src/metrics/registry.ts`, `grafana/` | Tracks `gateway_ratelimit_allowed_total`, `gateway_ratelimit_rejected_total`, `gateway_circuit_breaker_state`, cache hits/misses, and Redis latency histograms. |

## Request Hot Path & State Separation

![Gateway Request Hot Path & Circuit Breaker](diagrams/request-and-lua-flow.svg)

1. **PostgreSQL never increments a request counter**, and **Redis never holds durable configuration**. Splitting policy configuration (relational, infrequently mutated, safely cached for up to `5 s`) from rate-limit counters (atomic Redis state) prevents database lock contention on the hot path.
2. **Version-scoped Redis keys (`vN`):** Every policy update bumps `policies.version`. Because Redis keys include `:v${policy.version}:`, edited quotas take effect immediately on cache refresh without flushing stale counters.
3. **Fail-Closed by Default:** If Redis times out (`200 ms`) or disconnects, `evaluateRateLimit` defaults to `fail_closed` (`503 Service Unavailable`) rather than silently letting unthrottled traffic overwhelm upstreams. Routes can opt into `fail_open`.

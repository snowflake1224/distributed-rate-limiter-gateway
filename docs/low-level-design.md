# Low-Level Design (LLD)

## Module Map

| File | Responsibility |
| --- | --- |
| `src/api/gateway.ts` | `handleGateway`: API key auth -> `resolveRouteConfig` -> `buildRateLimitKey` -> `evaluateRateLimit` -> `applyRateLimitHeaders` -> `assertAllowed` -> `proxyUpstream` -> sandbox telemetry. |
| `src/cache/ttlLru.ts` | `TtlLruCache<T>`: O(1) `Map`-insertion-order LRU with lazy TTL expiration and `deleteByPrefix` / `peekByPrefix`. |
| `src/cache/configCache.ts` | `resolveAuthenticatedKey` (`apiKeyCache`) and `resolveRouteConfig` (`policyCache`), caching negative (`null`) lookups for TTL duration and exposing `invalidateTenantConfig` / `invalidateAllApiKeys`. |
| `src/policy/dimensions.ts` | `buildRateLimitKey`: resolves `tenant`, `api_key`, `route`, `ip`, and `custom` header (default `x-user-id`) into a SHA-256 prefix-scoped Redis key. |
| `src/redis/client.ts` | Registers `tokenBucket` and `slidingWindow` custom Lua commands on `ioredis` (`200 ms` `commandTimeout`), tracks `redisLatencySeconds` histogram. |
| `src/ratelimit/engine.ts` | `evaluateRateLimit` & `assertAllowed`: calls Redis Lua scripts, observes `decisionDurationSeconds`, handles `fail_closed` (`503`) vs `fail_open` (`remaining = -1`), throws `429` with `Retry-After` and `RateLimit-*` headers. |
| `src/circuitbreaker/breaker.ts` | `CircuitBreaker`: per-upstream `closed` (0) -> `open` (2) -> `half_open` (1) FSM; exposes Prometheus `gateway_circuit_breaker_state` and `gateway_circuit_breaker_transitions_total`. |
| `src/proxy/upstream.ts` | `proxyUpstream`: strips hop-by-hop headers, checks `breaker.canPass()`, strips route prefix, forwards `x-request-id` / `x-tenant-id` / `x-ratelimit-remaining`, treats HTTP `5xx`, timeouts (`AbortSignal.timeout`), and connection failures as breaker failures (`4xx` counts as upstream success). |
| `src/demo/sandboxes.ts` & `labSpec.ts` | Provisions 30-min sandbox tenants under `pg_advisory_xact_lock(727101)` (global & per-IP active caps) and encodes upstream test knobs into SSRF-safe local path segments `/lab/:id/r:rev/...`. |

## Key Invariants & Implementation Notes

1. **Key Lookup & Timing Safety (`src/cache/configCache.ts`):** Keys follow `gwk_<prefix>_<secret>`. The gateway queries Postgres by `key_prefix` and validates the SHA-256 hash using `crypto.timingSafeEqual` (`hashesEqual`). Both positive and negative (`null`) lookups enter the 5-second `TtlLruCache`.
2. **Sandbox Capacity Enforcement (`src/demo/sandboxes.ts`):** `createSandbox` acquires PostgreSQL transaction-scoped advisory lock `727101` before counting non-expired rows in `demo_sandboxes`, preventing concurrent visitors from bypassing `DEMO_SANDBOX_MAX` or `DEMO_SANDBOX_MAX_PER_IP`.
3. **Hop-by-Hop Header Hygiene (`src/proxy/upstream.ts`):** Strips `connection`, `keep-alive`, `transfer-encoding`, `host`, `content-length`, and related transport headers on both ingress proxy requests and upstream responses.
4. **Unused Schema Artifacts:** `src/db/migrations/001_initial.sql` defines `usage_snapshots` (and `touchLastUsed` in the API keys repository) as reserved schema structure; live request counting uses Prometheus metrics and sandbox `localState.ts` rather than writing per-request Postgres snapshot rows.

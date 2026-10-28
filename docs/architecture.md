# Architecture

```
Client
  -> Nginx (least_conn, serves the lab at /demo/)
    -> gateway-1 / gateway-2   (stateless Node.js)
      -> API key check          (hashed key -> tenant)
      -> Redis Lua rate limit   (token bucket or sliding window)
      -> circuit breaker        (per upstream, per instance)
      -> upstream
```

- **Nginx** spreads requests across two identical gateway processes. Either one can answer any request.
- **API key check.** The `X-API-Key` header is hashed and looked up; the key decides the tenant. Unknown or revoked keys get `401`.
- **Rate limit.** One Lua script per algorithm reads Redis `TIME`, checks the counter and updates it in a single atomic step, so both instances share one limit with no read-then-write race. The Redis key is built from the policy and its dimensions (tenant, plus `x-user-id` when the policy asks for per-user quotas). If Redis cannot answer, the request gets `503` (fail closed) unless the policy is set to `fail_open`.
- **Circuit breaker.** After N upstream failures the breaker opens and the gateway fails fast with `503`; after the recovery window it lets a probe through and closes again. Each instance keeps its own breaker.
- **Upstream.** Mock services in Compose (`upstream-ok`, `upstream-flaky`, `upstream-lab`).

## Where state lives

- **PostgreSQL** stores tenants, API keys, policies, routes and upstreams.
- **Redis** stores rate-limit counters only.

A per-instance policy cache avoids reading PostgreSQL on every request; after an edit it can be stale for up to `POLICY_CACHE_TTL_MS` (5 s in Compose).

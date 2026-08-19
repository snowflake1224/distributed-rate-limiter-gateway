# Failure modes

Default rate-limit fail policy: **fail-closed**. Configurable per policy (`fail_closed` | `fail_open`).

## Matrix

| Failure | Behavior | Status | What to look at |
| --- | --- | --- | --- |
| Invalid / missing API key | Reject before Redis | 401 | logs `unauthorized` |
| Suspended tenant | Reject after auth | 403 | `tenants.status` |
| No matching route | Reject | 404 | route patterns |
| Redis down / command timeout | Fail-closed: reject. Fail-open: allow and proxy | 503 or 200 | `gateway_redis_unavailable_total` |
| Redis overloaded | Same as timeout (`REDIS_COMMAND_TIMEOUT_MS`, default 200ms) | 503 / 200 | Redis p95, event-loop lag |
| PostgreSQL down, cache hit | Auth + policy still work until TTL | 200/429 | cache hit metrics |
| PostgreSQL down, cache miss | Cannot load policy | 503 | `gateway_postgres_latency_seconds` |
| Malformed policy body | Admin validation (zod + dimension check) | 400 | admin logs |
| Upstream connect fail | Breaker failure, `502` | 502 | `gateway_upstream_failures_total{reason="connect"}` |
| Upstream timeout | AbortSignal / undici timeouts | 504 | `reason="timeout"` |
| Upstream 5xx | Propagate status; count as breaker failure | 5xx | breaker state gauge |
| Circuit open | Fail fast, no upstream call | 503 + Retry-After | `gateway_circuit_breaker_state=2` |
| Stale cache | Other instances may serve old policy/key for up to TTL | varies | shorten TTL or add LISTEN/NOTIFY later |
| Gateway restart | In-memory cache and breakers reset. Redis limits survive. | — | readiness after Redis+PG ping |
| Connection pool exhaustion | PG queries fail; same as PG unavailable on miss | 503 | `PG_POOL_MAX`, PG latency |
| Nginx instance death | `max_fails` / `fail_timeout` skip the dead peer | — | nginx error log |

## Fail-closed vs fail-open

**Fail-closed** (default): if the limiter cannot be sure, it denies. Correct for payments, OTP, login, anything where extra traffic is abuse.

**Fail-open**: if Redis is gone, traffic still reaches upstream. Correct for a public marketing API where availability > strict quota. Risk: a Redis outage becomes an accidental DDoS of the origin.

Seed includes `fail-open-demo` on `/api/flaky` so you can compare (that route also uses the flaky upstream).

## Timeouts

| Hop | Knob |
| --- | --- |
| Redis command | `REDIS_COMMAND_TIMEOUT_MS` |
| Redis connect | `REDIS_CONNECT_TIMEOUT_MS` |
| PostgreSQL connect | `PG_CONNECTION_TIMEOUT_MS` |
| PostgreSQL statement | `PG_STATEMENT_TIMEOUT_MS` |
| Upstream | `upstreams.timeout_ms` or `routes.timeout_ms` |
| Nginx proxy | `proxy_*_timeout` in `nginx/nginx.conf` |
| Shutdown | `SHUTDOWN_DRAIN_MS` |

## Drills (these are implemented paths)

```bash
docker compose stop redis
curl -i http://localhost:8080/api/orders -H "X-API-Key: $ACME"
# 503 service_unavailable, metric redis_unavailable fail_closed

docker compose start redis
docker compose restart gateway-1
curl http://localhost:3000/health/ready
# redis + postgres must be true

docker compose stop postgres
# warm cache: requests may still pass until POLICY_CACHE_TTL_MS / API_KEY_CACHE_TTL_MS
# then 503 Configuration store unavailable
```

## What restart does *not* lose

Redis AOF is enabled in Compose (`--appendonly yes`). Token-bucket hashes and sliding-window ZSETs survive gateway restarts. They do not survive a Redis volume wipe.

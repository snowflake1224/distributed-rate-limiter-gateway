# Testing

## Unit (`npm test`)

No Docker. 23 tests, all local. Covers:

| File | What it proves |
| --- | --- |
| `tests/unit/token-bucket.test.ts` | Burst, refill math, cap, retry-after |
| `tests/unit/sliding-window.test.ts` | Exact limit, eviction, retry-after from oldest |
| `tests/unit/circuit-breaker.test.ts` | CLOSED → OPEN → HALF_OPEN probe limit → CLOSED/OPEN |
| `tests/unit/cache.test.ts` | LRU eviction, TTL, prefix invalidation |
| `tests/unit/auth.test.ts` | Hash ≠ plaintext, constant-time compare |
| `tests/unit/route-match.test.ts` | Specificity, method mismatch |
| `tests/unit/dimensions.test.ts` | Combinations change Redis keys; version in key |

The TS helpers in `src/ratelimit/algorithms.ts` match the Lua math so you can study the formula without Redis.

## Redis Lua + concurrency (`npm run test:integration`)

Requires `REDIS_URL` and `DATABASE_URL`.

| File | What it proves |
| --- | --- |
| `tests/integration/lua.test.ts` | 40 concurrent token-bucket calls allow exactly `capacity`; 50 concurrent sliding-window calls allow exactly `limit`; refill after time |
| `tests/integration/gateway.test.ts` | 401s, tenant-scoped admin 404, concurrent 429s, **two `createApp()` instances sharing Redis**, circuit opens after 5xx |

Race tests deliberately fire `Promise.all` so Node cannot accidentally serialize the decisions.

## Manual failure tests

Documented in `docs/failure-modes.md` and `examples/requests.md`:

- `docker compose stop redis` → 503 on fail-closed routes
- stop postgres after cache expiry → 503 on miss
- `/api/flaky` → upstream 5xx then circuit 503
- restart `gateway-1` → `/health/ready` and unchanged Redis remaining

## What “multi-instance” means in CI vs Compose

- Integration: two Express apps in one test process, one Redis. Proves shared Lua state.
- Compose: Nginx + `gateway-1` + `gateway-2`. Prove with curls to `:3000` and `:3002` or k6 against `:8080`.

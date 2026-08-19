# Interview questions and answers

Answers describe **this** repository. Do not claim features that are not in the code.

---

**Why Redis instead of PostgreSQL for counters?**

The hot path is “may I take one token?” at request rate. PostgreSQL would `UPDATE` a hot row (or insert events) with WAL, locks, and disk. Redis keeps the counter in memory and expires idle keys. PostgreSQL is still required for tenants, hashed keys, policies, routes, upstreams, and audit — durable, relational, constrained.

**Why Lua? Why not GET, compute, SET?**

Two instances can both read `remaining = 1` and both allow. Lua runs atomically on the Redis thread: read-modify-write is one script. Token bucket uses `HMGET`/`HSET`; sliding window uses `ZREMRANGEBYSCORE` + `ZCARD` + `ZADD`.

**Why is the API stateless?**

No in-memory quota. Nginx `least_conn` can send you to either `gateway-1` or `gateway-2`. Caches and breakers are local optimizations; losing them does not change the Redis remaining count.

**Token bucket math?**

`tokens = min(capacity, tokens + Δt * rate)`. Allow if `tokens >= cost`. `burstCapacity` is the max burst; `refillRatePerSec` is the sustainable rate. Seeded Acme orders: burst 20, refill 10/s.

**Sliding window trade-off?**

Precise ZSET: exact count in `(now - window, now]`, retry-after from the oldest event. Cost: memory and `ZREMRANGEBYSCORE` per request. Approximate (two buckets) is O(1) memory and slightly wrong at bucket edges — better at huge QPS per key. This repo implements precise.

**How do dimensions work without hard-coding combinations?**

`policies.dimensions` is an array. `buildRateLimitKey` concatenates `name=value` for each, hashes, and prefixes tenant + policy + version. Adding `ip` or `custom` is config, not a new limiter class.

**How do you authenticate without storing plaintext keys?**

`gwk_{prefix}_{secret}`. Store `key_prefix` + `SHA-256(pepper || key)`. Lookup by prefix, compare hashes with `timingSafeEqual`. Tenant id comes from that row. Client-supplied tenant headers are not authorization.

**Cache consistency?**

Write-through invalidation on the instance that handled the admin call; other instances stale until `POLICY_CACHE_TTL_MS` / `API_KEY_CACHE_TTL_MS` (5s). Bounded LRU. Trade-off: revocation can lag a few seconds. Next step would be `LISTEN/NOTIFY`, not stuffing config into Redis (Redis is reserved for limit state).

**Fail-open vs fail-closed?**

Closed: Redis error → 503. Open: allow. Default closed. Per-policy override. Payments should not fail-open.

**Circuit breaker states?**

CLOSED: traffic flows, count consecutive failures. OPEN: reject immediately until `cb_recovery_ms`. HALF_OPEN: at most `cb_half_open_max_probes` in-flight probes; success → CLOSED, failure → OPEN. In-process, per upstream id.

**Interaction with rate limiting?**

429 happens before proxy, so a limited client does not trip the breaker. Open breaker returns 503 while the tenant may still have tokens. That is intentional: tokens are not a right to melt the origin.

**Nginx role?**

TLS-termination-shaped reverse proxy (HTTP here), `least_conn`, fail stale peers. Not the rate limiter. If you rate-limit only in Nginx you lose multi-dimension tenant policy stored in Postgres.

**Node event loop?**

JS is single-threaded. Slow upstreams are fine if they are async. Sync work or huge JSON on the request path delays *everyone*. Metric: `gateway_eventloop_lag_seconds`. SHA-256 on high-entropy keys is acceptable; bcrypt on the hot path would not be.

**Connection pooling?**

`pg.Pool` caps concurrent PG sessions. Cache exists so the pool is not on the 99th percentile path. `instances × PG_POOL_MAX < postgres max_connections`.

**Clock issues?**

Lua uses Redis `TIME`. Node clocks are used for cache TTL and breaker recovery, not for the quota decision.

**What changes at 100x?**

See `docs/scaling.md`: Redis Lua and hot keys first, then sliding-window memory, then cache invalidation bus. Not “add Kafka”.

**How would you test races?**

`Promise.all` of 40 `tokenBucket` calls against capacity 10; assert exactly 10 allows. Same for sliding window. Two Express apps, one Redis, interleaved requests.

---

## Questions you should be able to ask the interviewer

- What is more expensive: a false allow (abuse) or a false deny (outage)? That picks fail mode.
- Is the limit global per tenant or per user? That is the dimension list.
- Is the origin more fragile than Redis? That is breaker vs limiter priority.

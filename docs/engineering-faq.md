# Engineering FAQ

## 1. How do two stateless gateway instances enforce one shared limit without doubling the quota?

Neither `gateway-1` nor `gateway-2` stores request counters in Node.js memory. Every request calls one of two Redis Lua scripts (`token_bucket.lua` or `sliding_window.lua`), and Redis executes Lua atomically on a single thread using its own `TIME` clock. Even under a 50-way parallel race split across `:3000` and `:3002`, only `capacity` requests see `allowed == 1`.

## 2. Token Bucket vs. Sliding Window — why support both?

- **Token Bucket (`O(1)` memory):** Stores only two numbers (`tokens`, `ts`) in a Redis hash. Ideal for high-cardinality keys where smooth sustained refill is acceptable after a burst.
- **Sliding Window (`O(limit)` memory):** Stores exact timestamps in a Redis `ZSET`, pruning `0..(now - window)` before counting. Eliminates fixed-window boundary bursts (e.g., `2x` traffic right across a minute boundary) at the cost of storing one sorted-set entry per admitted request.

## 3. What happens when a policy is edited while instances cache config for 5 seconds?

`TtlLruCache` caches `ResolvedRoute` per `(tenantId, method, path)` for `POLICY_CACHE_TTL_MS` (`5000 ms`). On the editing instance, `invalidateTenantConfig` deletes matching keys immediately via prefix scan; the sibling instance refreshes within 5 seconds. Because Redis rate-limit keys embed `:v${policy.version}:`, old and new policy versions never corrupt each other's counters during the transition window.

## 4. Why fail closed (`503`) by default when Redis times out (`200 ms`)?

If a gateway silently failed open during a Redis blip or network partition, abusive or retry-storm traffic would immediately flood downstream databases/upstreams unprotected. Setting `fail_closed` as the default ensures safety under dependency outage, while per-policy `fail_open` remains an explicit opt-in for non-critical endpoints.

## 5. Why are circuit breakers per-instance instead of stored in Redis?

A circuit breaker protects upstreams from slow/5xx cascading failures and relies on `Redis` *not* becoming a second single point of failure for upstream health tracking. Keeping `CircuitBreaker` in instance memory adds zero network hop latency, fails fast in microseconds when `open`, and works even when Redis is unreachable (if `fail_open` is active). Tradeoff: each gateway instance independently counts `cbFailureThreshold` failures before opening (`N * instances` total upstream probes in worst case).

## 6. How would you scale this design 10x?

- **Redis Cluster / Hash Tags:** Partition rate-limit keys across Redis Cluster shards using hash tags (`{tenantId}:...`) so Lua scripts remain single-slot atomic while spreading memory and single-thread CPU across nodes.
- **Pub/Sub or Versioned Cache Push:** Replace 5-second TTL staleness on sibling instances with Redis Pub/Sub invalidation broadcasts whenever an admin updates routes or revokes an API key.
- **Sticky / Local Token Batching (for ultra-hot tenants):** Lease small token batches (e.g., 10 tokens at a time) into instance memory for multi-thousand-RPS tenants to reduce Redis RTT overhead while trading strict per-request global precision.

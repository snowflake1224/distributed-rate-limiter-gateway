# Lua Rate-Limiting Algorithms & Key Design

## 1. Shared Server Clock (`redis.call('TIME')`)

Both Lua scripts read time from Redis via `redis.call('TIME')` (`seconds * 1000 + floor(microseconds / 1000)`) instead of accepting client/Node.js timestamps. Because `gateway-1`, `gateway-2`, and future replicas share Redis's single-threaded Lua execution and single clock, minor OS clock skew between gateway containers cannot skew token refills or sliding windows.

## 2. Token Bucket (`src/redis/lua/token_bucket.lua`)

- **Redis Data Structure:** Hash `KEYS[1]` with fields `tokens` (float) and `ts` (last refill timestamp in ms), expired via `PEXPIRE` (`max(windowMs * 2, 60_000)` ms).
- **Algorithm (`O(1)` time & `O(1)` space per key):**
  1. On cold miss (`tokens == nil`), initialize `tokens = capacity`, `ts = now_ms`.
  2. Otherwise compute `elapsed_ms = max(0, now_ms - ts)` and refill lazily:
     $$\text{tokens} = \min\!\left(\text{capacity},\; \text{tokens} + \frac{\text{elapsed\_ms} \times \text{refill\_rate}}{1000}\right)$$
  3. If `tokens >= cost`: decrement `tokens -= cost` and return `allowed = 1`; else compute `retry_after_ms = ceil(((cost - tokens) / refill_rate) * 1000)` and return `allowed = 0`.
  4. Persist `HSET` + `PEXPIRE` and return `{ allowed, remaining, retry_after_ms, now_ms, reset_ms, capacity }`.
- **Behavioral Profile:** Smooth continuous refill. Half a window after consuming a full burst of `B`, roughly `B / 2` tokens are immediately available again.

## 3. Precise Sliding Window (`src/redis/lua/sliding_window.lua`)

- **Redis Data Structure:** Sorted Set (`ZSET`) `KEYS[1]` storing unique member `${Date.now()}:${randomUUID()}` with score `now_ms`, expired via `PEXPIRE` (`windowMs + 5_000` ms).
- **Algorithm (`O(log N + M)` time, `O(limit)` space per active key):**
  1. `ZREMRANGEBYSCORE key 0 (now_ms - window_ms)` trims expired timestamps (`M` evicted entries).
  2. `count = ZCARD key` counts active events in `[now_ms - window_ms, now_ms]`.
  3. Only if `count < limit`: `ZADD key now_ms member` (`allowed = 1`, `remaining = limit - count - 1`). Rejected requests are **not** inserted into the ZSET (unlike naive implementations that count denied retries against future slots).
  4. On rejection, read oldest entry via `ZRANGE key 0 0 WITHSCORES` to compute exact `retry_after_ms = oldest_ms + window_ms - now_ms`.
- **Behavioral Profile:** Strict rolling count with zero boundary spike. Half a window after consuming `limit`, `0` new requests are permitted until the oldest recorded request ages out past `window_ms`.

## 4. Multi-Dimensional Key Hashing (`src/policy/dimensions.ts`)

`buildRateLimitKey` resolves ordered dimensions (`tenant`, `api_key`, `route`, `ip`, `custom` header such as `x-user-id`), joins `dim=value` with `|`, takes the first 32 hex chars of SHA-256, and constructs:

```text
rl:<algorithm>:<tenantId>:<policyId>:v<policyVersion>:<sha256_32>
```

Including `:v<policyVersion>:` ensures policy parameter updates isolate cleanly from counters written under earlier limits.

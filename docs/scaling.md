# Scaling

## Horizontal scaling today

Add gateway replicas behind Nginx. They share:

- Redis for decisions
- PostgreSQL for config (via local caches)

They do **not** share:

- policy cache contents
- circuit-breaker state

That is why the process is called stateless: losing an instance loses no quota.

Demonstrate shared limits:

```bash
curl -i http://localhost:3000/api/orders -H "X-API-Key: $ACME"
curl -i http://localhost:3002/api/orders -H "X-API-Key: $ACME"
```

Remaining decreases across instances because both run the same Lua against the same key.

## Bottlenecks, in order

1. **Redis single thread** — every limit decision is Lua on one Redis CPU. This is the first ceiling for a global hot key (one tenant + one route at huge QPS).
2. **Upstream** — if origins are slow, gateway sockets and event-loop delay grow; the breaker opens.
3. **Node event loop** — large bodies, log JSON, or sync work. Watch `gateway_eventloop_lag_seconds`.
4. **PostgreSQL** — only on cache miss / admin. Raise cache TTL or size before scaling PG for the gateway path.
5. **Nginx worker connections** — raise `worker_connections` before blaming Node.

Connection pooling: keep `PG_POOL_MAX` modest per instance (`instances × max` must fit `max_connections`). Redis: one ioredis connection per process is enough at this size.

## 10x traffic

What usually works without a redesign:

- More gateway instances (CPU-bound proxy + JSON)
- Keep policies coarse enough that you do not create millions of unique dimension keys per second
- Leave cache TTL at a few seconds; hit rate should already be high
- Watch Redis p95. If Lua p95 climbs, you are near the Redis core.

## 100x traffic

This design starts to need explicit capacity work:

- **Hot keys**: one celebrity tenant can serialize on one Redis key. Shard by dimension (`user_id`) or isolate whales on a dedicated Redis.
- **Sliding-window memory**: precise ZSETs at 50k allowed req/s/key × 60s window ≈ 3M entries. Switch that policy to token bucket or an approximate window.
- **Redis cluster**: hash-tag the tenant so a key stays on one slot; Lua still cannot touch keys across slots.
- **Config fanout**: `LISTEN/NOTIFY` or a version counter so TTL can be longer without stale revocation.
- **Distributed tracing** if you need per-hop debug at that volume (not in this repo).
- Still no Kafka/K8s required for a single-region gateway.

## Capacity sketch (reasoning, not measured)

A decision is: cache lookup + one Redis RTT + maybe proxy.

If Redis RTT is 0.3–1ms on the LAN, one Node instance can issue tens of thousands of concurrent Redis calls because it is I/O bound. The limiter’s *correctness* limit is Redis Lua throughput on the hottest keys, not “number of Node instances”.

Adding instances increases *proxy* throughput until Redis or upstream saturates. That is why the k6 suite compares `:3000` (one instance) vs `:8080` (two instances). Record where p99 stops improving — that is your current bottleneck.

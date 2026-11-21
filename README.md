# Distributed Rate Limiter & API Gateway

**Two stateless gateway instances, one atomic Redis limit.** Nginx (`least_conn`) spreads traffic across two identical Node.js processes. Both share one counter in Redis via atomic Lua scripts (`token_bucket.lua` and `sliding_window.lua` using Redis `TIME`), so a 50-way race across both instances admits exactly `capacity` requests. When Redis cannot decide within `200 ms`, the gateway fails closed with `503` by default.

![Distributed Rate Limiter & API Gateway Architecture](docs/diagrams/architecture.svg)

## Key Engineering Highlights

- **Atomic Shared State:** Single-RTT Lua `EVALSHA` scripts compute refills or prune ZSET timestamps under Redis's single clock (`TIME`), eliminating check-then-act races between instances.
- **Burst vs. Sliding Window:** Switch any policy between `token_bucket` (`O(1)` memory, continuous refill) and `sliding_window` (`O(limit)` ZSET, strict rolling count with zero boundary burst).
- **Split Control vs. Data Plane:** PostgreSQL stores tenants, hashed API keys (`SHA-256` + timing-safe verify), policies, routes, and upstreams (cached per instance for `5 s` in `TtlLruCache`); Redis holds ephemeral counters only.
- **Per-Instance Circuit Breakers & Gateway Lab:** Protects failing upstreams (`closed -> open -> half_open`) and ships an interactive Gateway Lab at **http://localhost:8080/** (with `/demo/` redirecting to `/`) backed by isolated 30-minute sandboxes (`pg_advisory_xact_lock`).

![Gateway Lab: results of a 100-request race against two gateway instances](docs/images/lab-results.png)

## Quick Start

Requires Docker with Compose v2.

```bash
docker compose up --build
```

Open **http://localhost:8080/** (`http://localhost:8080/demo/` also redirects to `/`) and run:

1. **Two instances, one limit:** 100 requests (50 concurrent) sent directly to `gateway-1` and `gateway-2` — exactly `capacity` pass.
2. **Sliding window vs. token bucket:** Compare half-window recovery after consuming the full burst.
3. **Circuit breaker lifecycle:** Upstream fails its first 6 requests; each instance opens independently and recovers after the cooldown window.

Direct CLI test against both instances (using the seeded local key in `.local/seed-secrets.json`):

```bash
curl -i http://localhost:3000/api/orders -H "X-API-Key: gwk_acmelocal_local_demo_key_not_secret"
curl -i http://localhost:3002/api/orders -H "X-API-Key: gwk_acmelocal_local_demo_key_not_secret"
```

## Verified Metrics & Tests

- **Automated Tests:** **77 tests** (`39` backend unit, `21` live Postgres+Redis integration tests across two instances, `17` frontend unit tests).
- **k6 Laptop Baseline (`2026-08-19`):** On `/api/orders` (`burst 20`, `refill 10/s`), throughput scaled from **~80 req/s** (`:3000`) to **~152–157 req/s** across both instances (`:8080`) while keeping the allowed quota invariant (excess rejected with `429`).

```bash
npm install && npm test
cd frontend && npm install && npm test && npm run build
```

## Documentation

| Document | Contents |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | High-level design, state split, edge rules, and flow diagrams |
| [docs/low-level-design.md](docs/low-level-design.md) | Request lifecycle, `TtlLruCache`, circuit breaker FSM, sandbox locks |
| [docs/lua-algorithms.md](docs/lua-algorithms.md) | `token_bucket.lua`, `sliding_window.lua`, Redis `TIME`, dimension hashing |
| [docs/data-model.md](docs/data-model.md) | PostgreSQL schema, indexes, and sandbox tables |
| [docs/benchmarks-and-testing.md](docs/benchmarks-and-testing.md) | Unit/integration test breakdown and k6 load test details |
| [docs/interview-guide.md](docs/interview-guide.md) | Distributed rate-limiting Q&A, failure tradeoffs, and scaling paths |

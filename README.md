# Distributed Rate Limiter / API Gateway

A stateless, multi-tenant API gateway that authenticates API keys, applies **atomic Redis Lua rate limits**, then reverse-proxies to configurable upstreams behind a **circuit breaker**.

Nginx load-balances two Node.js instances. PostgreSQL is the source of truth for tenants, keys, policies, routes, and upstreams. Redis holds only the hot rate-limit counters.

This is a study/portfolio system at SDE-1 / early SDE-2 backend depth: concurrency, failure modes, caching consistency, and capacity reasoning are first-class, not afterthoughts.

## What you can defend in an interview

- Why Redis + Lua, not PostgreSQL counters, on the hot path
- Token bucket vs precise sliding window
- Fail-closed vs fail-open
- Why the process is stateless and how two instances share one limit
- In-process policy cache vs hitting PostgreSQL every request
- How rate limiting and circuit breaking interact
- What breaks at 10x / 100x traffic

## Architecture

```
Client
  → Nginx (least_conn)
    → gateway-1 / gateway-2  (stateless Node.js)
      → API-key auth (hash lookup, tenant from credentials)
      → in-process policy/route cache  (TTL + LRU; miss → PostgreSQL)
      → Redis Lua  (token bucket or sliding window)
      → per-upstream circuit breaker
      → configurable upstream
```

PostgreSQL never increments a request counter. Redis never stores policies.

## Quick start

Prerequisites: Docker, Docker Compose, Node 20+, and [k6](https://k6.io) for load tests.

```bash
docker compose up --build
```

Wait until `nginx`, both gateways, Prometheus (`:9090`), and Grafana (`:3001`) are up.

Seed writes one-time plaintext keys to `.local/seed-secrets.json`:

```json
{ "adminApiKey": "dev-admin-key-change-me", "acmeKey": "gwk_...", "globexKey": "gwk_..." }
```

```bash
curl -i http://localhost:8080/api/orders \
  -H "X-API-Key: <acmeKey>"
```

| Surface | URL |
| --- | --- |
| Load-balanced gateway | http://localhost:8080 |
| Instance 1 | http://localhost:3000 |
| Instance 2 | http://localhost:3002 |
| Prometheus | http://localhost:9090 |
| Grafana (admin/admin) | http://localhost:3001 |
| Admin API | http://localhost:8080/admin/v1 |

More curls: [`examples/requests.md`](examples/requests.md).

## Local tests

```bash
npm install
cp .env.example .env
npm test
```

Integration tests need Compose Postgres + Redis:

```bash
docker compose up -d postgres redis
$env:DATABASE_URL="postgres://gateway:gateway@localhost:5432/gateway"
$env:REDIS_URL="redis://localhost:6379"
npm run migrate
npm run test:integration
```

## Load tests

```bash
$env:API_KEY="(from .local/seed-secrets.json)"
k6 run load-tests/k6/single-instance.js   # BASE_URL default :3000
k6 run load-tests/k6/multi-instance.js    # BASE_URL default :8080
k6 run load-tests/k6/burst.js
```

Measured local k6 results (2026-08-19) are in [`docs/results.md`](docs/results.md): about **80 req/s** on one instance vs **152–157 req/s** across two Nginx-balanced instances. Those are laptop Docker Compose numbers, not production capacity. Re-run the scripts below rather than inventing additional figures. See also [`docs/benchmarks.md`](docs/benchmarks.md).

## Layout

```
src/api/            Express admin + gateway + errors
src/auth/           API-key generation, hashing, middleware
src/cache/          Bounded TTL LRU + config cache
src/circuitbreaker/ CLOSED / OPEN / HALF_OPEN
src/db/             Pool, migrations, repositories
src/policy/         Route match + dimension keys
src/ratelimit/      Engine + algorithm notes
src/redis/          ioredis + Lua scripts
src/proxy/          Upstream reverse proxy
src/metrics/        Prometheus registry
src/health/         Liveness / readiness
docs/               Architecture and interview notes
```

## Documentation

- [Architecture](docs/architecture.md)
- [Data model](docs/schema.md)
- [Failure modes](docs/failure-modes.md)
- [Scaling](docs/scaling.md)
- [Testing](docs/testing.md)
- [Benchmarks](docs/benchmarks.md)
- [Numbers & results log](docs/results.md)
- [Interview Q&A](docs/interview-qa.md)
- [PromQL](docs/promql.md)

## Default fail policy

**Fail-closed.** If Redis cannot complete the Lua decision, the request is rejected with `503` unless that policy sets `failMode: fail_open`.

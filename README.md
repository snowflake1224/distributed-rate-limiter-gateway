# Distributed Rate Limiter / API Gateway

A stateless, multi-tenant API gateway that authenticates API keys, applies **atomic Redis Lua rate limits**, then reverse-proxies to configurable upstreams behind a **circuit breaker**. Nginx load-balances two Node.js instances. PostgreSQL is the source of truth for tenants, keys, policies, routes and upstreams. Redis holds only the hot rate-limit counters.

**Try it: [Gateway Lab](https://YOUR-DOMAIN/demo/)**. It is an interactive page on the deployed system. You get a private sandbox tenant, configure a policy and a misbehaving upstream, send real traffic, and check every decision against the model.

![Gateway Lab: results of a 100-request race against two gateway instances](docs/images/lab-results.png)

## Try it in 60 seconds

1. Open the lab and press **Run experiment** on *Burst, then throttle*. The lab creates a sandbox (tenant, API key, policy, route, mock upstream; deleted after 30 minutes), sends 30 requests and shows the first 429.
2. Pick *Two instances, one limit*. The gateway fires 100 requests, 50 at a time, at **gateway-1 and gateway-2 directly**. Exactly `capacity` requests pass. Two in-memory counters would have let through twice as many.
3. Pick *Circuit breaker lifecycle*. The upstream fails its first 6 calls. Each instance opens its own breaker after 3 failures and fails fast. After the recovery window, the breakers close again. The live state table shows both instances changing state.
4. Change any number in **Configure your sandbox** and press **Apply changes live**, or build your own traffic in **Send real traffic**.

Every row in the results table is a real HTTP response with its request ID, `X-Gateway-Instance`, `RateLimit-*` headers and body. Nothing on the page is simulated. The "expected" numbers come from replaying the token-bucket or sliding-window model against the actual send times.

| Experiment | What it demonstrates |
| --- | --- |
| Burst, then throttle | Token bucket capacity, `Retry-After` |
| Refill over time | Refill computed from Redis `TIME`, independent of which instance answers |
| Sliding window vs token bucket | Same average rate, very different behavior half a window after a burst |
| Per-user quotas | Dimensions hashed into the Redis key (`x-user-id`) |
| Two instances, one limit | No over-admission under a real 50-way race across instances |
| Live policy change | Versioned Redis keys and the bounded staleness of the per-instance config cache |
| Circuit breaker lifecycle | closed → open → half-open → closed, per instance |
| Fail closed vs fail open | What happens when Redis is unavailable (run locally) |

![Circuit breaker experiment with steps and checks](docs/images/lab-breaker.png)

## Verify it from your terminal

The lab shows copy-ready `curl`, PowerShell and k6 commands for any run, using your sandbox key. Without the UI:

```bash
ORIGIN=https://YOUR-DOMAIN

# create a sandbox: 5 tokens, refill 0.5/s
curl -s -X POST $ORIGIN/demo/v1/sandboxes -H 'content-type: application/json' -d '{
  "policy":   {"algorithm":"token_bucket","burstCapacity":5,"refillRatePerSec":0.5,"limitCount":10,"windowMs":10000,
               "dimensions":["tenant","api_key","route"],"customHeader":"x-user-id","failMode":"fail_closed"},
  "upstream": {"delayMs":0,"failRatePct":0,"failFirstN":0,"errorStatus":503,"timeoutMs":2000,
               "cbFailureThreshold":3,"cbRecoveryMs":5000,"cbHalfOpenMaxProbes":1}
}'
# -> { "sandbox": { "id": "...", "routePrefix": "/sbx/<id>", ... }, "apiKey": "gwk_...", "token": "..." }

for i in $(seq 1 8); do
  curl -s -o /dev/null -w "%{http_code} remaining=%header{ratelimit-remaining} via=%header{x-gateway-instance}\n" \
    $ORIGIN/sbx/<id>/orders -H "x-api-key: gwk_..."
done
```

More in [`docs/demo.md`](docs/demo.md) and [`examples/requests.md`](examples/requests.md).

## What you can defend in an interview

- Why Redis + Lua, not PostgreSQL counters, on the hot path
- Token bucket vs precise sliding window
- Fail-closed vs fail-open
- Why the process is stateless and how two instances share one limit
- In-process policy cache vs hitting PostgreSQL every request, and the staleness it costs
- How rate limiting and circuit breaking interact
- What breaks at 10x / 100x traffic

## Architecture

```
Client
  → Nginx (least_conn, per-IP limit_req, serves the lab at /demo/)
    → gateway-1 / gateway-2  (stateless Node.js)
      → API-key auth (hash lookup, tenant from credentials)
      → in-process policy/route cache  (TTL + LRU; miss → PostgreSQL)
      → Redis Lua  (token bucket or sliding window)
      → per-upstream circuit breaker
      → configurable upstream
```

PostgreSQL never increments a request counter. Redis never stores policies.

### How the lab is built

- **Sandboxes** are ordinary tenants (`sbx-<id>`) with their own key, policy, route `/sbx/<id>/*` and upstream. They go through the same auth, cache, Lua and breaker code as every other tenant. They expire after 30 minutes and a sweeper deletes them. Global and per-IP caps are enforced inside a transaction with a PostgreSQL advisory lock.
- **The lab upstream** gets its behavior (delay, failure rate, fail-first-N, status code) from a URL path that the server builds from validated settings. Visitors never provide an upstream URL, so there is no SSRF surface.
- **Per-instance state** (breaker, cached policy version, outcome counts) is read from every gateway through `DEMO_PEER_URLS`. That is how the lab shows two breakers opening independently.
- **The server-side runner** (`POST /demo/v1/sandboxes/:id/runs`) sends up to 200 requests, at most 50 concurrent, alternating between instances directly. A browser cannot create that race because it opens only about 6 connections per host.
- **Responses** carry `X-Gateway-Instance` and `X-RateLimit-Policy-Version` so each decision can be traced to an instance and a policy version.
- **The frontend** (`frontend/`) is React + Vite with no UI or chart libraries. Nginx serves it from the same origin, so there is no CORS.

## Run it locally

Prerequisites: Docker with Compose v2, Node 20+, and [k6](https://k6.io) for load tests.

```bash
docker compose up --build
```

Then open **http://localhost:8080/demo/**.

| Surface | URL |
| --- | --- |
| Gateway Lab | http://localhost:8080/demo/ |
| Load-balanced gateway | http://localhost:8080 |
| Instance 1 (incl. Admin API, `/metrics`) | http://localhost:3000 |
| Instance 2 | http://localhost:3002 |
| Prometheus | http://localhost:9090 |
| Grafana (admin/admin) | http://localhost:3001 |

Nginx does not expose `/admin/v1` or `/metrics`. Use an instance port locally. In production they are reachable only inside the Compose network.

Seed writes one-time plaintext keys to `.local/seed-secrets.json`:

```bash
curl -i http://localhost:8080/api/orders -H "X-API-Key: <acmeKey>"
```

Lab frontend development with hot reload, against the running Compose stack:

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173/demo/, proxies API calls to :8080
```

## Tests

```bash
npm install
npm test                       # unit tests, including lab schemas, lab upstream and breaker snapshots

docker compose up -d postgres redis
$env:DATABASE_URL="postgres://gateway:gateway@localhost:5432/gateway"
$env:REDIS_URL="redis://localhost:6379"
npm run migrate
npm run test:integration       # gateway, Lua, and sandbox lifecycle across two in-process instances

cd frontend
npm test                       # expected-vs-observed models, exporters, validation, breaker model
npm run build
```

## Load tests

```bash
$env:API_KEY="(from .local/seed-secrets.json)"
k6 run load-tests/k6/single-instance.js   # BASE_URL default :3000
k6 run load-tests/k6/multi-instance.js    # BASE_URL default :8080
k6 run load-tests/k6/burst.js
```

Measured local k6 results (2026-08-19) are in [`docs/results.md`](docs/results.md): about **80 req/s** on one instance vs **152–157 req/s** across two Nginx-balanced instances. Those are laptop Docker Compose numbers, not production capacity. See also [`docs/benchmarks.md`](docs/benchmarks.md).

## Deploying

`docker-compose.prod.yml` publishes no host ports. Nginx joins the external `portfolio-edge` network as `gateway-edge:8080`, and the host's edge proxy routes to it. Nginx trusts `X-Forwarded-For` only from private ranges, so per-IP limits and sandbox caps use the real client address. Copy `env.production.example` to `.env`, then:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Set `DEMO_SANDBOX_ENABLED=false` to turn off sandbox creation. The lab then offers only the seeded public demo tenant.

## Layout

```
src/api/            Express admin + gateway + lab (demo) routers
src/auth/           API-key generation, hashing, middleware
src/cache/          Bounded TTL LRU + config cache
src/circuitbreaker/ CLOSED / OPEN / HALF_OPEN
src/db/             Pool, migrations, repositories
src/demo/           Sandboxes, lab upstream spec, per-instance state, server-side runner
src/policy/         Route match + dimension keys
src/ratelimit/      Engine + algorithm notes
src/redis/          ioredis + Lua scripts
src/proxy/          Upstream reverse proxy
src/upstream/       Mock upstreams (ok, flaky, slow, lab)
src/metrics/        Prometheus registry
src/health/         Liveness / readiness
frontend/           Gateway Lab (React + Vite), served by Nginx at /demo/
docs/               Architecture and interview notes
```

## Documentation

- [Gateway Lab guide](docs/demo.md)
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

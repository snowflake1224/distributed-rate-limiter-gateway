# Distributed Rate Limiter / API Gateway

**Two gateway instances, one limit.** Nginx load-balances two stateless Node.js processes. Both share one counter in Redis, and a Lua script makes check-and-decrement a single atomic step, so a 50-way race across both instances still admits exactly `capacity` requests. Two in-memory counters would have admitted twice as many. If Redis cannot decide, the gateway fails closed with `503`.

**Burst vs sliding window.** The same policy can use a token bucket or a sliding window. With the same average rate, both allow a burst of about `limit` requests, but half a window later the token bucket has refilled about half its tokens while the sliding window still counts every recent request and allows none.

The Gateway Lab at **http://localhost:8080/demo/** sends real HTTP traffic at both instances and checks every response against the model. Each visitor gets a private sandbox tenant (key, policy, route, mock upstream) that expires after 30 minutes.

![Gateway Lab: results of a 100-request race against two gateway instances](docs/images/lab-results.png)

## Run it

Prerequisites: Docker with Compose v2. Node 20+ and [k6](https://k6.io) only for tests and load tests.

```bash
docker compose up --build
```

Open **http://localhost:8080/demo/** and run, in order:

1. *Two instances, one limit*: 100 requests, 50 at a time, sent to gateway-1 and gateway-2 directly. Exactly `capacity` pass.
2. *Sliding window vs token bucket*: the burst-then-wait contrast above.
3. *Circuit breaker lifecycle*: the upstream fails its first 6 calls; each instance opens its own breaker and fails fast, then closes after the recovery window.

Every row in the results table is a real response with `X-Gateway-Instance` and `RateLimit-*` headers.

Without the UI, use the seeded demo key (written to `.local/seed-secrets.json`) and hit each instance directly. Both draw from the same bucket:

```bash
curl -i http://localhost:3000/api/orders -H "X-API-Key: gwk_acmelocal_local_demo_key_not_secret"
curl -i http://localhost:3002/api/orders -H "X-API-Key: gwk_acmelocal_local_demo_key_not_secret"
```

`/api/search` is a sliding-window route limited per tenant plus the `X-User-Id` header.

## How it works

Nginx → two stateless Node processes → API key check → Redis Lua rate limit → circuit breaker → upstream. PostgreSQL stores tenants, keys, policies and routes; Redis stores counters only. Policies limit by tenant, optionally split per user with the `x-user-id` header. See [docs/architecture.md](docs/architecture.md).

## Tradeoff: fail closed

When Redis is down or times out, the default is **fail closed**: the gateway returns `503` rather than let unlimited traffic reach the upstream. A policy can set `failMode: fail_open` for a route you would rather serve unlimited than block.

## One laptop result

k6 against the seeded `/api/orders` policy (burst 20, refill 10/s), measured 2026-08-19: about **80 req/s** handled on one instance (`:3000`) vs about **152–157 req/s** across two instances behind Nginx (`:8080`). The allowed rate did not double, because both instances share one Redis limit; most responses were `429`. This is a laptop Docker Compose number, not production capacity.

```bash
$env:API_KEY="gwk_acmelocal_local_demo_key_not_secret"
k6 run load-tests/k6/single-instance.js   # one instance, :3000
k6 run load-tests/k6/multi-instance.js    # load balancer, :8080
```

## Metrics

Each instance exposes Prometheus metrics at `/metrics` (instance ports only; Nginx does not route it): `gateway_ratelimit_allowed_total`, `gateway_ratelimit_rejected_total`, and `gateway_circuit_breaker_state` (`2` = open). Grafana at http://localhost:3001 (admin/admin) has one dashboard with three panels: allowed, limited, and breakers open.

## Tests

```bash
npm install
npm test                       # unit tests

docker compose up -d postgres redis
$env:DATABASE_URL="postgres://gateway:gateway@localhost:5432/gateway"
$env:REDIS_URL="redis://localhost:6379"
npm run migrate
npm run test:integration       # gateway, Lua races, sandboxes across two in-process instances

cd frontend
npm install
npm test
npm run build
```

## Deploying

The deployment target is a single Docker host running this same Compose stack. `docker-compose.prod.yml` publishes no host ports; Nginx joins an external `portfolio-edge` network and the host's edge proxy routes to it. Secrets (`ADMIN_API_KEY`, `API_KEY_PEPPER`, demo keys) come from a `.env` file copied from `env.production.example`, which is not committed.

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

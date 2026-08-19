# Benchmarks

Load tests are **k6**. This repository does not ship invented p99s. After you run a test, paste k6’s summary and the Grafana/Prometheus values from the same window.

## Setup

```bash
docker compose up --build
```

Read `.local/seed-secrets.json` for `acmeKey` / `globexKey`.

Optional: watch Grafana http://localhost:3001 (dashboard **Distributed Rate Limiter / API Gateway**) and Prometheus http://localhost:9090.

## Suite

| Script | Default target | Intent |
| --- | --- | --- |
| `load-tests/k6/smoke.js` | `:8080` | Sanity, headers present |
| `load-tests/k6/single-instance.js` | `:3000` | One Node process |
| `load-tests/k6/multi-instance.js` | `:8080` | Nginx → two processes |
| `load-tests/k6/burst.js` | `:8080` | Spike; expect many 429s |
| `load-tests/k6/multi-tenant.js` | `:8080` | Acme + Globex isolation |

PowerShell:

```powershell
$env:API_KEY = (Get-Content .local/seed-secrets.json | ConvertFrom-Json).acmeKey
$env:GLOBEX_API_KEY = (Get-Content .local/seed-secrets.json | ConvertFrom-Json).globexKey

k6 run load-tests/k6/smoke.js
k6 run load-tests/k6/single-instance.js
k6 run --env RATE=160 --env DURATION=45s load-tests/k6/multi-instance.js
k6 run load-tests/k6/burst.js
k6 run load-tests/k6/multi-tenant.js
```

Override target with `--env BASE_URL=http://localhost:3000`.

## What to record

From k6:

- `http_reqs` rate (throughput)
- `http_req_duration` p50 / p95 / p99
- `http_req_failed` (note: 429 is not an HTTP transport failure)

From Prometheus during the same run (`docs/promql.md`):

- Redis p95 (`gateway_redis_latency_seconds`)
- PostgreSQL p95 (should stay quiet after cache warmup)
- `gateway_eventloop_lag_seconds`
- `process_resident_memory_bytes` and `rate(process_cpu_seconds_total[1m])` per instance
- allowed vs rejected rates

## How to read single vs multi

If two instances roughly double throughput and p99 stays flat, you were **CPU/event-loop bound** on one Node process.

If throughput barely moves and Redis p95 climbs, you were **Redis/Lua bound** (often one hot key: seeded `/api/orders` is tenant+key+route, so all VUs share one bucket).

If upstream latency dominates (`gateway_upstream_latency_seconds`), scale or mock origins; the limiter is not the bottleneck.

Burst tests are supposed to produce 429s. That is the limiter working, not a failed benchmark.

## Results log

Measured k6 numbers (2026-08-19) are recorded in **[results.md](results.md)**.

Do not invent additional p50/p95/p99 or throughput beyond that file.

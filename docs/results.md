# Project Numbers & Results Log

Complete reference for **resume-safe facts**, **measured k6/Prometheus results**, and behavior notes.

Measured on: **2026-08-19** (local Docker Compose + k6 on Windows).  
Do not invent additional numbers beyond what is recorded here.

---

## 1. Architecture & verification numbers (resume-safe)

| Category | Value | Notes |
| --- | --- | --- |
| Project name | Distributed Rate Limiter / API Gateway | |
| Language / runtime | TypeScript, Node.js (≥20), Express | |
| Gateway replicas | **2** | Behind Nginx `least_conn` |
| Load balancer | Nginx | Port **8080** |
| Direct instances | `:3000`, `:3002` | |
| Rate-limit algorithms | **2** | Token Bucket, Sliding Window (Redis Lua) |
| Dimensions | **5** | tenant, api_key, route, ip, custom |
| Circuit breaker states | **3** | CLOSED, OPEN, HALF_OPEN |
| Default Redis fail mode | Fail-closed → **503** | Per-policy override supported |
| Policy / API-key cache TTL | **5000 ms** | Bounded LRU |
| Unit tests | **23 / 23 pass** | 7 files (2026-08-19) |
| Integration tests | **10 / 10 pass** | gateway + Lua (2026-08-19) |
| k6 scripts run | **5** (+ 2 targeted re-runs) | See Section 4 |
| Observability | Prometheus `:9090`, Grafana `:3001` | |
| Seeded Acme `/api/orders` policy | Token bucket **burst 20**, **refill 10/s** | Explains high 429 rates under load |

### Live smoke (before k6)

| Check | Result |
| --- | --- |
| `GET /health/live` via Nginx | **200** (`instance: gateway-1`) |
| `GET /api/orders` with Acme key | **200**, `RateLimit-Limit: 20`, `RateLimit-Remaining: 19` |
| Upstream body | `upstream: ok`, tenantId present |

---

## 2. How to read these results (important)

k6’s `http_req_failed` counts **any non-2xx** as failed by default. For this project, most “failures” under load are **HTTP 429 Rate Limited** — that means the limiter is working, not that the gateway crashed.

Evidence:

- Smoke (low RPS): `http_req_failed = 0%`
- Sustained 80–160 RPS against a **10 req/s refill** policy: `http_req_failed ≈ 87–93%` while checks like `not 5xx` / `controlled (200|429)` stay ≈ **100%**

**Allowed throughput** for Acme `/api/orders` is bounded by Redis shared state (~burst then ~10/s).  
**Handled throughput** (200 + 429) can be much higher — that is gateway + Nginx capacity.

---

## 3. Resume phrasing (backed by this log)

Safe to use:

- Built a **stateless multi-tenant API gateway** (TypeScript/Node.js/Express) with **2** instances behind **Nginx**, **Redis Lua** Token Bucket & Sliding Window, **PostgreSQL** config, circuit breakers, Prometheus/Grafana.
- Verified with **23 unit** + **10 integration** tests (auth, tenant isolation, concurrent Lua races, shared multi-instance limits, circuit breaker).
- k6 smoke: **~9.3 req/s**, **p95 23 ms**, **0%** transport/HTTP errors, RateLimit headers present.
- Sustained single-instance: **~80 req/s** handled, **p95 ~24–29 ms**; ~**87%** responses were non-2xx (primarily **429** under a 10/s policy) with **≈100%** non-5xx checks.
- Multi-instance via Nginx at **160/s offered**: **~152–157 req/s** handled (**nearly 2×** single-instance offered/handled rate); shared Redis quota still enforced (high 429 rate, checks green).
- Burst/spike: **~139 req/s**, **p95 ~43 ms**, **100%** responses were controlled **200 or 429**.
- Multi-tenant: Acme + Globex isolation checks **100%** at **~402 HTTP req/s** (~201 iterations/s × 2 calls).

---

## 4. Benchmark results log (measured 2026-08-19)

### Summary table

| Run | Script | Target | Config | req/s | p50 / med (ms) | p95 (ms) | max (ms) | http_req_failed | Key checks | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | smoke.js | `:8080` | 2 VUs × 20s | **9.30** | **11.54** | **23.42** | 81.23 | **0.00%** | 200\|429 + RateLimit headers **100%** | Healthy baseline |
| 2 | single-instance.js | `:3000` (default) | 80/s × 45s | **79.99** | **6.28** | **24.21** | 466.97 | **86.97%** | not 5xx **99.97%** (1 miss) | Mostly 429s; limiter active |
| 3 | multi-instance.js | `:8080` | 160/s × 45s | **151.99** | **25.86** | **637.21** | 2800 | **93.18%** | not 5xx **100%** | 360 dropped iters; tail latency high |
| 4 | burst.js | `:8080` | spike → 200/s, 30s | **139.12** | **12.43** | **43.45** | 249.05 | **92.59%** | controlled 200\|429 **100%** | Spike handled cleanly |
| 5 | multi-tenant.js | `:8080` | 20 VUs × 30s | **402.07** HTTP | **45.75** | **78.40** | 344.69 | **96.44%** | acme+globex isolated **100%** | 6046 iters (~201/s) |
| 6 | single-instance.js | `:3000` explicit | 80/s × 45s | **80.00** | **10.19** | **29.14** | 232.97 | **86.97%** | not 5xx **100%** | Confirms run 2 |
| 7 | multi-instance.js | `:8080` explicit | 160/s × 45s | **156.82** | **36.38** | **638.36** | 2650 | **93.40%** | not 5xx **100%** | Hit 120 VU cap warning |

### Side-by-side: horizontal scaling (offered load)

| Metric | 1 instance `:3000` @ 80/s | 2 instances `:8080` @ 160/s | Observation |
| --- | --- | --- | --- |
| Handled req/s | **~80** | **~152–157** | ≈ **1.9–2.0×** handled rate when offered load doubles |
| p50 / med | **~6–10 ms** | **~26–36 ms** | Higher under heavier load / more rejections |
| p95 | **~24–29 ms** | **~637–638 ms** | Tail latency degrades at 160/s overload |
| not-5xx checks | ≈100% | 100% | Gateway stays stable (no error storm) |
| Shared Redis limit | High 429 share (~87%) | Higher 429 share (~93%) | Quota is **global**, not per instance |
| Bottleneck at 160/s | — | Latency + k6 VU/dropped iters | Overloaded arrival vs shared 10/s refill; queueing under rejection load |

### 2xx-only latency (k6 `{ expected_response:true }`)

Useful when separating “allowed” path from 429 path:

| Run | avg (ms) | med (ms) | p95 (ms) |
| --- | --- | --- | --- |
| Smoke (all were 2xx) | 13.31 | 11.54 | 23.42 |
| Single @ 80/s | 16.41 / 18.8 | 9.56 / 15.94 | 38.45 / 44.75 |
| Multi @ 160/s | 198 / 177 | 50 / 54 | 771 / 731 |
| Burst | 23.36 | 18.61 | 53.23 |
| Multi-tenant | 67.73 | 59.17 | 123.62 |

Under multi-instance overload, **allowed** requests also slow down (p95 ~0.7–0.8s) — congestion / contention, not just fast 429 rejects.

---

## 5. Behavior analysis (what the system is doing)

### Healthy path works

Smoke + live curl show:

- Nginx routes to a gateway instance
- Auth succeeds
- Redis returns limit headers
- Upstream `ok` responds
- p95 stays low (~23 ms) when traffic is within/near policy comfort

### Rate limiter is doing its job

Seeded Acme orders policy: **burst 20, refill 10/s**.

At **80 req/s** offered:

- Gateway handles ~**80 req/s** of decisions
- Most decisions are **deny (429)** after the burst is consumed
- That produces ~**87%** `http_req_failed` in k6 **without** meaning the service is down
- `not 5xx` ≈ 100% confirms rejects are controlled, not crashes

This is the correct demo of a shared Redis quota under intentional overload.

### Horizontal scaling

Going from **1 instance @ 80/s** → **2 instances @ 160/s**:

- Handled request rate roughly **doubles** (~80 → ~155)
- The **allow** budget does **not** double (same Redis key / same policy)
- So you get more **decision throughput**, not more **allowed** QPS

That is exactly what a correct distributed limiter should do.

### Why multi-instance p95 is high (~640 ms)

At 160/s with ~93% 429s:

- k6 reported **dropped iterations** and (on re-run) **insufficient VUs**
- Allowed-path p95 jumped to ~**700+ ms**
- Likely mix of: overload queueing, Nginx/proxy concurrency, Redis Lua contention on one hot key, and client-side VU pressure — **not** “two instances broke the limit”

Burst at high offered rate but shorter stages stayed healthier (**p95 ~43 ms**) with 100% controlled 200/429.

### Multi-tenancy

Multi-tenant script hit both Acme and Globex keys; isolation checks **100%**. High `http_req_failed` again reflects per-tenant quotas, not cross-tenant leakage.

### Correctness tests

| Suite | Result (2026-08-19) |
| --- | --- |
| Unit (`npm test`) | **23/23 pass** |
| Integration (`npm run test:integration`) | **10/10 pass** (auth, isolation, concurrent limits, multi-app Redis share, circuit, readiness) |

---

## 6. Prometheus snapshot

Not captured in this session (optional follow-up). Suggested during a re-run:

| Metric | PromQL |
| --- | --- |
| Allowed/s | `sum(rate(gateway_ratelimit_allowed_total[1m]))` |
| Rejected/s | `sum(rate(gateway_ratelimit_rejected_total[1m]))` |
| Redis p95 | `histogram_quantile(0.95, sum(rate(gateway_redis_latency_seconds_bucket[1m])) by (le))` |
| Event-loop lag | `gateway_eventloop_lag_seconds` |

Grafana: http://localhost:3001 — dashboard **Distributed Rate Limiter / API Gateway**.

---

## 7. Environment

| Field | Value |
| --- | --- |
| Date | 2026-08-19 |
| OS | Windows (PowerShell) |
| Stack | Docker Compose (full gateway stack) |
| Seed keys | `.local/seed-secrets.json` |
| k6 | Installed locally (ran successfully) |
| CPU / RAM | Not recorded |

---

## 8. Raw k6 excerpts

### Run 1 — smoke

```
http_reqs: 186 (9.297/s)
http_req_duration: avg=13.31ms med=11.54ms p(95)=23.42ms max=81.23ms
http_req_failed: 0.00%
checks: 100% (status 200|429, RateLimit headers)
thresholds: p(95)<500 ✓, failed rate<0.6 ✓
```

### Run 2 — single-instance (`:3000`, 80/s × 45s)

```
http_reqs: 3601 (79.99/s)
http_req_duration: avg=11.14ms med=6.28ms p(95)=24.21ms max=466.97ms
http_req_failed: 86.97%
checks not 5xx: 99.97% (3600/3601)
```

### Run 3 — multi-instance (`:8080`, 160/s × 45s)

```
http_reqs: 6840 (151.99/s)
http_req_duration: avg=150.68ms med=25.86ms p(95)=637.21ms max=2.8s
http_req_failed: 93.18%
dropped_iterations: 360
checks not 5xx: 100%
```

### Run 4 — burst

```
http_reqs: 4174 (139.12/s)
http_req_duration: avg=17.38ms med=12.43ms p(95)=43.45ms max=249.05ms
http_req_failed: 92.59%
checks controlled (200|429): 100%
```

### Run 5 — multi-tenant

```
http_reqs: 12092 (402.07/s)
iterations: 6046 (201.04/s)
http_req_duration: avg=48.93ms med=45.75ms p(95)=78.4ms max=344.69ms
http_req_failed: 96.44%
checks acme+globex isolated: 100%
```

### Run 6 — single-instance explicit `:3000`

```
http_reqs: 3601 (80.00/s)
med=10.19ms p(95)=29.14ms
http_req_failed: 86.97%
not 5xx: 100%
```

### Run 7 — multi-instance explicit `:8080`

```
http_reqs: 7062 (156.82/s)
med=36.38ms p(95)=638.36ms max=2.65s
http_req_failed: 93.40%
dropped_iterations: 139
WARN: Insufficient VUs, reached 120 active VUs
not 5xx: 100%
```

---

## 9. Links

- [Benchmarks how-to](benchmarks.md)
- [Architecture](architecture.md)
- [Failure modes](failure-modes.md)
- [Scaling](scaling.md)
- [PromQL](promql.md)
- [Interview Q&A](interview-qa.md)

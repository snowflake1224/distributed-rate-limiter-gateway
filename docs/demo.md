# Gateway Lab

The lab at `/demo/` is a thin client over the real gateway. It never fakes a response: every number is read from an HTTP response, a per-instance state endpoint, or a model replayed over the measured send times.

## Page layout

| Panel | What you can do |
| --- | --- |
| Where requests went | Shows, for the selected run, how many requests each layer stopped: Nginx edge, gateway auth/config, Redis limiter, circuit breaker, upstream. |
| 1. Configure your sandbox | Algorithm, capacity/refill or limit/window, dimensions, custom header, fail mode. Upstream latency, timeout, random failure rate, fail-first-N, error status, breaker threshold/recovery/probes. **Apply changes live** bumps the policy version. |
| Guided experiments | Eight experiments, each with editable parameters, a hypothesis, step-by-step progress, and pass/fail checks. |
| 2. Send real traffic | Single request, browser load (up to 6 in flight), or server-side burst (up to 200 requests, 50 in flight, both instances). Method, path, extra headers, JSON body, rotating `x-user-id`. Credentials: your sandbox key, the public demo tenant, no key, or an invalid key. |
| Live system state | PostgreSQL/Redis readiness. For each gateway instance: breaker state and failure count, cached policy version (flagged when stale), and allowed / 429 / upstream error / fast-fail counts. |
| 3. Results and analysis | Summary stats, an expected-vs-observed verdict, four charts, a filterable table of every request, a raw header/body inspector, run comparison, JSON/CSV download, and copy-as curl/PowerShell/k6. |

## How "expected" is computed

- **Token bucket.** The model starts with the tokens implied by the first responses' `RateLimit-Remaining` (the highest value among the first *concurrency* responses, plus one). It then replays refill and spend at each request's actual send time.
- **Sliding window.** The same idea, keeping a rolling list of accepted timestamps.
- **Tolerance.** With concurrency above 1, Redis may see requests in a slightly different order than they were sent, and tokens can refill while requests are in flight. The verdict is "match", "within tolerance" (shown as ±n), or "deviation".
- **Exclusions.** Requests rejected by Nginx `limit_req` (no `X-Gateway-Instance` header), network errors and gateway errors (401/404) are excluded from the comparison, and the reason is listed.
- **Over-admission.** When more than one instance answered, the page shows how many requests separate per-instance counters would have allowed.

## Sandbox API

Every lab endpoint is under `/demo/v1`. Calls about a sandbox need the `x-sandbox-token` returned at creation.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/manifest` | Bounds, TTLs, instance count, public demo keys and seeded routes |
| POST | `/sandboxes` | Create `{ policy, upstream }`. Returns `{ sandbox, apiKey, token }` |
| GET | `/sandboxes/:id` | Sandbox plus per-instance state from every gateway |
| PATCH | `/sandboxes/:id` | `{ policy?, upstream?, restartUpstreamCounter?, resetCircuit? }`. Returns `handledBy` |
| DELETE | `/sandboxes/:id` | Delete the tenant, key, policy, route and upstream |
| POST | `/sandboxes/:id/runs` | Server-side burst. Needs `x-sandbox-api-key`. Only `/sbx/<id>/...` paths are allowed |

Gateway traffic for a sandbox goes to `/sbx/<id>/<anything>` with `x-api-key`.

## Limits and safety

| Limit | Default | Setting |
| --- | --- | --- |
| Sandbox lifetime | 30 min | `DEMO_SANDBOX_TTL_MS` |
| Active sandboxes (global) | 50 | `DEMO_SANDBOX_MAX` |
| Active sandboxes per client IP | 3 | `DEMO_SANDBOX_MAX_PER_IP` |
| Lab control API at Nginx | 5 r/s, burst 30 per IP | `nginx/nginx.conf` |
| Gateway traffic at Nginx | 40 r/s, burst 80 per IP | `nginx/nginx.conf` |
| Server-side run | 200 requests, 50 concurrent, one run per sandbox | `src/demo/schemas.ts` |
| Policy bounds | capacity ≤ 100, refill ≤ 50/s, window 1–60 s | `src/demo/schemas.ts` |
| Upstream bounds | delay ≤ 3 s, timeout 0.2–5 s | `src/demo/schemas.ts` |

- **No user-supplied URLs.** The upstream URL is always the internal lab service, so there is no SSRF.
- **Reserved headers.** The lab sets `x-api-key`, `x-forwarded-for` and `x-request-id` itself. Users cannot override them.
- **Edge exposure.** Nginx returns 404 for `/admin/*` and `/metrics`. Prometheus scrapes the instances directly inside the Compose network.
- **Metrics.** Sandbox tenants share the single metric label `tenant="sandbox"`, so visitors cannot inflate label cardinality.
- **Cleanup.** Expired sandboxes are swept every minute. Breaker and outcome state for idle sandboxes is pruned from memory.

## Things the lab deliberately shows

- **Cache staleness is real.** After a policy edit, the instance that handled the PATCH reloads at once, while the other keeps its cached copy for up to `POLICY_CACHE_TTL_MS`. The *Live policy change* experiment catches this, and `X-RateLimit-Policy-Version` shows which version decided each request.
- **Breakers are per instance.** With two instances and threshold 3, it takes about 6 failures before both breakers are open. This is a design choice (no shared breaker state), not a bug.
- **Browser load is not a race.** Browsers open only about 6 connections per host. For the concurrency proof, use the server-side runner.

## Recording a demo GIF

Recommended script, about 40 seconds:

1. Run *Burst, then throttle* and scroll to the results.
2. Run *Two instances, one limit* and show the "Matches the model exactly" box and the instance split.
3. Run *Circuit breaker lifecycle* and show the live state table flipping open, then closed.

Save it as `docs/images/lab.gif` and reference it at the top of the README.

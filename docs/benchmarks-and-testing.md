# Benchmarks, Tests & Verification

## Test Suite Breakdown (**77 Automated Tests**)

| Suite | Location | Scope | Count |
| --- | --- | --- | ---: |
| **Backend Unit** | `tests/unit/` (9 files) | Auth key formatting/comparison, `TtlLruCache`, `CircuitBreaker` transitions, Redis `fail_closed` (`503`) vs `fail_open` fallback, lab spec validation, dimension keys, route matching, token bucket & sliding window math | 39 |
| **Backend Integration** | `tests/integration/` (3 files) | Live Postgres + Redis gateway enforcement, tenant isolation, 50-way concurrent Lua races across 2 gateway instances, circuit breaker opening on 5xx, sandbox provisioning & expiry | 21 |
| **Frontend Unit** | `frontend/src/lib/*.test.ts` (2 files) | Gateway Lab experiment specs, response classification, statistical summaries | 17 |
| **Total** | | | **77** |

*(Note: `tests/integration/gateway.test.ts` checks `/health/ready` readiness in its Redis readiness test; explicit `fail_closed` (`503`) vs `fail_open` fallback behavior on Redis command failure is verified directly in `tests/unit/fail-mode.test.ts`.)*

### Running Tests

```bash
# Backend unit tests
npm install
npm test

# Backend integration tests (requires running Postgres + Redis)
docker compose up -d postgres redis
DATABASE_URL="postgres://gateway:gateway@localhost:5432/gateway" \
REDIS_URL="redis://localhost:6379" \
npm run migrate && npm run test:integration

# Frontend unit tests & build
cd frontend && npm install && npm test && npm run build
```

*(Note: No `.github/workflows/` CI workflow is committed in this repository; checks are run locally.)*

## k6 Load-Test Harness & Baseline Results

Scripts under `load-tests/k6/`:
- `single-instance.js`: targets `:3000` directly
- `multi-instance.js`: targets Nginx `:8080` across `gateway-1` + `gateway-2`
- `lib.js`: shared `X-API-Key` and latency/status checks

### Laptop Observation (`2026-08-19`)

- **Target:** Seeded `/api/orders` policy (`burstCapacity = 20`, `refillRatePerSec = 10`).
- **Measured:** **~80 req/s** handled on 1 instance (`:3000`) vs **~152–157 req/s** across 2 instances behind Nginx (`:8080`).
- **Key Observation:** Adding the second gateway instance nearly doubled aggregate HTTP handling capacity while the **allowed** rate stayed constant (most overflow responses were `429`), confirming both instances share a single atomic Redis bucket. *(Note: this is a single-host laptop Docker Compose run; raw k6 JSON logs are not committed.)*

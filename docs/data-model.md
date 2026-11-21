# Data Model (PostgreSQL)

Defined across `src/db/migrations/001_initial.sql` and `002_demo_sandboxes.sql`.

| Table | Role | Constraints & Indexes |
| --- | --- | --- |
| `tenants` | Tenant organizations (`active` / `suspended`) + optional `sandbox_expires_at` | `slug UNIQUE` |
| `api_keys` | Tenant API keys (`key_prefix`, SHA-256 `key_hash`, `status`, `expires_at`, `revoked_at`) | `key_prefix UNIQUE`, `key_hash UNIQUE`, `api_keys_prefix_status_idx` |
| `policies` | Rate-limit policies (`algorithm`, `limit_count`, `window_ms`, `refill_rate_per_sec`, `burst_capacity`, `dimensions[]`, `fail_mode`, `version`) | `UNIQUE (tenant_id, name)` |
| `upstreams` | Upstream target URL + circuit breaker settings (`timeout_ms`, `cb_failure_threshold`, `cb_recovery_ms`, `cb_half_open_max_probes`) | `UNIQUE (tenant_id, name)` |
| `routes` | Per-tenant route matching (`path_pattern`, `method`, `policy_id`, `upstream_id`, `strip_prefix`) | `UNIQUE (tenant_id, name)`, `routes_tenant_lookup_idx` |
| `audit_logs` | Admin and sandbox mutation log (`actor`, `action`, `resource_type`, JSONB `payload`) | `audit_logs_tenant_created_idx` |
| `demo_sandboxes` | Ephemeral 30-min Gateway Lab sandboxes (`id`, `token_hash`, `client_ip`, `upstream_config`, `upstream_revision`, `expires_at`) | FK cascade to `tenants`, `policies`, `upstreams`, `routes`, `api_keys` |
| `usage_snapshots` | Reserved schema table (`allowed_count`, `rejected_count` per window) — currently unused at runtime | `UNIQUE (tenant_id, route_id, window_start)` |

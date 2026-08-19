CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL UNIQUE,
  key_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX api_keys_tenant_id_idx ON api_keys(tenant_id);
CREATE INDEX api_keys_prefix_status_idx ON api_keys(key_prefix, status);

CREATE TABLE policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  algorithm TEXT NOT NULL CHECK (algorithm IN ('token_bucket', 'sliding_window')),
  limit_count INTEGER NOT NULL CHECK (limit_count > 0),
  window_ms INTEGER NOT NULL CHECK (window_ms > 0),
  refill_rate_per_sec DOUBLE PRECISION NOT NULL CHECK (refill_rate_per_sec > 0),
  burst_capacity INTEGER NOT NULL CHECK (burst_capacity > 0),
  dimensions TEXT[] NOT NULL,
  custom_header TEXT,
  fail_mode TEXT NOT NULL DEFAULT 'fail_closed' CHECK (fail_mode IN ('fail_closed', 'fail_open')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE INDEX policies_tenant_id_idx ON policies(tenant_id);

CREATE TABLE upstreams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  timeout_ms INTEGER NOT NULL DEFAULT 3000 CHECK (timeout_ms > 0),
  cb_failure_threshold INTEGER NOT NULL DEFAULT 5 CHECK (cb_failure_threshold > 0),
  cb_recovery_ms INTEGER NOT NULL DEFAULT 10000 CHECK (cb_recovery_ms > 0),
  cb_half_open_max_probes INTEGER NOT NULL DEFAULT 1 CHECK (cb_half_open_max_probes > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE INDEX upstreams_tenant_id_idx ON upstreams(tenant_id);

CREATE TABLE routes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  path_pattern TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT '*' CHECK (method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', '*')),
  policy_id UUID NOT NULL REFERENCES policies(id),
  upstream_id UUID NOT NULL REFERENCES upstreams(id),
  timeout_ms INTEGER CHECK (timeout_ms IS NULL OR timeout_ms > 0),
  strip_prefix TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE INDEX routes_tenant_lookup_idx ON routes(tenant_id, status, method);

CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_logs_tenant_created_idx ON audit_logs(tenant_id, created_at DESC);

CREATE TABLE usage_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  route_id UUID REFERENCES routes(id) ON DELETE SET NULL,
  window_start TIMESTAMPTZ NOT NULL,
  allowed_count BIGINT NOT NULL DEFAULT 0,
  rejected_count BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, route_id, window_start)
);

CREATE INDEX usage_snapshots_tenant_window_idx ON usage_snapshots(tenant_id, window_start DESC);

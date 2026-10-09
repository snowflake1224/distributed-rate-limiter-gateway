ALTER TABLE tenants ADD COLUMN sandbox_expires_at TIMESTAMPTZ;

CREATE INDEX tenants_sandbox_expires_idx ON tenants(sandbox_expires_at)
  WHERE sandbox_expires_at IS NOT NULL;

CREATE TABLE demo_sandboxes (
  id TEXT PRIMARY KEY,
  tenant_id UUID NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  client_ip TEXT NOT NULL,
  api_key_id UUID NOT NULL,
  policy_id UUID NOT NULL,
  upstream_id UUID NOT NULL,
  route_id UUID NOT NULL,
  upstream_config JSONB NOT NULL,
  upstream_revision INTEGER NOT NULL DEFAULT 1,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX demo_sandboxes_client_ip_idx ON demo_sandboxes(client_ip, expires_at);
CREATE INDEX demo_sandboxes_expires_idx ON demo_sandboxes(expires_at);

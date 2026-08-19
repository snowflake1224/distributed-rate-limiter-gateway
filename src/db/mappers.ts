import type {
  ApiKeyRecord,
  AuditLog,
  Policy,
  Route,
  Tenant,
  Upstream
} from "../types.js";

export function mapTenant(row: Record<string, unknown>): Tenant {
  return {
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    status: row.status as Tenant["status"],
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at))
  };
}

export function mapApiKey(row: Record<string, unknown>): ApiKeyRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    name: String(row.name),
    keyPrefix: String(row.key_prefix),
    keyHash: String(row.key_hash),
    status: row.status as ApiKeyRecord["status"],
    expiresAt: row.expires_at ? new Date(String(row.expires_at)) : null,
    lastUsedAt: row.last_used_at ? new Date(String(row.last_used_at)) : null,
    createdAt: new Date(String(row.created_at)),
    revokedAt: row.revoked_at ? new Date(String(row.revoked_at)) : null
  };
}

export function mapPolicy(row: Record<string, unknown>): Policy {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    name: String(row.name),
    algorithm: row.algorithm as Policy["algorithm"],
    limitCount: Number(row.limit_count),
    windowMs: Number(row.window_ms),
    refillRatePerSec: Number(row.refill_rate_per_sec),
    burstCapacity: Number(row.burst_capacity),
    dimensions: row.dimensions as Policy["dimensions"],
    customHeader: row.custom_header ? String(row.custom_header) : null,
    failMode: row.fail_mode as Policy["failMode"],
    status: row.status as Policy["status"],
    version: Number(row.version),
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at))
  };
}

export function mapUpstream(row: Record<string, unknown>): Upstream {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    name: String(row.name),
    baseUrl: String(row.base_url),
    timeoutMs: Number(row.timeout_ms),
    cbFailureThreshold: Number(row.cb_failure_threshold),
    cbRecoveryMs: Number(row.cb_recovery_ms),
    cbHalfOpenMaxProbes: Number(row.cb_half_open_max_probes),
    status: row.status as Upstream["status"],
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at))
  };
}

export function mapRoute(row: Record<string, unknown>): Route {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    name: String(row.name),
    pathPattern: String(row.path_pattern),
    method: row.method as Route["method"],
    policyId: String(row.policy_id),
    upstreamId: String(row.upstream_id),
    timeoutMs: row.timeout_ms === null || row.timeout_ms === undefined ? null : Number(row.timeout_ms),
    stripPrefix: row.strip_prefix ? String(row.strip_prefix) : null,
    status: row.status as Route["status"],
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at))
  };
}

export function mapAudit(row: Record<string, unknown>): AuditLog {
  return {
    id: String(row.id),
    tenantId: row.tenant_id ? String(row.tenant_id) : null,
    actor: String(row.actor),
    action: String(row.action),
    resourceType: String(row.resource_type),
    resourceId: row.resource_id ? String(row.resource_id) : null,
    payload: (row.payload as Record<string, unknown>) ?? {},
    createdAt: new Date(String(row.created_at))
  };
}

export function publicApiKey(record: ApiKeyRecord): Omit<ApiKeyRecord, "keyHash"> {
  const { keyHash: _omit, ...rest } = record;
  return rest;
}

export type TenantStatus = "active" | "suspended";
export type ApiKeyStatus = "active" | "revoked";
export type EntityStatus = "active" | "disabled";
export type Algorithm = "token_bucket" | "sliding_window";
export type FailMode = "fail_closed" | "fail_open";
export type DimensionName = "tenant" | "api_key" | "route" | "ip" | "custom";
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "*";
export type CircuitState = "closed" | "open" | "half_open";

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  status: TenantStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApiKeyRecord {
  id: string;
  tenantId: string;
  name: string;
  keyPrefix: string;
  keyHash: string;
  status: ApiKeyStatus;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface AuthenticatedKey {
  apiKeyId: string;
  tenantId: string;
  tenantSlug: string;
  tenantStatus: TenantStatus;
  name: string;
}

export interface Policy {
  id: string;
  tenantId: string;
  name: string;
  algorithm: Algorithm;
  limitCount: number;
  windowMs: number;
  refillRatePerSec: number;
  burstCapacity: number;
  dimensions: DimensionName[];
  customHeader: string | null;
  failMode: FailMode;
  status: EntityStatus;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface Upstream {
  id: string;
  tenantId: string;
  name: string;
  baseUrl: string;
  timeoutMs: number;
  cbFailureThreshold: number;
  cbRecoveryMs: number;
  cbHalfOpenMaxProbes: number;
  status: EntityStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface Route {
  id: string;
  tenantId: string;
  name: string;
  pathPattern: string;
  method: HttpMethod;
  policyId: string;
  upstreamId: string;
  timeoutMs: number | null;
  stripPrefix: string | null;
  status: EntityStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface ResolvedRoute {
  route: Route;
  policy: Policy;
  upstream: Upstream;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterMs: number;
  resetEpochSeconds: number;
  algorithm: Algorithm;
  key: string;
}

export interface AuditLog {
  id: string;
  tenantId: string | null;
  actor: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  payload: Record<string, unknown>;
  createdAt: Date;
}

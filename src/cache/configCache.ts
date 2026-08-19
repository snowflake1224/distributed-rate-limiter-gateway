import { env } from "../config/env.js";
import { findActiveKeyByPrefix } from "../db/repositories/apiKeys.js";
import { getPolicyById } from "../db/repositories/policies.js";
import { listActiveRoutes } from "../db/repositories/routes.js";
import { getTenantById } from "../db/repositories/tenants.js";
import { getUpstreamById } from "../db/repositories/upstreams.js";
import {
  apiKeyCacheHitsTotal,
  apiKeyCacheMissesTotal,
  policyCacheHitsTotal,
  policyCacheMissesTotal
} from "../metrics/registry.js";
import { matchRoute } from "../policy/routeMatch.js";
import type { AuthenticatedKey, ResolvedRoute } from "../types.js";
import { extractPrefix, hashApiKey, hashesEqual } from "../auth/apiKeys.js";
import { TtlLruCache } from "./ttlLru.js";

const policyCache = new TtlLruCache<ResolvedRoute | null>({
  max: env.policyCacheMax,
  ttlMs: env.policyCacheTtlMs
});

const apiKeyCache = new TtlLruCache<AuthenticatedKey | null>({
  max: env.apiKeyCacheMax,
  ttlMs: env.apiKeyCacheTtlMs
});

function policyCacheKey(tenantId: string, method: string, path: string): string {
  return `route:${tenantId}:${method.toUpperCase()}:${path}`;
}

export async function resolveAuthenticatedKey(plaintext: string): Promise<AuthenticatedKey | null> {
  const cached = apiKeyCache.get(plaintext);
  if (cached !== undefined) {
    apiKeyCacheHitsTotal.inc();
    return cached;
  }
  apiKeyCacheMissesTotal.inc();

  const prefix = extractPrefix(plaintext);
  if (!prefix) {
    apiKeyCache.set(plaintext, null);
    return null;
  }

  const record = await findActiveKeyByPrefix(prefix);
  if (!record || !hashesEqual(record.keyHash, hashApiKey(plaintext))) {
    apiKeyCache.set(plaintext, null);
    return null;
  }
  if (record.expiresAt && record.expiresAt.getTime() <= Date.now()) {
    apiKeyCache.set(plaintext, null);
    return null;
  }

  const tenant = await getTenantById(record.tenantId);
  const auth: AuthenticatedKey = {
    apiKeyId: record.id,
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    tenantStatus: tenant.status,
    name: record.name
  };
  apiKeyCache.set(plaintext, auth);
  return auth;
}

export async function resolveRouteConfig(
  tenantId: string,
  method: string,
  path: string
): Promise<ResolvedRoute | null> {
  const key = policyCacheKey(tenantId, method, path);
  const cached = policyCache.get(key);
  if (cached !== undefined) {
    policyCacheHitsTotal.inc();
    return cached;
  }
  policyCacheMissesTotal.inc();

  const routes = await listActiveRoutes(tenantId);
  const route = matchRoute(routes, method, path);
  if (!route) {
    policyCache.set(key, null);
    return null;
  }

  const [policy, upstream] = await Promise.all([
    getPolicyById(route.policyId),
    getUpstreamById(route.upstreamId)
  ]);

  if (policy.tenantId !== tenantId || upstream.tenantId !== tenantId) {
    policyCache.set(key, null);
    return null;
  }
  if (policy.status !== "active" || upstream.status !== "active") {
    policyCache.set(key, null);
    return null;
  }

  const resolved: ResolvedRoute = { route, policy, upstream };
  policyCache.set(key, resolved);
  return resolved;
}

export function invalidateTenantConfig(tenantId: string): void {
  policyCache.deleteByPrefix(`route:${tenantId}:`);
}

export function invalidateAllApiKeys(): void {
  apiKeyCache.clear();
}

export function invalidateApiKeyLookups(): void {
  apiKeyCache.clear();
}

export function cacheStats(): { policySize: number; apiKeySize: number } {
  return {
    policySize: policyCache.size(),
    apiKeySize: apiKeyCache.size()
  };
}

export const caches = { policyCache, apiKeyCache };

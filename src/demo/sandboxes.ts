import { randomBytes } from "node:crypto";
import { generateApiKey, hashApiKey, hashesEqual } from "../auth/apiKeys.js";
import { invalidateAllApiKeys, invalidateTenantConfig } from "../cache/configCache.js";
import { env } from "../config/env.js";
import { writeAudit } from "../db/repositories/audit.js";
import { getPolicyById, updatePolicy } from "../db/repositories/policies.js";
import { updateUpstream } from "../db/repositories/upstreams.js";
import { mapPolicy } from "../db/mappers.js";
import { query, withTransaction } from "../db/pool.js";
import { HttpError, badRequest, notFound, unauthorized } from "../errors.js";
import type { Policy } from "../types.js";
import { labBasePath } from "./labSpec.js";
import {
  policyConfigSchema,
  upstreamConfigSchema,
  type PolicyConfig,
  type SandboxCreateInput,
  type SandboxPatchInput,
  type UpstreamConfig
} from "./schemas.js";

const CAPACITY_LOCK_ID = 727_101;

export interface SandboxRecord {
  id: string;
  tenantId: string;
  apiKeyId: string;
  policyId: string;
  upstreamId: string;
  routeId: string;
  upstreamConfig: UpstreamConfig;
  upstreamRevision: number;
  expiresAt: Date;
  createdAt: Date;
}

export interface SandboxView {
  id: string;
  tenantSlug: string;
  routePrefix: string;
  routePattern: string;
  expiresAt: string;
  createdAt: string;
  policy: PolicyConfig & { version: number; redisKeyFormat: string };
  upstream: UpstreamConfig & { revision: number };
}

export function sandboxSlug(id: string): string {
  return `sbx-${id}`;
}

export function isSandboxSlug(slug: string): boolean {
  return slug.startsWith("sbx-");
}

export function routePrefixFor(id: string): string {
  return `/sbx/${id}`;
}

function labBaseUrl(id: string, revision: number, config: UpstreamConfig): string {
  return (
    env.demoLabUpstreamUrl +
    labBasePath({
      sandboxId: id,
      revision,
      delayMs: config.delayMs,
      failRatePct: config.failRatePct,
      failFirstN: config.failFirstN,
      errorStatus: config.errorStatus
    })
  );
}

function mapSandbox(row: Record<string, unknown>): SandboxRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    apiKeyId: String(row.api_key_id),
    policyId: String(row.policy_id),
    upstreamId: String(row.upstream_id),
    routeId: String(row.route_id),
    upstreamConfig: upstreamConfigSchema.parse(row.upstream_config),
    upstreamRevision: Number(row.upstream_revision),
    expiresAt: new Date(String(row.expires_at)),
    createdAt: new Date(String(row.created_at))
  };
}

function policyToConfig(policy: Policy): PolicyConfig {
  return {
    algorithm: policy.algorithm,
    burstCapacity: policy.burstCapacity,
    refillRatePerSec: policy.refillRatePerSec,
    limitCount: policy.limitCount,
    windowMs: policy.windowMs,
    dimensions: policy.dimensions,
    customHeader: policy.customHeader ?? "x-user-id",
    failMode: policy.failMode
  };
}

export function toView(record: SandboxRecord, policy: Policy): SandboxView {
  const prefix = routePrefixFor(record.id);
  return {
    id: record.id,
    tenantSlug: sandboxSlug(record.id),
    routePrefix: prefix,
    routePattern: `${prefix}/*`,
    expiresAt: record.expiresAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
    policy: {
      ...policyToConfig(policy),
      version: policy.version,
      redisKeyFormat: `rl:${policy.algorithm}:${record.tenantId}:${policy.id}:v${policy.version}:<sha256(${policy.dimensions.join("|")})>`
    },
    upstream: { ...record.upstreamConfig, revision: record.upstreamRevision }
  };
}

export async function createSandbox(
  input: SandboxCreateInput,
  clientIp: string
): Promise<{ view: SandboxView; apiKey: string; token: string }> {
  const id = randomBytes(5).toString("hex");
  const token = randomBytes(24).toString("base64url");
  const key = generateApiKey();
  const expiresAt = new Date(Date.now() + env.demoSandboxTtlMs);
  const { policy: policyConfig, upstream: upstreamConfig } = input;

  const result = await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [CAPACITY_LOCK_ID]);
    const counts = await client.query<{ total: string; mine: string }>(
      `SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE client_ip = $1)::text AS mine
       FROM demo_sandboxes WHERE expires_at > now()`,
      [clientIp]
    );
    const total = Number(counts.rows[0]?.total ?? 0);
    const mine = Number(counts.rows[0]?.mine ?? 0);
    if (total >= env.demoSandboxMax) {
      throw new HttpError(429, "sandbox_capacity", "The lab is at capacity. Try again in a few minutes.", {
        max: env.demoSandboxMax
      }, 60);
    }
    if (mine >= env.demoSandboxMaxPerIp) {
      throw new HttpError(429, "sandbox_capacity", "Too many active sandboxes from this address. Delete one first.", {
        maxPerIp: env.demoSandboxMaxPerIp
      }, 60);
    }

    const tenant = await client.query(
      `INSERT INTO tenants (slug, name, sandbox_expires_at) VALUES ($1, $2, $3) RETURNING id`,
      [sandboxSlug(id), `Lab sandbox ${id}`, expiresAt]
    );
    const tenantId = String(tenant.rows[0].id);

    const apiKey = await client.query(
      `INSERT INTO api_keys (tenant_id, name, key_prefix, key_hash, expires_at)
       VALUES ($1, 'lab-sandbox', $2, $3, $4) RETURNING id`,
      [tenantId, key.prefix, key.hash, expiresAt]
    );

    const policy = await client.query(
      `INSERT INTO policies (
        tenant_id, name, algorithm, limit_count, window_ms, refill_rate_per_sec,
        burst_capacity, dimensions, custom_header, fail_mode
      ) VALUES ($1, 'lab-policy', $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        tenantId,
        policyConfig.algorithm,
        policyConfig.limitCount,
        policyConfig.windowMs,
        policyConfig.refillRatePerSec,
        policyConfig.burstCapacity,
        policyConfig.dimensions,
        policyConfig.customHeader,
        policyConfig.failMode
      ]
    );

    const upstream = await client.query(
      `INSERT INTO upstreams (
        tenant_id, name, base_url, timeout_ms,
        cb_failure_threshold, cb_recovery_ms, cb_half_open_max_probes
      ) VALUES ($1, 'lab', $2, $3, $4, $5, $6) RETURNING id`,
      [
        tenantId,
        labBaseUrl(id, 1, upstreamConfig),
        upstreamConfig.timeoutMs,
        upstreamConfig.cbFailureThreshold,
        upstreamConfig.cbRecoveryMs,
        upstreamConfig.cbHalfOpenMaxProbes
      ]
    );

    const prefix = routePrefixFor(id);
    const route = await client.query(
      `INSERT INTO routes (tenant_id, name, path_pattern, method, policy_id, upstream_id, strip_prefix)
       VALUES ($1, 'lab-route', $2, '*', $3, $4, $5) RETURNING id`,
      [tenantId, `${prefix}/*`, policy.rows[0].id, upstream.rows[0].id, prefix]
    );

    const sandbox = await client.query(
      `INSERT INTO demo_sandboxes (
        id, tenant_id, token_hash, client_ip, api_key_id, policy_id, upstream_id, route_id,
        upstream_config, upstream_revision, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10) RETURNING *`,
      [
        id,
        tenantId,
        hashApiKey(token),
        clientIp,
        apiKey.rows[0].id,
        policy.rows[0].id,
        upstream.rows[0].id,
        route.rows[0].id,
        JSON.stringify(upstreamConfig),
        expiresAt
      ]
    );

    return { record: mapSandbox(sandbox.rows[0]), policy: mapPolicy(policy.rows[0]) };
  });

  await writeAudit({
    tenantId: result.record.tenantId,
    actor: "demo-sandbox",
    action: "sandbox.create",
    resourceType: "sandbox",
    resourceId: id,
    payload: { policy: policyConfig, upstream: upstreamConfig }
  });

  return { view: toView(result.record, result.policy), apiKey: key.plaintext, token };
}

export async function loadSandbox(id: string, token: string): Promise<SandboxRecord> {
  if (!/^[a-f0-9]{10}$/.test(id)) {
    throw notFound("Sandbox not found");
  }
  const result = await query(
    `SELECT * FROM demo_sandboxes WHERE id = $1 AND expires_at > now()`,
    [id],
    "demo_sandboxes.get"
  );
  const row = result.rows[0];
  if (!row) {
    throw notFound("Sandbox not found or expired");
  }
  if (!token || !hashesEqual(String(row.token_hash), hashApiKey(token))) {
    throw unauthorized("Invalid sandbox token");
  }
  return mapSandbox(row);
}

export async function describeSandbox(record: SandboxRecord): Promise<SandboxView> {
  return toView(record, await getPolicyById(record.policyId));
}

export async function patchSandbox(record: SandboxRecord, input: SandboxPatchInput): Promise<SandboxView> {
  let policy = await getPolicyById(record.policyId);
  if (input.policy) {
    const merged = policyConfigSchema.safeParse({ ...policyToConfig(policy), ...input.policy });
    if (!merged.success) {
      throw badRequest("Validation failed", { issues: merged.error.issues });
    }
    policy = await updatePolicy(record.tenantId, record.policyId, merged.data);
  }

  let upstreamConfig = record.upstreamConfig;
  let revision = record.upstreamRevision;
  if (input.upstream || input.restartUpstreamCounter) {
    const merged = upstreamConfigSchema.safeParse({ ...record.upstreamConfig, ...(input.upstream ?? {}) });
    if (!merged.success) {
      throw badRequest("Validation failed", { issues: merged.error.issues });
    }
    upstreamConfig = merged.data;
    revision += 1;
    await updateUpstream(record.tenantId, record.upstreamId, {
      baseUrl: labBaseUrl(record.id, revision, upstreamConfig),
      timeoutMs: upstreamConfig.timeoutMs,
      cbFailureThreshold: upstreamConfig.cbFailureThreshold,
      cbRecoveryMs: upstreamConfig.cbRecoveryMs,
      cbHalfOpenMaxProbes: upstreamConfig.cbHalfOpenMaxProbes
    });
    await query(
      `UPDATE demo_sandboxes SET upstream_config = $2, upstream_revision = $3 WHERE id = $1`,
      [record.id, JSON.stringify(upstreamConfig), revision],
      "demo_sandboxes.update"
    );
  }

  invalidateTenantConfig(record.tenantId);
  await writeAudit({
    tenantId: record.tenantId,
    actor: "demo-sandbox",
    action: "sandbox.update",
    resourceType: "sandbox",
    resourceId: record.id,
    payload: { policy: input.policy ?? null, upstream: input.upstream ?? null }
  });

  return toView({ ...record, upstreamConfig, upstreamRevision: revision }, policy);
}

export async function deleteSandbox(record: SandboxRecord): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(`DELETE FROM audit_logs WHERE tenant_id = $1`, [record.tenantId]);
    await client.query(`DELETE FROM tenants WHERE id = $1`, [record.tenantId]);
  });
  invalidateTenantConfig(record.tenantId);
  invalidateAllApiKeys();
}

export async function sweepExpiredSandboxes(): Promise<number> {
  return withTransaction(async (client) => {
    await client.query(
      `DELETE FROM audit_logs WHERE tenant_id IN (
         SELECT id FROM tenants WHERE sandbox_expires_at IS NOT NULL AND sandbox_expires_at <= now()
       )`
    );
    const removed = await client.query(
      `DELETE FROM tenants WHERE sandbox_expires_at IS NOT NULL AND sandbox_expires_at <= now()`
    );
    return removed.rowCount ?? 0;
  });
}

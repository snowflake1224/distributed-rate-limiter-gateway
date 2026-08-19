import { notFound } from "../../errors.js";
import type { DimensionName, FailMode, Policy } from "../../types.js";
import { mapPolicy } from "../mappers.js";
import { query } from "../pool.js";

export async function createPolicy(input: {
  tenantId: string;
  name: string;
  algorithm: Policy["algorithm"];
  limitCount: number;
  windowMs: number;
  refillRatePerSec: number;
  burstCapacity: number;
  dimensions: DimensionName[];
  customHeader?: string | null;
  failMode: FailMode;
}): Promise<Policy> {
  const result = await query(
    `INSERT INTO policies (
      tenant_id, name, algorithm, limit_count, window_ms, refill_rate_per_sec,
      burst_capacity, dimensions, custom_header, fail_mode
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    RETURNING *`,
    [
      input.tenantId,
      input.name,
      input.algorithm,
      input.limitCount,
      input.windowMs,
      input.refillRatePerSec,
      input.burstCapacity,
      input.dimensions,
      input.customHeader ?? null,
      input.failMode
    ],
    "policies.insert"
  );
  return mapPolicy(result.rows[0]);
}

export async function listPolicies(tenantId: string): Promise<Policy[]> {
  const result = await query(
    `SELECT * FROM policies WHERE tenant_id = $1 ORDER BY created_at ASC`,
    [tenantId],
    "policies.list"
  );
  return result.rows.map((row) => mapPolicy(row));
}

export async function getPolicy(tenantId: string, id: string): Promise<Policy> {
  const result = await query(
    `SELECT * FROM policies WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
    "policies.get"
  );
  if (!result.rows[0]) {
    throw notFound("Policy not found");
  }
  return mapPolicy(result.rows[0]);
}

export async function getPolicyById(id: string): Promise<Policy> {
  const result = await query(`SELECT * FROM policies WHERE id = $1`, [id], "policies.get_by_id");
  if (!result.rows[0]) {
    throw notFound("Policy not found");
  }
  return mapPolicy(result.rows[0]);
}

export async function updatePolicy(
  tenantId: string,
  id: string,
  input: Partial<{
    name: string;
    algorithm: Policy["algorithm"];
    limitCount: number;
    windowMs: number;
    refillRatePerSec: number;
    burstCapacity: number;
    dimensions: DimensionName[];
    customHeader: string | null;
    failMode: FailMode;
    status: Policy["status"];
  }>
): Promise<Policy> {
  const result = await query(
    `UPDATE policies SET
      name = COALESCE($3, name),
      algorithm = COALESCE($4, algorithm),
      limit_count = COALESCE($5, limit_count),
      window_ms = COALESCE($6, window_ms),
      refill_rate_per_sec = COALESCE($7, refill_rate_per_sec),
      burst_capacity = COALESCE($8, burst_capacity),
      dimensions = COALESCE($9, dimensions),
      custom_header = CASE WHEN $10 = true THEN $11 ELSE custom_header END,
      fail_mode = COALESCE($12, fail_mode),
      status = COALESCE($13, status),
      version = version + 1,
      updated_at = now()
     WHERE tenant_id = $1 AND id = $2
     RETURNING *`,
    [
      tenantId,
      id,
      input.name ?? null,
      input.algorithm ?? null,
      input.limitCount ?? null,
      input.windowMs ?? null,
      input.refillRatePerSec ?? null,
      input.burstCapacity ?? null,
      input.dimensions ?? null,
      input.customHeader !== undefined,
      input.customHeader ?? null,
      input.failMode ?? null,
      input.status ?? null
    ],
    "policies.update"
  );
  if (!result.rows[0]) {
    throw notFound("Policy not found");
  }
  return mapPolicy(result.rows[0]);
}

export async function countActivePolicies(): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM policies WHERE status = 'active'`,
    [],
    "policies.count_active"
  );
  return Number(result.rows[0]?.count ?? 0);
}

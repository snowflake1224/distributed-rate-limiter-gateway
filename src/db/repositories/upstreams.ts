import { notFound } from "../../errors.js";
import type { Upstream } from "../../types.js";
import { mapUpstream } from "../mappers.js";
import { query } from "../pool.js";

export async function createUpstream(input: {
  tenantId: string;
  name: string;
  baseUrl: string;
  timeoutMs: number;
  cbFailureThreshold: number;
  cbRecoveryMs: number;
  cbHalfOpenMaxProbes: number;
}): Promise<Upstream> {
  const result = await query(
    `INSERT INTO upstreams (
      tenant_id, name, base_url, timeout_ms,
      cb_failure_threshold, cb_recovery_ms, cb_half_open_max_probes
    ) VALUES ($1,$2,$3,$4,$5,$6,$7)
    RETURNING *`,
    [
      input.tenantId,
      input.name,
      input.baseUrl,
      input.timeoutMs,
      input.cbFailureThreshold,
      input.cbRecoveryMs,
      input.cbHalfOpenMaxProbes
    ],
    "upstreams.insert"
  );
  return mapUpstream(result.rows[0]);
}

export async function listUpstreams(tenantId: string): Promise<Upstream[]> {
  const result = await query(
    `SELECT * FROM upstreams WHERE tenant_id = $1 ORDER BY created_at ASC`,
    [tenantId],
    "upstreams.list"
  );
  return result.rows.map((row) => mapUpstream(row));
}

export async function getUpstream(tenantId: string, id: string): Promise<Upstream> {
  const result = await query(
    `SELECT * FROM upstreams WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
    "upstreams.get"
  );
  if (!result.rows[0]) {
    throw notFound("Upstream not found");
  }
  return mapUpstream(result.rows[0]);
}

export async function getUpstreamById(id: string): Promise<Upstream> {
  const result = await query(`SELECT * FROM upstreams WHERE id = $1`, [id], "upstreams.get_by_id");
  if (!result.rows[0]) {
    throw notFound("Upstream not found");
  }
  return mapUpstream(result.rows[0]);
}

export async function updateUpstream(
  tenantId: string,
  id: string,
  input: Partial<{
    name: string;
    baseUrl: string;
    timeoutMs: number;
    cbFailureThreshold: number;
    cbRecoveryMs: number;
    cbHalfOpenMaxProbes: number;
    status: Upstream["status"];
  }>
): Promise<Upstream> {
  const result = await query(
    `UPDATE upstreams SET
      name = COALESCE($3, name),
      base_url = COALESCE($4, base_url),
      timeout_ms = COALESCE($5, timeout_ms),
      cb_failure_threshold = COALESCE($6, cb_failure_threshold),
      cb_recovery_ms = COALESCE($7, cb_recovery_ms),
      cb_half_open_max_probes = COALESCE($8, cb_half_open_max_probes),
      status = COALESCE($9, status),
      updated_at = now()
     WHERE tenant_id = $1 AND id = $2
     RETURNING *`,
    [
      tenantId,
      id,
      input.name ?? null,
      input.baseUrl ?? null,
      input.timeoutMs ?? null,
      input.cbFailureThreshold ?? null,
      input.cbRecoveryMs ?? null,
      input.cbHalfOpenMaxProbes ?? null,
      input.status ?? null
    ],
    "upstreams.update"
  );
  if (!result.rows[0]) {
    throw notFound("Upstream not found");
  }
  return mapUpstream(result.rows[0]);
}

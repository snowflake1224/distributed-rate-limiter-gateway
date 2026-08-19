import { notFound } from "../../errors.js";
import type { Route } from "../../types.js";
import { mapRoute } from "../mappers.js";
import { query } from "../pool.js";

export async function createRoute(input: {
  tenantId: string;
  name: string;
  pathPattern: string;
  method: Route["method"];
  policyId: string;
  upstreamId: string;
  timeoutMs?: number | null;
  stripPrefix?: string | null;
}): Promise<Route> {
  const result = await query(
    `INSERT INTO routes (
      tenant_id, name, path_pattern, method, policy_id, upstream_id, timeout_ms, strip_prefix
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    RETURNING *`,
    [
      input.tenantId,
      input.name,
      input.pathPattern,
      input.method,
      input.policyId,
      input.upstreamId,
      input.timeoutMs ?? null,
      input.stripPrefix ?? null
    ],
    "routes.insert"
  );
  return mapRoute(result.rows[0]);
}

export async function listRoutes(tenantId: string): Promise<Route[]> {
  const result = await query(
    `SELECT * FROM routes WHERE tenant_id = $1 ORDER BY created_at ASC`,
    [tenantId],
    "routes.list"
  );
  return result.rows.map((row) => mapRoute(row));
}

export async function listActiveRoutes(tenantId: string): Promise<Route[]> {
  const result = await query(
    `SELECT * FROM routes WHERE tenant_id = $1 AND status = 'active'`,
    [tenantId],
    "routes.list_active"
  );
  return result.rows.map((row) => mapRoute(row));
}

export async function getRoute(tenantId: string, id: string): Promise<Route> {
  const result = await query(
    `SELECT * FROM routes WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
    "routes.get"
  );
  if (!result.rows[0]) {
    throw notFound("Route not found");
  }
  return mapRoute(result.rows[0]);
}

export async function updateRoute(
  tenantId: string,
  id: string,
  input: Partial<{
    name: string;
    pathPattern: string;
    method: Route["method"];
    policyId: string;
    upstreamId: string;
    timeoutMs: number | null;
    stripPrefix: string | null;
    status: Route["status"];
  }>
): Promise<Route> {
  const result = await query(
    `UPDATE routes SET
      name = COALESCE($3, name),
      path_pattern = COALESCE($4, path_pattern),
      method = COALESCE($5, method),
      policy_id = COALESCE($6, policy_id),
      upstream_id = COALESCE($7, upstream_id),
      timeout_ms = CASE WHEN $8 = true THEN $9 ELSE timeout_ms END,
      strip_prefix = CASE WHEN $10 = true THEN $11 ELSE strip_prefix END,
      status = COALESCE($12, status),
      updated_at = now()
     WHERE tenant_id = $1 AND id = $2
     RETURNING *`,
    [
      tenantId,
      id,
      input.name ?? null,
      input.pathPattern ?? null,
      input.method ?? null,
      input.policyId ?? null,
      input.upstreamId ?? null,
      input.timeoutMs !== undefined,
      input.timeoutMs ?? null,
      input.stripPrefix !== undefined,
      input.stripPrefix ?? null,
      input.status ?? null
    ],
    "routes.update"
  );
  if (!result.rows[0]) {
    throw notFound("Route not found");
  }
  return mapRoute(result.rows[0]);
}

import type { PoolClient } from "pg";
import { notFound } from "../../errors.js";
import type { Tenant, TenantStatus } from "../../types.js";
import { mapTenant } from "../mappers.js";
import { query } from "../pool.js";

export async function createTenant(input: {
  slug: string;
  name: string;
}): Promise<Tenant> {
  const result = await query(
    `INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING *`,
    [input.slug, input.name],
    "tenants.insert"
  );
  return mapTenant(result.rows[0]);
}

export async function listTenants(): Promise<Tenant[]> {
  const result = await query(`SELECT * FROM tenants ORDER BY created_at ASC`, [], "tenants.list");
  return result.rows.map((row) => mapTenant(row));
}

export async function getTenantById(id: string): Promise<Tenant> {
  const result = await query(`SELECT * FROM tenants WHERE id = $1`, [id], "tenants.get");
  if (!result.rows[0]) {
    throw notFound("Tenant not found");
  }
  return mapTenant(result.rows[0]);
}

export async function updateTenant(
  id: string,
  input: { name?: string; status?: TenantStatus }
): Promise<Tenant> {
  const result = await query(
    `UPDATE tenants
     SET name = COALESCE($2, name),
         status = COALESCE($3, status),
         updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, input.name ?? null, input.status ?? null],
    "tenants.update"
  );
  if (!result.rows[0]) {
    throw notFound("Tenant not found");
  }
  return mapTenant(result.rows[0]);
}

export async function countActiveTenants(): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM tenants WHERE status = 'active'`,
    [],
    "tenants.count_active"
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function assertTenantExists(client: PoolClient, tenantId: string): Promise<void> {
  const result = await client.query(`SELECT 1 FROM tenants WHERE id = $1`, [tenantId]);
  if (!result.rows[0]) {
    throw notFound("Tenant not found");
  }
}

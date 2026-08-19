import type { AuditLog } from "../../types.js";
import { mapAudit } from "../mappers.js";
import { query } from "../pool.js";

export async function writeAudit(input: {
  tenantId?: string | null;
  actor: string;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  payload?: Record<string, unknown>;
}): Promise<AuditLog> {
  const result = await query(
    `INSERT INTO audit_logs (tenant_id, actor, action, resource_type, resource_id, payload)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING *`,
    [
      input.tenantId ?? null,
      input.actor,
      input.action,
      input.resourceType,
      input.resourceId ?? null,
      JSON.stringify(input.payload ?? {})
    ],
    "audit.insert"
  );
  return mapAudit(result.rows[0]);
}

export async function listAudit(tenantId: string, limit = 50): Promise<AuditLog[]> {
  const result = await query(
    `SELECT * FROM audit_logs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [tenantId, limit],
    "audit.list"
  );
  return result.rows.map((row) => mapAudit(row));
}

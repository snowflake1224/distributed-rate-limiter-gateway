import { hashesEqual } from "../../auth/apiKeys.js";
import { notFound } from "../../errors.js";
import type { ApiKeyRecord } from "../../types.js";
import { mapApiKey } from "../mappers.js";
import { query } from "../pool.js";

export async function insertApiKey(input: {
  tenantId: string;
  name: string;
  keyPrefix: string;
  keyHash: string;
  expiresAt?: Date | null;
}): Promise<ApiKeyRecord> {
  const result = await query(
    `INSERT INTO api_keys (tenant_id, name, key_prefix, key_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [input.tenantId, input.name, input.keyPrefix, input.keyHash, input.expiresAt ?? null],
    "api_keys.insert"
  );
  return mapApiKey(result.rows[0]);
}

export async function listApiKeys(tenantId: string): Promise<ApiKeyRecord[]> {
  const result = await query(
    `SELECT * FROM api_keys WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenantId],
    "api_keys.list"
  );
  return result.rows.map((row) => mapApiKey(row));
}

export async function getApiKey(tenantId: string, id: string): Promise<ApiKeyRecord> {
  const result = await query(
    `SELECT * FROM api_keys WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
    "api_keys.get"
  );
  if (!result.rows[0]) {
    throw notFound("API key not found");
  }
  return mapApiKey(result.rows[0]);
}

export async function revokeApiKey(tenantId: string, id: string): Promise<ApiKeyRecord> {
  const result = await query(
    `UPDATE api_keys
     SET status = 'revoked', revoked_at = now()
     WHERE tenant_id = $1 AND id = $2
     RETURNING *`,
    [tenantId, id],
    "api_keys.revoke"
  );
  if (!result.rows[0]) {
    throw notFound("API key not found");
  }
  return mapApiKey(result.rows[0]);
}

export async function findActiveKeyByPrefix(prefix: string): Promise<ApiKeyRecord | null> {
  const result = await query(
    `SELECT * FROM api_keys WHERE key_prefix = $1 AND status = 'active'`,
    [prefix],
    "api_keys.by_prefix"
  );
  return result.rows[0] ? mapApiKey(result.rows[0]) : null;
}

export function recordMatchesHash(record: ApiKeyRecord, incomingHash: string): boolean {
  return hashesEqual(record.keyHash, incomingHash);
}

export async function touchLastUsed(id: string): Promise<void> {
  await query(
    `UPDATE api_keys SET last_used_at = now() WHERE id = $1`,
    [id],
    "api_keys.touch"
  ).catch(() => undefined);
}

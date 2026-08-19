import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { env } from "../config/env.js";
import { logger } from "../logging/logger.js";
import { postgresLatencySeconds } from "../metrics/registry.js";

export const pool = new Pool({
  connectionString: env.databaseUrl,
  max: env.pgPoolMax,
  idleTimeoutMillis: env.pgIdleTimeoutMs,
  connectionTimeoutMillis: env.pgConnectionTimeoutMs
});

pool.on("error", (err) => {
  logger.error({ err }, "Unexpected PostgreSQL pool error");
});

export async function query<T extends QueryResultRow>(
  text: string,
  params: unknown[] = [],
  operation = "query"
): Promise<QueryResult<T>> {
  const started = process.hrtime.bigint();
  try {
    const result = await pool.query<T>({
      text,
      values: params,
      // statement_timeout is also set per connection on checkout
    });
    return result;
  } finally {
    const elapsed = Number(process.hrtime.bigint() - started) / 1e9;
    postgresLatencySeconds.observe({ operation }, elapsed);
  }
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(`SET statement_timeout = ${env.pgStatementTimeoutMs}`);
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function pingPostgres(): Promise<boolean> {
  try {
    await query("SELECT 1 AS ok", [], "ping");
    return true;
  } catch {
    return false;
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}

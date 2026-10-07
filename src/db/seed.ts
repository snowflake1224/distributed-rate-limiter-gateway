import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { extractPrefix, generateApiKey, hashApiKey } from "../auth/apiKeys.js";
import { env } from "../config/env.js";
import { logger } from "../logging/logger.js";
import { closePool, pool } from "./pool.js";

interface SeedSecrets {
  adminApiKey: string;
  acmeKey: string;
  globexKey: string;
}

function keyFromPlaintext(plaintext: string): { plaintext: string; prefix: string; hash: string } {
  const prefix = extractPrefix(plaintext);
  if (!prefix) {
    throw new Error("DEMO_ACME_KEY and DEMO_GLOBEX_KEY must look like gwk_<prefix>_<secret>");
  }
  return { plaintext, prefix, hash: hashApiKey(plaintext) };
}

async function seed(): Promise<SeedSecrets> {
  if (process.env.SEED_FORCE !== "true") {
    const existing = await pool.query("SELECT 1 FROM tenants LIMIT 1");
    if ((existing.rowCount ?? 0) > 0) {
      logger.info("Seed skipped because tenants already exist. Set SEED_FORCE=true to replace demo data.");
      return {
        adminApiKey: env.adminApiKey,
        acmeKey: process.env.DEMO_ACME_KEY ?? "unchanged",
        globexKey: process.env.DEMO_GLOBEX_KEY ?? "unchanged"
      };
    }
  }

  const acme = process.env.DEMO_ACME_KEY ? keyFromPlaintext(process.env.DEMO_ACME_KEY) : generateApiKey();
  const globex = process.env.DEMO_GLOBEX_KEY ? keyFromPlaintext(process.env.DEMO_GLOBEX_KEY) : generateApiKey();

  await pool.query("DELETE FROM usage_snapshots");
  await pool.query("DELETE FROM audit_logs");
  await pool.query("DELETE FROM routes");
  await pool.query("DELETE FROM policies");
  await pool.query("DELETE FROM upstreams");
  await pool.query("DELETE FROM api_keys");
  await pool.query("DELETE FROM tenants");

  const tenants = await pool.query(
    `INSERT INTO tenants (slug, name)
     VALUES ('acme', 'Acme Payments'), ('globex', 'Globex Commerce')
     RETURNING id, slug`
  );
  const acmeId = String(tenants.rows.find((row) => row.slug === "acme")?.id);
  const globexId = String(tenants.rows.find((row) => row.slug === "globex")?.id);

  await pool.query(
    `INSERT INTO api_keys (tenant_id, name, key_prefix, key_hash)
     VALUES ($1, 'acme-demo', $2, $3), ($4, 'globex-demo', $5, $6)`,
    [acmeId, acme.prefix, acme.hash, globexId, globex.prefix, globex.hash]
  );

  const acmeTb = await pool.query(
    `INSERT INTO policies (
      tenant_id, name, algorithm, limit_count, window_ms, refill_rate_per_sec,
      burst_capacity, dimensions, fail_mode
    ) VALUES (
      $1, 'orders-token-bucket', 'token_bucket', 20, 1000, 10, 20,
      ARRAY['tenant','api_key','route']::text[], 'fail_closed'
    ) RETURNING id`,
    [acmeId]
  );
  const acmeSw = await pool.query(
    `INSERT INTO policies (
      tenant_id, name, algorithm, limit_count, window_ms, refill_rate_per_sec,
      burst_capacity, dimensions, custom_header, fail_mode
    ) VALUES (
      $1, 'search-sliding-window', 'sliding_window', 5, 10000, 1, 5,
      ARRAY['tenant','route','custom']::text[], 'x-user-id', 'fail_closed'
    ) RETURNING id`,
    [acmeId]
  );
  const acmeIp = await pool.query(
    `INSERT INTO policies (
      tenant_id, name, algorithm, limit_count, window_ms, refill_rate_per_sec,
      burst_capacity, dimensions, fail_mode
    ) VALUES (
      $1, 'ip-burst', 'token_bucket', 30, 1000, 5, 15,
      ARRAY['tenant','ip','route']::text[], 'fail_closed'
    ) RETURNING id`,
    [acmeId]
  );
  const globexPolicy = await pool.query(
    `INSERT INTO policies (
      tenant_id, name, algorithm, limit_count, window_ms, refill_rate_per_sec,
      burst_capacity, dimensions, fail_mode
    ) VALUES (
      $1, 'catalog-window', 'sliding_window', 20, 5000, 4, 20,
      ARRAY['tenant','api_key','route']::text[], 'fail_closed'
    ) RETURNING id`,
    [globexId]
  );
  const failOpenPolicy = await pool.query(
    `INSERT INTO policies (
      tenant_id, name, algorithm, limit_count, window_ms, refill_rate_per_sec,
      burst_capacity, dimensions, fail_mode
    ) VALUES (
      $1, 'fail-open-demo', 'token_bucket', 100, 1000, 50, 100,
      ARRAY['tenant','route']::text[], 'fail_open'
    ) RETURNING id`,
    [acmeId]
  );

  const healthy = await pool.query(
    `INSERT INTO upstreams (tenant_id, name, base_url, timeout_ms, cb_failure_threshold, cb_recovery_ms, cb_half_open_max_probes)
     VALUES ($1, 'healthy', $2, 2000, 5, 8000, 1)
     RETURNING id`,
    [acmeId, process.env.UPSTREAM_HEALTHY_URL ?? "http://upstream-ok:4000"]
  );
  const flaky = await pool.query(
    `INSERT INTO upstreams (tenant_id, name, base_url, timeout_ms, cb_failure_threshold, cb_recovery_ms, cb_half_open_max_probes)
     VALUES ($1, 'flaky', $2, 800, 3, 5000, 1)
     RETURNING id`,
    [acmeId, process.env.UPSTREAM_FLAKY_URL ?? "http://upstream-flaky:4000"]
  );
  const globexUp = await pool.query(
    `INSERT INTO upstreams (tenant_id, name, base_url, timeout_ms)
     VALUES ($1, 'catalog', $2, 2000)
     RETURNING id`,
    [globexId, process.env.UPSTREAM_HEALTHY_URL ?? "http://upstream-ok:4000"]
  );

  await pool.query(
    `INSERT INTO routes (tenant_id, name, path_pattern, method, policy_id, upstream_id, strip_prefix)
     VALUES
      ($1, 'orders', '/api/orders', '*', $2, $3, NULL),
      ($1, 'order-by-id', '/api/orders/:id', 'GET', $2, $3, NULL),
      ($1, 'search', '/api/search', 'GET', $4, $3, NULL),
      ($1, 'ip-limited', '/api/ip-demo', '*', $5, $3, NULL),
      ($1, 'flaky', '/api/flaky', '*', $6, $7, NULL),
      ($8, 'catalog', '/api/catalog', '*', $9, $10, NULL)`,
    [
      acmeId,
      acmeTb.rows[0].id,
      healthy.rows[0].id,
      acmeSw.rows[0].id,
      acmeIp.rows[0].id,
      failOpenPolicy.rows[0].id,
      flaky.rows[0].id,
      globexId,
      globexPolicy.rows[0].id,
      globexUp.rows[0].id
    ]
  );

  await pool.query(
    `INSERT INTO audit_logs (tenant_id, actor, action, resource_type, resource_id, payload)
     VALUES ($1::uuid, 'seed', 'seed.apply', 'tenant', $2, '{"note":"initial demo data"}')`,
    [acmeId, acmeId]
  );

  return {
    adminApiKey: env.adminApiKey,
    acmeKey: acme.plaintext,
    globexKey: globex.plaintext
  };
}

seed()
  .then(async (secrets) => {
    const out = path.resolve(process.env.SEED_OUTPUT_PATH ?? path.join(process.cwd(), "seed-secrets.json"));
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(
      out,
      JSON.stringify(
        {
          ...secrets,
          note: "Plaintext API keys are shown only at seed/create time. They are stored as SHA-256 hashes."
        },
        null,
        2
      )
    );
    logger.info({ out, adminApiKey: secrets.adminApiKey }, "Seed complete. Client keys written to seed-secrets.json");
    await closePool();
  })
  .catch(async (error) => {
    logger.error({ err: error }, "Seed failed");
    await closePool();
    process.exit(1);
  });

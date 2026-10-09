import dotenv from "dotenv";

dotenv.config();

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer`);
  }
  return parsed;
}

function list(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((entry) => entry.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: integer("PORT", 3000),
  instanceId: process.env.INSTANCE_ID ?? `gateway-${process.pid}`,
  databaseUrl: required(
    "DATABASE_URL",
    "postgres://gateway:gateway@localhost:5432/gateway"
  ),
  pgPoolMax: integer("PG_POOL_MAX", 20),
  pgIdleTimeoutMs: integer("PG_IDLE_TIMEOUT_MS", 10_000),
  pgConnectionTimeoutMs: integer("PG_CONNECTION_TIMEOUT_MS", 3_000),
  pgStatementTimeoutMs: integer("PG_STATEMENT_TIMEOUT_MS", 2_000),
  redisUrl: required("REDIS_URL", "redis://localhost:6379"),
  redisConnectTimeoutMs: integer("REDIS_CONNECT_TIMEOUT_MS", 1_000),
  redisCommandTimeoutMs: integer("REDIS_COMMAND_TIMEOUT_MS", 200),
  redisMaxRetries: integer("REDIS_MAX_RETRIES", 1),
  adminApiKey: required("ADMIN_API_KEY", "dev-admin-key-change-me"),
  apiKeyPepper: required("API_KEY_PEPPER", "dev-pepper-change-me"),
  policyCacheTtlMs: integer("POLICY_CACHE_TTL_MS", 5_000),
  policyCacheMax: integer("POLICY_CACHE_MAX", 10_000),
  apiKeyCacheTtlMs: integer("API_KEY_CACHE_TTL_MS", 5_000),
  apiKeyCacheMax: integer("API_KEY_CACHE_MAX", 5_000),
  defaultFailMode: (process.env.DEFAULT_FAIL_MODE ?? "fail_closed") as
    | "fail_closed"
    | "fail_open",
  defaultUpstreamTimeoutMs: integer("DEFAULT_UPSTREAM_TIMEOUT_MS", 3_000),
  shutdownDrainMs: integer("SHUTDOWN_DRAIN_MS", 10_000),
  logLevel: process.env.LOG_LEVEL ?? "info",
  demoSandboxEnabled: process.env.DEMO_SANDBOX_ENABLED === "true",
  demoSandboxTtlMs: integer("DEMO_SANDBOX_TTL_MS", 30 * 60_000),
  demoSandboxMax: integer("DEMO_SANDBOX_MAX", 50),
  demoSandboxMaxPerIp: integer("DEMO_SANDBOX_MAX_PER_IP", 3),
  demoSweepIntervalMs: integer("DEMO_SWEEP_INTERVAL_MS", 60_000),
  demoLabUpstreamUrl: (process.env.DEMO_LAB_UPSTREAM_URL ?? "http://upstream-lab:4000").replace(/\/+$/, ""),
  demoPeerUrls: list("DEMO_PEER_URLS"),
  demoPublicAcmeKey: process.env.DEMO_PUBLIC_ACME_KEY ?? "",
  demoPublicGlobexKey: process.env.DEMO_PUBLIC_GLOBEX_KEY ?? ""
};

export function isProduction(): boolean {
  return env.nodeEnv === "production";
}

import { randomUUID } from "node:crypto";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { generateApiKey } from "../../src/auth/apiKeys.js";
import { insertApiKey } from "../../src/db/repositories/apiKeys.js";
import { createPolicy } from "../../src/db/repositories/policies.js";
import { createRoute } from "../../src/db/repositories/routes.js";
import { createTenant } from "../../src/db/repositories/tenants.js";
import { createUpstream } from "../../src/db/repositories/upstreams.js";
import { migrate } from "../../src/db/migrate.js";
import { connectRedis } from "../../src/redis/client.js";

export const adminKey = process.env.ADMIN_API_KEY ?? "dev-admin-key-change-me";

export async function bootIntegration(): Promise<void> {
  await migrate();
  await connectRedis();
}

export function app() {
  return createApp();
}

export async function provisionTenant(input?: {
  algorithm?: "token_bucket" | "sliding_window";
  dimensions?: Array<"tenant" | "api_key" | "route" | "ip" | "custom">;
  limitCount?: number;
  burstCapacity?: number;
  refillRatePerSec?: number;
  windowMs?: number;
  failMode?: "fail_closed" | "fail_open";
  pathPattern?: string;
  upstreamUrl?: string;
  cbFailureThreshold?: number;
}) {
  const tenant = await createTenant({
    slug: `t-${randomUUID().slice(0, 8)}`,
    name: "Integration Tenant"
  });
  const generated = generateApiKey();
  const apiKey = await insertApiKey({
    tenantId: tenant.id,
    name: "itest",
    keyPrefix: generated.prefix,
    keyHash: generated.hash
  });
  const policy = await createPolicy({
    tenantId: tenant.id,
    name: "itest-policy",
    algorithm: input?.algorithm ?? "token_bucket",
    limitCount: input?.limitCount ?? 5,
    windowMs: input?.windowMs ?? 2000,
    refillRatePerSec: input?.refillRatePerSec ?? 1,
    burstCapacity: input?.burstCapacity ?? 5,
    dimensions: input?.dimensions ?? ["tenant", "api_key", "route"],
    failMode: input?.failMode ?? "fail_closed"
  });
  const upstream = await createUpstream({
    tenantId: tenant.id,
    name: "itest-up",
    baseUrl: input?.upstreamUrl ?? process.env.UPSTREAM_HEALTHY_URL ?? "http://127.0.0.1:3999",
    timeoutMs: 500,
    cbFailureThreshold: input?.cbFailureThreshold ?? 2,
    cbRecoveryMs: 200,
    cbHalfOpenMaxProbes: 1
  });
  const route = await createRoute({
    tenantId: tenant.id,
    name: "itest-route",
    pathPattern: input?.pathPattern ?? "/api/demo",
    method: "*",
    policyId: policy.id,
    upstreamId: upstream.id
  });
  return { tenant, apiKey, plaintext: generated.plaintext, policy, upstream, route };
}

export function admin(agent: request.SuperTest<request.Test> | ReturnType<typeof request>) {
  return {
    get: (url: string) => request(app()).get(url).set("x-admin-key", adminKey),
    post: (url: string, body: unknown) =>
      request(app()).post(url).set("x-admin-key", adminKey).send(body)
  };
}

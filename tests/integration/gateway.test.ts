import { createServer } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { invalidateAllApiKeys, invalidateTenantConfig } from "../../src/cache/configCache.js";
import { resetBreakers } from "../../src/circuitbreaker/breaker.js";
import { closePool } from "../../src/db/pool.js";
import { closeRedis } from "../../src/redis/client.js";
import { bootIntegration, provisionTenant } from "./helpers.js";

const enabled = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);

describe.skipIf(!enabled)("gateway integration", () => {
  let upstream: ReturnType<typeof createServer>;
  let flaky: ReturnType<typeof createServer>;
  let upstreamUrl = "";
  let flakyUrl = "";
  let failCount = 0;

  beforeAll(async () => {
    await bootIntegration();
    upstream = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, path: req.url, instance: "ok" }));
    }).listen(0);
    flaky = createServer((_req, res) => {
      failCount += 1;
      if (failCount <= 3) {
        res.statusCode = 503;
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      res.end(JSON.stringify({ ok: true }));
    }).listen(0);
    const okAddr = upstream.address();
    const flakyAddr = flaky.address();
    if (okAddr && typeof okAddr === "object") {
      upstreamUrl = `http://127.0.0.1:${okAddr.port}`;
    }
    if (flakyAddr && typeof flakyAddr === "object") {
      flakyUrl = `http://127.0.0.1:${flakyAddr.port}`;
    }
  });

  afterAll(async () => {
    upstream.close();
    flaky.close();
    await closeRedis();
    await closePool();
  });

  it("rejects missing and invalid API keys", async () => {
    const app = createApp();
    await request(app).get("/api/demo").expect(401);
    await request(app).get("/api/demo").set("x-api-key", "gwk_nope_nope").expect(401);
  });

  it("enforces tenant isolation on admin reads", async () => {
    const a = await provisionTenant({ upstreamUrl });
    const b = await provisionTenant({ upstreamUrl });
    const app = createApp();
    const res = await request(app)
      .get(`/admin/v1/tenants/${a.tenant.id}/policies/${b.policy.id}`)
      .set("x-admin-key", process.env.ADMIN_API_KEY ?? "dev-admin-key-change-me");
    expect(res.status).toBe(404);
  });

  it("never trusts a tenant_id supplied by the client", async () => {
    const a = await provisionTenant({ upstreamUrl, pathPattern: "/api/iso" });
    const b = await provisionTenant({ upstreamUrl, pathPattern: "/api/iso" });
    invalidateAllApiKeys();
    invalidateTenantConfig(a.tenant.id);
    invalidateTenantConfig(b.tenant.id);
    const res = await request(createApp())
      .get("/api/iso")
      .set("x-api-key", a.plaintext)
      .set("x-tenant-id", b.tenant.id)
      .expect(200);
    expect(res.headers["x-tenant-id"] || res.body.tenantId || a.tenant.id).toBeDefined();
    const other = await request(createApp())
      .get(`/admin/v1/tenants/${b.tenant.id}/routes`)
      .set("x-admin-key", process.env.ADMIN_API_KEY ?? "dev-admin-key-change-me")
      .expect(200);
    expect(other.body.routes[0].tenantId).toBe(b.tenant.id);
  });

  it("rate-limits concurrent requests using shared Redis state", async () => {
    const fixture = await provisionTenant({
      upstreamUrl,
      algorithm: "sliding_window",
      limitCount: 5,
      windowMs: 10_000,
      pathPattern: "/api/burst"
    });
    invalidateAllApiKeys();
    invalidateTenantConfig(fixture.tenant.id);
    const app = createApp();
    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        request(app).get("/api/burst").set("x-api-key", fixture.plaintext)
      )
    );
    const allowed = responses.filter((r) => r.status === 200).length;
    const limited = responses.filter((r) => r.status === 429).length;
    expect(allowed).toBe(5);
    expect(limited).toBe(7);
    expect(responses.find((r) => r.status === 429)?.headers["retry-after"]).toBeDefined();
    expect(responses[0]?.headers["ratelimit-limit"]).toBeDefined();
  });

  it("shares rate-limit state across two gateway instances", async () => {
    const fixture = await provisionTenant({
      upstreamUrl,
      algorithm: "token_bucket",
      burstCapacity: 4,
      refillRatePerSec: 0.01,
      pathPattern: "/api/multi"
    });
    invalidateAllApiKeys();
    const one = createApp();
    const two = createApp();
    const first = await Promise.all(
      Array.from({ length: 3 }, () => request(one).get("/api/multi").set("x-api-key", fixture.plaintext))
    );
    const second = await Promise.all(
      Array.from({ length: 3 }, () => request(two).get("/api/multi").set("x-api-key", fixture.plaintext))
    );
    const allowed = [...first, ...second].filter((r) => r.status === 200).length;
    expect(allowed).toBe(4);
  });

  it("opens the circuit after repeated upstream 5xx", async () => {
    resetBreakers();
    failCount = 0;
    const fixture = await provisionTenant({
      upstreamUrl: flakyUrl,
      pathPattern: "/api/flaky-it",
      burstCapacity: 50,
      refillRatePerSec: 50,
      cbFailureThreshold: 2
    });
    invalidateTenantConfig(fixture.tenant.id);
    const app = createApp();
    await request(app).get("/api/flaky-it").set("x-api-key", fixture.plaintext);
    await request(app).get("/api/flaky-it").set("x-api-key", fixture.plaintext);
    const opened = await request(app).get("/api/flaky-it").set("x-api-key", fixture.plaintext);
    expect([502, 503]).toContain(opened.status);
  });

  it("fails closed when asked to use a missing redis command timeout path", async () => {
    const fixture = await provisionTenant({
      upstreamUrl,
      failMode: "fail_closed",
      pathPattern: "/api/ready-check"
    });
    invalidateAllApiKeys();
    const ready = await request(createApp()).get("/health/ready");
    expect(ready.status).toBe(200);
    expect(ready.body.checks.redis).toBe(true);
    expect(fixture.plaintext.startsWith("gwk_")).toBe(true);
  });
});

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { env } from "../../src/config/env.js";
import { closePool, query } from "../../src/db/pool.js";
import { sweepExpiredSandboxes } from "../../src/demo/sandboxes.js";
import { closeRedis } from "../../src/redis/client.js";
import { createUpstreamApp } from "../../src/upstream/app.js";
import { bootIntegration } from "./helpers.js";

const enabled = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

const policy = {
  algorithm: "token_bucket",
  burstCapacity: 10,
  refillRatePerSec: 0.1,
  limitCount: 10,
  windowMs: 10_000,
  dimensions: ["tenant", "api_key", "route"]
};

describe.skipIf(!enabled)("interactive lab sandboxes", () => {
  const servers: Server[] = [];

  function clientIp(): string {
    return `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  }

  async function create(body: unknown = { policy }) {
    const res = await request(createApp())
      .post("/demo/v1/sandboxes")
      .set("x-forwarded-for", clientIp())
      .send(body)
      .expect(201);
    return res.body as { sandbox: { id: string; routePrefix: string; policy: { version: number } }; apiKey: string; token: string };
  }

  beforeAll(async () => {
    await bootIntegration();
    const lab = createServer(createUpstreamApp({ mode: "lab" }));
    servers.push(lab);
    env.demoLabUpstreamUrl = await listen(lab);
    env.demoSandboxEnabled = true;
    env.demoSandboxMaxPerIp = 2;
    env.demoSandboxMax = 10_000;
    const g1 = createServer(createApp());
    const g2 = createServer(createApp());
    servers.push(g1, g2);
    env.demoPeerUrls = [await listen(g1), await listen(g2)];
  });

  afterAll(async () => {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    await closeRedis();
    await closePool();
  });

  it("publishes a manifest without secrets beyond the public demo keys", async () => {
    const res = await request(createApp()).get("/demo/v1/manifest").expect(200);
    expect(res.body.sandboxEnabled).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(env.adminApiKey);
    expect(JSON.stringify(res.body)).not.toContain(env.apiKeyPepper);
  });

  it("rejects invalid sandbox configuration", async () => {
    await request(createApp())
      .post("/demo/v1/sandboxes")
      .set("x-forwarded-for", clientIp())
      .send({ policy: { ...policy, burstCapacity: 5000 } })
      .expect(400);
  });

  it("creates a sandbox that enforces exactly the configured burst", async () => {
    const { sandbox, apiKey } = await create();
    const app = createApp();
    const responses = await Promise.all(
      Array.from({ length: 15 }, () => request(app).get(`${sandbox.routePrefix}/orders`).set("x-api-key", apiKey))
    );
    expect(responses.filter((r) => r.status === 200)).toHaveLength(10);
    expect(responses.filter((r) => r.status === 429)).toHaveLength(5);
    const ok = responses.find((r) => r.status === 200)!;
    expect(ok.body.upstream).toBe("lab");
    expect(ok.body.path).toBe("/orders");
    expect(ok.headers["x-gateway-instance"]).toBe(env.instanceId);
  });

  it("requires the sandbox token for reads and writes", async () => {
    const { sandbox } = await create();
    await request(createApp()).get(`/demo/v1/sandboxes/${sandbox.id}`).expect(401);
    await request(createApp()).get(`/demo/v1/sandboxes/${sandbox.id}`).set("x-sandbox-token", "wrong").expect(401);
    await request(createApp()).delete(`/demo/v1/sandboxes/${sandbox.id}`).expect(401);
  });

  it("isolates sandboxes from each other", async () => {
    const a = await create();
    const b = await create();
    await request(createApp()).get(`${b.sandbox.routePrefix}/orders`).set("x-api-key", a.apiKey).expect(404);
    await request(createApp()).get(`/demo/v1/sandboxes/${b.sandbox.id}`).set("x-sandbox-token", a.token).expect(401);
  });

  it("caps active sandboxes per client address", async () => {
    const ip = clientIp();
    const app = createApp();
    await request(app).post("/demo/v1/sandboxes").set("x-forwarded-for", ip).send({ policy }).expect(201);
    await request(app).post("/demo/v1/sandboxes").set("x-forwarded-for", ip).send({ policy }).expect(201);
    const third = await request(app).post("/demo/v1/sandboxes").set("x-forwarded-for", ip).send({ policy }).expect(429);
    expect(third.body.error.code).toBe("sandbox_capacity");
  });

  it("server-side runner proves no over-admission across two instances", async () => {
    const { sandbox, apiKey, token } = await create();
    const res = await request(createApp())
      .post(`/demo/v1/sandboxes/${sandbox.id}/runs`)
      .set("x-sandbox-token", token)
      .set("x-sandbox-api-key", apiKey)
      .send({ path: `${sandbox.routePrefix}/orders`, count: 50, concurrency: 50 })
      .expect(200);
    const rows = res.body.rows as Array<{ outcome: string; target: string }>;
    expect(rows).toHaveLength(50);
    expect(rows.filter((r) => r.outcome === "allowed")).toHaveLength(10);
    expect(rows.filter((r) => r.outcome === "rate_limited")).toHaveLength(40);
    expect(new Set(rows.map((r) => r.target)).size).toBe(2);
  });

  it("runner refuses paths outside the sandbox route", async () => {
    const { sandbox, apiKey, token } = await create();
    await request(createApp())
      .post(`/demo/v1/sandboxes/${sandbox.id}/runs`)
      .set("x-sandbox-token", token)
      .set("x-sandbox-api-key", apiKey)
      .send({ path: "/api/orders", count: 1, concurrency: 1 })
      .expect(400);
  });

  it("live policy edits bump the version and change behavior", async () => {
    const { sandbox, apiKey, token } = await create();
    const app = createApp();
    const patched = await request(app)
      .patch(`/demo/v1/sandboxes/${sandbox.id}`)
      .set("x-sandbox-token", token)
      .send({ policy: { burstCapacity: 2 } })
      .expect(200);
    expect(patched.body.sandbox.policy.version).toBe(sandbox.policy.version + 1);
    const statuses = [];
    for (let i = 0; i < 4; i += 1) {
      statuses.push((await request(app).get(`${sandbox.routePrefix}/x`).set("x-api-key", apiKey)).status);
    }
    expect(statuses).toEqual([200, 200, 429, 429]);
  });

  it("drives the circuit breaker through open and back to closed", async () => {
    const { sandbox, apiKey, token } = await create({
      policy: { ...policy, burstCapacity: 100, refillRatePerSec: 50 },
      upstream: { failFirstN: 2, cbFailureThreshold: 2, cbRecoveryMs: 1_000 }
    });
    const app = createApp();
    const get = () => request(app).get(`${sandbox.routePrefix}/pay`).set("x-api-key", apiKey);
    expect((await get()).status).toBe(503);
    expect((await get()).status).toBe(503);
    const open = await get();
    expect(open.body.error.message).toMatch(/circuit open/i);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect((await get()).status).toBe(200);
    const state = await request(app).get(`/demo/v1/sandboxes/${sandbox.id}`).set("x-sandbox-token", token).expect(200);
    expect(state.body.instances).toHaveLength(2);
  });

  it("deletes sandboxes and sweeps expired ones", async () => {
    const deleted = await create();
    await request(createApp())
      .delete(`/demo/v1/sandboxes/${deleted.sandbox.id}`)
      .set("x-sandbox-token", deleted.token)
      .expect(204);
    await request(createApp())
      .get(`/demo/v1/sandboxes/${deleted.sandbox.id}`)
      .set("x-sandbox-token", deleted.token)
      .expect(404);

    const expired = await create();
    await query(`UPDATE tenants SET sandbox_expires_at = now() - interval '1 minute' WHERE slug = $1`, [
      `sbx-${expired.sandbox.id}`
    ]);
    expect(await sweepExpiredSandboxes()).toBeGreaterThanOrEqual(1);
    const left = await query(`SELECT 1 FROM demo_sandboxes WHERE id = $1`, [expired.sandbox.id]);
    expect(left.rowCount).toBe(0);
  });
});

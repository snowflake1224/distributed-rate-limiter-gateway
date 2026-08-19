import { Router } from "express";
import { cacheStats } from "../cache/configCache.js";
import { listBreakerStates } from "../circuitbreaker/breaker.js";
import { env } from "../config/env.js";
import { pingPostgres } from "../db/pool.js";
import { pingRedis } from "../redis/client.js";

export const healthRouter = Router();

healthRouter.get("/live", (_req, res) => {
  res.json({ status: "ok", instance: env.instanceId, ts: new Date().toISOString() });
});

healthRouter.get("/ready", async (_req, res) => {
  const [postgres, redis] = await Promise.all([pingPostgres(), pingRedis()]);
  const ready = postgres && redis;
  res.status(ready ? 200 : 503).json({
    status: ready ? "ready" : "not_ready",
    instance: env.instanceId,
    checks: { postgres, redis },
    cache: cacheStats(),
    circuitBreakers: listBreakerStates()
  });
});

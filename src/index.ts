import { createServer } from "node:http";
import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { closePool } from "./db/pool.js";
import { countActivePolicies } from "./db/repositories/policies.js";
import { countActiveTenants } from "./db/repositories/tenants.js";
import { logger } from "./logging/logger.js";
import { activePolicies, activeTenants, startEventLoopLagSampler, stopEventLoopLagSampler } from "./metrics/registry.js";
import { closeRedis, connectRedis } from "./redis/client.js";
import { pruneIdleSandboxState } from "./demo/localState.js";
import { sweepExpiredSandboxes } from "./demo/sandboxes.js";

const app = createApp();
const server = createServer(app);

async function refreshCatalogGauges(): Promise<void> {
  try {
    activeTenants.set(await countActiveTenants());
    activePolicies.set(await countActivePolicies());
  } catch (error) {
    logger.warn({ err: error }, "Failed to refresh catalog gauges");
  }
}

async function sweepDemoSandboxes(): Promise<void> {
  try {
    const removed = await sweepExpiredSandboxes();
    const pruned = pruneIdleSandboxState(env.demoSandboxTtlMs);
    if (removed > 0 || pruned > 0) {
      logger.info({ removed, pruned }, "Swept expired lab sandboxes");
    }
  } catch (error) {
    logger.warn({ err: error }, "Lab sandbox sweep failed");
  }
}

async function start(): Promise<void> {
  await connectRedis();
  startEventLoopLagSampler();
  await refreshCatalogGauges();
  setInterval(() => {
    void refreshCatalogGauges();
  }, 15_000).unref();

  if (env.demoSandboxEnabled) {
    setInterval(() => {
      void sweepDemoSandboxes();
    }, env.demoSweepIntervalMs).unref();
  }

  server.listen(env.port, () => {
    logger.info({ port: env.port, instance: env.instanceId }, "Gateway listening");
  });
}

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info({ signal }, "Graceful shutdown started");
  server.close(async () => {
    stopEventLoopLagSampler();
    await closeRedis();
    await closePool();
    logger.info("Shutdown complete");
    process.exit(0);
  });
  setTimeout(() => {
    logger.error("Shutdown drain timed out");
    process.exit(1);
  }, env.shutdownDrainMs).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

start().catch((error) => {
  logger.error({ err: error }, "Failed to start gateway");
  process.exit(1);
});

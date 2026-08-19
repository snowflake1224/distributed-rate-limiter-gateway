import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Redis } from "ioredis";
import { env } from "../config/env.js";
import { logger } from "../logging/logger.js";
import { redisLatencySeconds } from "../metrics/registry.js";

const luaDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "lua");

export type LuaRedis = Redis & {
  tokenBucket(
    key: string,
    capacity: number,
    refillRatePerSec: number,
    cost: number,
    ttlMs: number
  ): Promise<[number, number, number, number, number, number]>;
  slidingWindow(
    key: string,
    windowMs: number,
    limit: number,
    member: string,
    ttlMs: number
  ): Promise<[number, number, number, number, number, number]>;
};

export const redis = new Redis(env.redisUrl, {
  connectTimeout: env.redisConnectTimeoutMs,
  commandTimeout: env.redisCommandTimeoutMs,
  maxRetriesPerRequest: env.redisMaxRetries,
  enableReadyCheck: true,
  lazyConnect: true
}) as LuaRedis;

redis.on("error", (err: Error) => {
  logger.error({ err }, "Redis client error");
});

export function registerLuaCommands(client: LuaRedis): void {
  client.defineCommand("tokenBucket", {
    numberOfKeys: 1,
    lua: readFileSync(path.join(luaDir, "token_bucket.lua"), "utf8")
  });
  client.defineCommand("slidingWindow", {
    numberOfKeys: 1,
    lua: readFileSync(path.join(luaDir, "sliding_window.lua"), "utf8")
  });
}

registerLuaCommands(redis);

export async function connectRedis(): Promise<void> {
  if (redis.status === "wait") {
    await redis.connect();
  }
}

export async function pingRedis(): Promise<boolean> {
  const started = process.hrtime.bigint();
  try {
    const result = await redis.ping();
    return result === "PONG";
  } catch {
    return false;
  } finally {
    redisLatencySeconds.observe(
      { command: "ping" },
      Number(process.hrtime.bigint() - started) / 1e9
    );
  }
}

export async function closeRedis(): Promise<void> {
  redis.disconnect();
}

export async function withRedisLatency<T>(command: string, fn: () => Promise<T>): Promise<T> {
  const started = process.hrtime.bigint();
  try {
    return await fn();
  } finally {
    redisLatencySeconds.observe({ command }, Number(process.hrtime.bigint() - started) / 1e9);
  }
}

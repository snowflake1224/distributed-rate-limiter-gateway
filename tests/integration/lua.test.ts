import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool } from "../../src/db/pool.js";
import { closeRedis, connectRedis, redis } from "../../src/redis/client.js";

const enabled = Boolean(process.env.REDIS_URL);

describe.skipIf(!enabled)("Redis Lua scripts", () => {
  beforeAll(async () => {
    await connectRedis();
  });

  afterAll(async () => {
    await closeRedis();
    await closePool();
  });

  it("token bucket is atomic under concurrent callers", async () => {
    const key = `test:tb:${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 40 }, () => redis.tokenBucket(key, 10, 0.0001, 1, 5000))
    );
    const allowed = results.filter((row) => Number(row[0]) === 1).length;
    expect(allowed).toBe(10);
  });

  it("sliding window never exceeds the limit under concurrency", async () => {
    const key = `test:sw:${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        redis.slidingWindow(key, 5000, 8, `${Date.now()}:${i}:${randomUUID()}`, 8000)
      )
    );
    const allowed = results.filter((row) => Number(row[0]) === 1).length;
    expect(allowed).toBe(8);
    expect(Number(await redis.zcard(key))).toBe(8);
  });

  it("token bucket refills after time passes", async () => {
    const key = `test:tb-refill:${randomUUID()}`;
    await redis.tokenBucket(key, 1, 100, 1, 5000);
    const denied = await redis.tokenBucket(key, 1, 100, 1, 5000);
    expect(Number(denied[0])).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const allowed = await redis.tokenBucket(key, 1, 100, 1, 5000);
    expect(Number(allowed[0])).toBe(1);
  });
});

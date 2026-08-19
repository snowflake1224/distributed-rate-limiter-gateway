import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { rateLimited, serviceUnavailable } from "../errors.js";
import { logger } from "../logging/logger.js";
import {
  decisionDurationSeconds,
  rateLimitAllowedTotal,
  rateLimitRejectedTotal,
  redisUnavailableTotal
} from "../metrics/registry.js";
import { redis, withRedisLatency } from "../redis/client.js";
import type { Policy, RateLimitDecision } from "../types.js";

function toDecision(
  raw: [number, number, number, number, number, number],
  algorithm: Policy["algorithm"],
  key: string
): RateLimitDecision {
  const [allowed, remaining, retryAfterMs, nowMs, resetMs, limit] = raw.map((n) => Number(n)) as [
    number,
    number,
    number,
    number,
    number,
    number
  ];
  return {
    allowed: allowed === 1,
    limit,
    remaining: Math.max(0, remaining),
    retryAfterMs: Math.max(0, retryAfterMs),
    resetEpochSeconds: Math.ceil(resetMs / 1000) || Math.ceil(nowMs / 1000),
    algorithm,
    key
  };
}

export async function evaluateRateLimit(policy: Policy, key: string): Promise<RateLimitDecision> {
  const started = process.hrtime.bigint();
  try {
    const raw: [number, number, number, number, number, number] =
      policy.algorithm === "token_bucket"
        ? await withRedisLatency("tokenBucket", () =>
            redis.tokenBucket(
              key,
              policy.burstCapacity,
              policy.refillRatePerSec,
              1,
              Math.max(policy.windowMs * 2, 60_000)
            )
          )
        : await withRedisLatency("slidingWindow", () =>
            redis.slidingWindow(
              key,
              policy.windowMs,
              policy.limitCount,
              `${Date.now()}:${randomUUID()}`,
              policy.windowMs + 5_000
            )
          );

    const decision = toDecision(raw, policy.algorithm, key);
    decisionDurationSeconds.observe(
      { algorithm: policy.algorithm },
      Number(process.hrtime.bigint() - started) / 1e9
    );
    return decision;
  } catch (error) {
    decisionDurationSeconds.observe(
      { algorithm: policy.algorithm },
      Number(process.hrtime.bigint() - started) / 1e9
    );
    const failMode = policy.failMode || env.defaultFailMode;
    redisUnavailableTotal.inc({ fail_mode: failMode });
    logger.error({ err: error, key, failMode }, "Redis rate-limit decision failed");

    if (failMode === "fail_open") {
      return {
        allowed: true,
        limit: policy.algorithm === "token_bucket" ? policy.burstCapacity : policy.limitCount,
        remaining: -1,
        retryAfterMs: 0,
        resetEpochSeconds: Math.ceil(Date.now() / 1000),
        algorithm: policy.algorithm,
        key
      };
    }

    throw serviceUnavailable("Rate limiter unavailable", 1);
  }
}

export function assertAllowed(decision: RateLimitDecision, tenantSlug: string): void {
  if (decision.allowed) {
    rateLimitAllowedTotal.inc({ tenant: tenantSlug, algorithm: decision.algorithm });
    return;
  }
  rateLimitRejectedTotal.inc({
    tenant: tenantSlug,
    algorithm: decision.algorithm,
    reason: "quota"
  });
  throw rateLimited(Math.max(1, Math.ceil(decision.retryAfterMs / 1000)), {
    limit: decision.limit,
    remaining: decision.remaining,
    reset: decision.resetEpochSeconds
  });
}

import type { Bound, PolicyConfig, RunConfig, UpstreamConfig } from "./types";

export const FALLBACK_BOUNDS: Record<string, Bound> = {
  burstCapacity: { min: 1, max: 100 },
  refillRatePerSec: { min: 0.1, max: 50 },
  limitCount: { min: 1, max: 100 },
  windowMs: { min: 1_000, max: 60_000 },
  delayMs: { min: 0, max: 3_000 },
  failRatePct: { min: 0, max: 100 },
  failFirstN: { min: 0, max: 50 },
  timeoutMs: { min: 200, max: 5_000 },
  cbFailureThreshold: { min: 1, max: 10 },
  cbRecoveryMs: { min: 1_000, max: 30_000 },
  cbHalfOpenMaxProbes: { min: 1, max: 3 },
  runCount: { min: 1, max: 200 },
  runConcurrency: { min: 1, max: 50 },
  rotateValues: { min: 1, max: 20 }
};

export const BROWSER_MAX_CONCURRENCY = 6;
export const HEADER_NAME = /^x-[a-z0-9-]{1,40}$/;
const RESERVED_HEADERS = new Set(["x-api-key", "x-admin-key", "x-forwarded-for", "x-real-ip", "x-request-id", "x-sandbox-token"]);

function inRange(value: number, bound: Bound | undefined): boolean {
  return bound !== undefined && Number.isFinite(value) && value >= bound.min && value <= bound.max;
}

export function bound(bounds: Record<string, Bound> | undefined, key: string): Bound {
  return bounds?.[key] ?? FALLBACK_BOUNDS[key]!;
}

export function validatePolicy(policy: PolicyConfig, bounds?: Record<string, Bound>): string[] {
  const errors: string[] = [];
  for (const key of ["burstCapacity", "refillRatePerSec", "limitCount", "windowMs"] as const) {
    if (!inRange(policy[key], bound(bounds, key))) {
      errors.push(`${key} must be between ${bound(bounds, key).min} and ${bound(bounds, key).max}`);
    }
  }
  if (policy.burstCapacity % 1 !== 0 || policy.limitCount % 1 !== 0 || policy.windowMs % 1 !== 0) {
    errors.push("Capacity, limit and window must be whole numbers");
  }
  if (policy.dimensions.length === 0) {
    errors.push("Pick at least one dimension");
  }
  if (policy.dimensions.includes("custom") && !HEADER_NAME.test(policy.customHeader)) {
    errors.push("Custom header must look like x-user-id (lowercase, starts with x-)");
  }
  return errors;
}

export function validateUpstream(upstream: UpstreamConfig, bounds?: Record<string, Bound>): string[] {
  const errors: string[] = [];
  for (const key of [
    "delayMs",
    "failRatePct",
    "failFirstN",
    "timeoutMs",
    "cbFailureThreshold",
    "cbRecoveryMs",
    "cbHalfOpenMaxProbes"
  ] as const) {
    if (!inRange(upstream[key], bound(bounds, key)) || upstream[key] % 1 !== 0) {
      errors.push(`${key} must be a whole number between ${bound(bounds, key).min} and ${bound(bounds, key).max}`);
    }
  }
  return errors;
}

export function validateHeaders(headers: Record<string, string>): string[] {
  const errors: string[] = [];
  const names = Object.keys(headers);
  if (names.length > 5) {
    errors.push("At most 5 custom headers");
  }
  for (const name of names) {
    if (!HEADER_NAME.test(name)) {
      errors.push(`Header "${name}" must look like x-something (lowercase)`);
    } else if (RESERVED_HEADERS.has(name)) {
      errors.push(`Header "${name}" is set by the lab, not by you`);
    }
  }
  return errors;
}

export function validateRun(config: RunConfig, routePrefix: string | null, bounds?: Record<string, Bound>): string[] {
  const errors = validateHeaders(config.headers);
  if (!config.path.startsWith("/")) {
    errors.push("Path must start with /");
  }
  if (config.credential === "sandbox" && routePrefix && !config.path.startsWith(`${routePrefix}/`)) {
    errors.push(`Sandbox requests must target ${routePrefix}/...`);
  }
  if (config.mode !== "single") {
    if (!inRange(config.count, bound(bounds, "runCount")) || config.count % 1 !== 0) {
      errors.push(`Requests must be between 1 and ${bound(bounds, "runCount").max}`);
    }
    const maxConcurrency = config.mode === "browser" ? BROWSER_MAX_CONCURRENCY : bound(bounds, "runConcurrency").max;
    if (!Number.isFinite(config.concurrency) || config.concurrency < 1 || config.concurrency > maxConcurrency || config.concurrency % 1 !== 0) {
      errors.push(
        config.mode === "browser"
          ? `Browser concurrency is capped at ${BROWSER_MAX_CONCURRENCY} (browsers open ~6 connections per host). Use the server-side runner for more.`
          : `Concurrency must be between 1 and ${maxConcurrency}`
      );
    }
    if (config.mode === "browser" && (!Number.isFinite(config.intervalMs) || config.intervalMs < 0 || config.intervalMs > 10_000)) {
      errors.push("Interval must be between 0 and 10000 ms");
    }
    if (config.mode === "server" && config.credential !== "sandbox") {
      errors.push("The server-side runner only uses your sandbox key");
    }
    if (config.rotateHeader) {
      if (!HEADER_NAME.test(config.rotateHeader.name)) {
        errors.push("Rotated header must look like x-user-id");
      }
      if (!inRange(config.rotateHeader.values, bound(bounds, "rotateValues"))) {
        errors.push(`Rotate between 1 and ${bound(bounds, "rotateValues").max} values`);
      }
    }
  }
  if (config.method === "POST" && config.body) {
    try {
      JSON.parse(config.body);
    } catch {
      errors.push("Body must be valid JSON");
    }
  }
  return errors;
}

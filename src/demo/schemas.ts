import { z } from "zod";

export const SANDBOX_BOUNDS = {
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
} as const;

const b = SANDBOX_BOUNDS;
const headerName = z
  .string()
  .regex(/^x-[a-z0-9-]{1,40}$/, "Header names must look like x-something (lowercase)");

export const policyConfigSchema = z.object({
  algorithm: z.enum(["token_bucket", "sliding_window"]),
  burstCapacity: z.number().int().min(b.burstCapacity.min).max(b.burstCapacity.max),
  refillRatePerSec: z.number().min(b.refillRatePerSec.min).max(b.refillRatePerSec.max),
  limitCount: z.number().int().min(b.limitCount.min).max(b.limitCount.max),
  windowMs: z.number().int().min(b.windowMs.min).max(b.windowMs.max),
  dimensions: z
    .array(z.enum(["tenant", "api_key", "route", "ip", "custom"]))
    .min(1)
    .max(5)
    .refine((dims) => new Set(dims).size === dims.length, "Dimensions must be unique"),
  customHeader: headerName.default("x-user-id"),
  failMode: z.enum(["fail_closed", "fail_open"]).default("fail_closed")
});

export const upstreamConfigSchema = z.object({
  delayMs: z.number().int().min(b.delayMs.min).max(b.delayMs.max).default(0),
  failRatePct: z.number().int().min(b.failRatePct.min).max(b.failRatePct.max).default(0),
  failFirstN: z.number().int().min(b.failFirstN.min).max(b.failFirstN.max).default(0),
  errorStatus: z.union([z.literal(500), z.literal(502), z.literal(503)]).default(503),
  timeoutMs: z.number().int().min(b.timeoutMs.min).max(b.timeoutMs.max).default(2_000),
  cbFailureThreshold: z
    .number()
    .int()
    .min(b.cbFailureThreshold.min)
    .max(b.cbFailureThreshold.max)
    .default(3),
  cbRecoveryMs: z.number().int().min(b.cbRecoveryMs.min).max(b.cbRecoveryMs.max).default(5_000),
  cbHalfOpenMaxProbes: z
    .number()
    .int()
    .min(b.cbHalfOpenMaxProbes.min)
    .max(b.cbHalfOpenMaxProbes.max)
    .default(1)
});

export const sandboxCreateSchema = z.object({
  policy: policyConfigSchema,
  upstream: upstreamConfigSchema.default({})
});

export const sandboxPatchSchema = z
  .object({
    policy: policyConfigSchema.partial().optional(),
    upstream: upstreamConfigSchema.partial().optional(),
    restartUpstreamCounter: z.boolean().optional(),
    resetCircuit: z.boolean().optional()
  })
  .refine(
    (body) => body.policy || body.upstream || body.restartUpstreamCounter || body.resetCircuit,
    "Nothing to update"
  );

const FORBIDDEN_RUN_HEADERS = new Set([
  "x-api-key",
  "x-admin-key",
  "x-forwarded-for",
  "x-real-ip",
  "x-request-id",
  "x-sandbox-token"
]);

export const runSchema = z.object({
  method: z.enum(["GET", "POST"]).default("GET"),
  path: z.string().min(1).max(200),
  count: z.number().int().min(b.runCount.min).max(b.runCount.max),
  concurrency: z.number().int().min(b.runConcurrency.min).max(b.runConcurrency.max),
  headers: z
    .record(headerName, z.string().max(200))
    .default({})
    .refine((headers) => Object.keys(headers).length <= 5, "At most 5 custom headers")
    .refine(
      (headers) => Object.keys(headers).every((name) => !FORBIDDEN_RUN_HEADERS.has(name)),
      "That header is controlled by the runner"
    ),
  rotateHeader: z
    .object({
      name: headerName,
      values: z.number().int().min(b.rotateValues.min).max(b.rotateValues.max)
    })
    .optional(),
  body: z.string().max(2_000).optional()
});

export type PolicyConfig = z.infer<typeof policyConfigSchema>;
export type UpstreamConfig = z.infer<typeof upstreamConfigSchema>;
export type SandboxCreateInput = z.infer<typeof sandboxCreateSchema>;
export type SandboxPatchInput = z.infer<typeof sandboxPatchSchema>;
export type RunInput = z.infer<typeof runSchema>;

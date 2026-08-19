import { z } from "zod";

export const tenantCreateSchema = z.object({
  slug: z.string().min(2).max(64).regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(128)
});

export const tenantUpdateSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  status: z.enum(["active", "suspended"]).optional()
});

export const apiKeyCreateSchema = z.object({
  name: z.string().min(1).max(128),
  expiresAt: z.string().datetime().optional()
});

export const policyUpsertSchema = z.object({
  name: z.string().min(1).max(128),
  algorithm: z.enum(["token_bucket", "sliding_window"]),
  limitCount: z.number().int().positive(),
  windowMs: z.number().int().positive(),
  refillRatePerSec: z.number().positive(),
  burstCapacity: z.number().int().positive(),
  dimensions: z.array(z.enum(["tenant", "api_key", "route", "ip", "custom"])).min(1),
  customHeader: z.string().min(1).max(64).optional().nullable(),
  failMode: z.enum(["fail_closed", "fail_open"]).default("fail_closed")
});

export const policyPatchSchema = policyUpsertSchema.partial().extend({
  status: z.enum(["active", "disabled"]).optional()
});

export const upstreamUpsertSchema = z.object({
  name: z.string().min(1).max(128),
  baseUrl: z.string().url(),
  timeoutMs: z.number().int().positive().default(3000),
  cbFailureThreshold: z.number().int().positive().default(5),
  cbRecoveryMs: z.number().int().positive().default(10_000),
  cbHalfOpenMaxProbes: z.number().int().positive().default(1)
});

export const upstreamPatchSchema = upstreamUpsertSchema.partial().extend({
  status: z.enum(["active", "disabled"]).optional()
});

export const routeUpsertSchema = z.object({
  name: z.string().min(1).max(128),
  pathPattern: z.string().min(1).max(256),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "*"]).default("*"),
  policyId: z.string().uuid(),
  upstreamId: z.string().uuid(),
  timeoutMs: z.number().int().positive().optional().nullable(),
  stripPrefix: z.string().max(256).optional().nullable()
});

export const routePatchSchema = routeUpsertSchema.partial().extend({
  status: z.enum(["active", "disabled"]).optional()
});

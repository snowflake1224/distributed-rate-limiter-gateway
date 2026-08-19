import { createHash } from "node:crypto";
import type { AuthenticatedKey, DimensionName, Policy, Route } from "../types.js";

export interface DimensionContext {
  auth: AuthenticatedKey;
  route: Route;
  policy: Policy;
  ip: string;
  headers: Record<string, string | string[] | undefined>;
}

export function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return value ?? "";
}

export function resolveDimensionValue(name: DimensionName, ctx: DimensionContext): string {
  switch (name) {
    case "tenant":
      return ctx.auth.tenantId;
    case "api_key":
      return ctx.auth.apiKeyId;
    case "route":
      return ctx.route.id;
    case "ip":
      return ctx.ip || "unknown";
    case "custom": {
      const header = ctx.policy.customHeader ?? "x-user-id";
      return headerValue(ctx.headers, header) || "anonymous";
    }
    default:
      return "unknown";
  }
}

export function buildRateLimitKey(ctx: DimensionContext): string {
  const parts = ctx.policy.dimensions.map((dimension) => {
    return `${dimension}=${resolveDimensionValue(dimension, ctx)}`;
  });
  const digest = createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);
  return `rl:${ctx.policy.algorithm}:${ctx.auth.tenantId}:${ctx.policy.id}:v${ctx.policy.version}:${digest}`;
}

export function validateDimensions(dimensions: DimensionName[]): string | null {
  if (dimensions.length === 0) {
    return "At least one dimension is required";
  }
  const allowed: DimensionName[] = ["tenant", "api_key", "route", "ip", "custom"];
  for (const dimension of dimensions) {
    if (!allowed.includes(dimension)) {
      return `Unsupported dimension: ${dimension}`;
    }
  }
  return null;
}

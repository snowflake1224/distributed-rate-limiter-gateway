import { describe, expect, it } from "vitest";
import { buildRateLimitKey, validateDimensions } from "../../src/policy/dimensions.js";
import type { AuthenticatedKey, Policy, Route } from "../../src/types.js";

const auth: AuthenticatedKey = {
  apiKeyId: "key-1",
  tenantId: "tenant-a",
  tenantSlug: "acme",
  tenantStatus: "active",
  name: "demo"
};

const route: Route = {
  id: "route-1",
  tenantId: "tenant-a",
  name: "orders",
  pathPattern: "/api/orders",
  method: "*",
  policyId: "policy-1",
  upstreamId: "up-1",
  timeoutMs: null,
  stripPrefix: null,
  status: "active",
  createdAt: new Date(),
  updatedAt: new Date()
};

function policy(dimensions: Policy["dimensions"], header?: string): Policy {
  return {
    id: "policy-1",
    tenantId: "tenant-a",
    name: "p",
    algorithm: "token_bucket",
    limitCount: 10,
    windowMs: 1000,
    refillRatePerSec: 10,
    burstCapacity: 10,
    dimensions,
    customHeader: header ?? null,
    failMode: "fail_closed",
    status: "active",
    version: 3,
    createdAt: new Date(),
    updatedAt: new Date()
  };
}

describe("dimension keys", () => {
  it("changes the redis key when a dimension value changes", () => {
    const base = buildRateLimitKey({
      auth,
      route,
      policy: policy(["tenant", "api_key", "route"]),
      ip: "1.1.1.1",
      headers: {}
    });
    const otherKey = buildRateLimitKey({
      auth: { ...auth, apiKeyId: "key-2" },
      route,
      policy: policy(["tenant", "api_key", "route"]),
      ip: "1.1.1.1",
      headers: {}
    });
    expect(base).not.toBe(otherKey);
    expect(base).toContain("tenant-a");
    expect(base).toContain("v3");
  });

  it("uses the custom header as a first-class dimension", () => {
    const one = buildRateLimitKey({
      auth,
      route,
      policy: policy(["tenant", "custom"], "x-user-id"),
      ip: "1.1.1.1",
      headers: { "x-user-id": "user-1" }
    });
    const two = buildRateLimitKey({
      auth,
      route,
      policy: policy(["tenant", "custom"], "x-user-id"),
      ip: "1.1.1.1",
      headers: { "x-user-id": "user-2" }
    });
    expect(one).not.toBe(two);
  });

  it("rejects empty dimension lists", () => {
    expect(validateDimensions([])).toContain("At least one");
  });
});

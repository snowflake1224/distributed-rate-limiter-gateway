import { describe, expect, it } from "vitest";
import { matchRoute, stripPathPrefix } from "../../src/policy/routeMatch.js";
import type { Route } from "../../src/types.js";

function route(partial: Partial<Route> & Pick<Route, "pathPattern" | "method">): Route {
  return {
    id: partial.id ?? partial.pathPattern,
    tenantId: "t1",
    name: partial.pathPattern,
    pathPattern: partial.pathPattern,
    method: partial.method,
    policyId: "p",
    upstreamId: "u",
    timeoutMs: null,
    stripPrefix: null,
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date()
  };
}

describe("route matching", () => {
  it("prefers the most specific pattern", () => {
    const matched = matchRoute(
      [
        route({ pathPattern: "/api/:resource", method: "*" }),
        route({ pathPattern: "/api/orders/:id", method: "GET" }),
        route({ pathPattern: "/api/orders", method: "*" })
      ],
      "GET",
      "/api/orders/99"
    );
    expect(matched?.pathPattern).toBe("/api/orders/:id");
  });

  it("does not match a different tenant's pattern implicitly", () => {
    expect(matchRoute([route({ pathPattern: "/api/orders", method: "POST" })], "GET", "/api/orders")).toBeNull();
  });

  it("strips a configured prefix", () => {
    expect(stripPathPrefix("/api/orders/1", "/api")).toBe("/orders/1");
  });
});

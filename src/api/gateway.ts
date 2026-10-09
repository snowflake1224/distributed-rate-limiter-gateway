import type { NextFunction, Request, Response } from "express";
import { requireClientKey } from "../auth/middleware.js";
import { resolveRouteConfig } from "../cache/configCache.js";
import { HttpError, notFound, serviceUnavailable } from "../errors.js";
import { recordSandboxOutcome, type Outcome } from "../demo/localState.js";
import { logger } from "../logging/logger.js";
import { assertAllowed, evaluateRateLimit } from "../ratelimit/engine.js";
import { buildRateLimitKey } from "../policy/dimensions.js";
import { proxyUpstream } from "../proxy/upstream.js";
import type { RateLimitDecision } from "../types.js";

export function applyRateLimitHeaders(res: Response, decision: RateLimitDecision): void {
  res.setHeader("RateLimit-Limit", String(decision.limit));
  res.setHeader("RateLimit-Remaining", String(Math.max(0, decision.remaining)));
  res.setHeader("RateLimit-Reset", String(decision.resetEpochSeconds));
  if (!decision.allowed) {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000))));
  }
}

function clientIp(req: Request): string {
  const forwarded = req.header("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() || req.ip || "unknown";
  }
  return req.ip || req.socket.remoteAddress || "unknown";
}

async function readBody(req: Request): Promise<Buffer> {
  if (req.method === "GET" || req.method === "HEAD") {
    return Buffer.alloc(0);
  }
  if (Buffer.isBuffer(req.body)) {
    return req.body;
  }
  if (typeof req.body === "string") {
    return Buffer.from(req.body);
  }
  if (req.body && typeof req.body === "object") {
    return Buffer.from(JSON.stringify(req.body));
  }
  return Buffer.alloc(0);
}

function outcomeForError(error: unknown): Outcome {
  if (error instanceof HttpError) {
    if (error.code === "rate_limited") {
      return "rate_limited";
    }
    if (error.code === "service_unavailable" && /circuit open/i.test(error.message)) {
      return "circuit_open";
    }
    if (error.code === "bad_gateway" || error.code === "gateway_timeout") {
      return "upstream_error";
    }
  }
  return "gateway_error";
}

export async function handleGateway(req: Request, res: Response, next: NextFunction): Promise<void> {
  let sandboxTenant: string | null = null;
  let sandboxUpstream: string | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      requireClientKey(req, res, (err) => (err ? reject(err) : resolve()));
    });

    const auth = req.auth;
    if (!auth) {
      throw new Error("Missing auth context");
    }

    let resolved;
    try {
      resolved = await resolveRouteConfig(auth.tenantId, req.method, req.path);
    } catch (error) {
      logger.error({ err: error }, "PostgreSQL unavailable during policy lookup");
      throw serviceUnavailable("Configuration store unavailable", 1);
    }

    if (!resolved) {
      throw notFound("No matching route for this tenant");
    }
    if (auth.tenantSlug.startsWith("sbx-")) {
      sandboxTenant = auth.tenantId;
      sandboxUpstream = resolved.upstream.id;
    }

    const key = buildRateLimitKey({
      auth,
      route: resolved.route,
      policy: resolved.policy,
      ip: clientIp(req),
      headers: req.headers
    });

    const decision = await evaluateRateLimit(resolved.policy, key);
    res.setHeader("x-ratelimit-policy-version", String(resolved.policy.version));
    applyRateLimitHeaders(res, decision);
    assertAllowed(decision, auth.tenantSlug);

    const proxied = await proxyUpstream({
      resolved,
      method: req.method,
      path: req.path,
      query: req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "",
      headers: req.headers,
      body: await readBody(req),
      requestId: String(req.id ?? ""),
      decision
    });

    for (const [header, value] of Object.entries(proxied.headers)) {
      res.setHeader(header, value);
    }
    applyRateLimitHeaders(res, decision);
    if (sandboxTenant) {
      recordSandboxOutcome(sandboxTenant, proxied.statusCode >= 500 ? "upstream_error" : "allowed", sandboxUpstream);
    }
    res.status(proxied.statusCode).send(proxied.body);
  } catch (error) {
    if (sandboxTenant) {
      recordSandboxOutcome(sandboxTenant, outcomeForError(error), sandboxUpstream);
    }
    next(error);
  }
}

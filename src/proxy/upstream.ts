import type { IncomingHttpHeaders } from "node:http";
import { getBreaker } from "../circuitbreaker/breaker.js";
import { badGateway, gatewayTimeout, serviceUnavailable } from "../errors.js";
import { logger } from "../logging/logger.js";
import { upstreamFailuresTotal, upstreamLatencySeconds } from "../metrics/registry.js";
import { stripPathPrefix } from "../policy/routeMatch.js";
import type { RateLimitDecision, ResolvedRoute } from "../types.js";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length"
]);

export interface ProxyResult {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
}

function filterHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!value || HOP_BY_HOP.has(key.toLowerCase())) {
      continue;
    }
    out[key] = Array.isArray(value) ? value.join(",") : value;
  }
  return out;
}

function headerValue(value: string | string[] | undefined): string | string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value;
}

export async function proxyUpstream(input: {
  resolved: ResolvedRoute;
  method: string;
  path: string;
  query: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
  requestId: string;
  decision: RateLimitDecision;
}): Promise<ProxyResult> {
  const { resolved } = input;
  const timeoutMs = resolved.route.timeoutMs ?? resolved.upstream.timeoutMs;
  const breaker = getBreaker({
    name: `${resolved.upstream.tenantId}:${resolved.upstream.id}`,
    failureThreshold: resolved.upstream.cbFailureThreshold,
    recoveryMs: resolved.upstream.cbRecoveryMs,
    halfOpenMaxProbes: resolved.upstream.cbHalfOpenMaxProbes
  });

  if (!breaker.canPass()) {
    upstreamFailuresTotal.inc({ upstream: resolved.upstream.name, reason: "circuit_open" });
    throw serviceUnavailable("Upstream circuit open", Math.ceil(resolved.upstream.cbRecoveryMs / 1000));
  }

  const targetPath = stripPathPrefix(input.path, resolved.route.stripPrefix);
  const url = new URL(targetPath + (input.query || ""), resolved.upstream.baseUrl);
  const headers = filterHeaders(input.headers);
  headers["x-request-id"] = input.requestId;
  headers["x-tenant-id"] = resolved.route.tenantId;
  headers["x-ratelimit-remaining"] = String(input.decision.remaining);

  const started = process.hrtime.bigint();
  try {
    const response = await fetch(url, {
      method: input.method,
      headers,
      body: input.method === "GET" || input.method === "HEAD" ? undefined : new Uint8Array(input.body),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const body = Buffer.from(await response.arrayBuffer());
    const elapsed = Number(process.hrtime.bigint() - started) / 1e9;
    const status = response.status;
    upstreamLatencySeconds.observe({ upstream: resolved.upstream.name, status: String(status) }, elapsed);

    if (status >= 500) {
      breaker.recordFailure();
      upstreamFailuresTotal.inc({ upstream: resolved.upstream.name, reason: "http_5xx" });
    } else {
      breaker.recordSuccess();
    }

    const outHeaders: Record<string, string | string[]> = {};
    response.headers.forEach((value, key) => {
      if (!HOP_BY_HOP.has(key.toLowerCase())) {
        const next = headerValue(value);
        if (next) {
          outHeaders[key] = next;
        }
      }
    });
    return { statusCode: status, headers: outHeaders, body };
  } catch (error) {
    breaker.recordFailure();
    const elapsed = Number(process.hrtime.bigint() - started) / 1e9;
    upstreamLatencySeconds.observe({ upstream: resolved.upstream.name, status: "error" }, elapsed);
    const name = error instanceof Error ? error.name : "Error";
    logger.warn({ err: error, url: url.toString() }, "Upstream request failed");
    if (name === "TimeoutError" || name === "AbortError") {
      upstreamFailuresTotal.inc({ upstream: resolved.upstream.name, reason: "timeout" });
      throw gatewayTimeout();
    }
    upstreamFailuresTotal.inc({ upstream: resolved.upstream.name, reason: "connect" });
    throw badGateway("Upstream connection failed");
  }
}

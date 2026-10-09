import { randomBytes } from "node:crypto";
import { env } from "../config/env.js";
import type { RunInput } from "./schemas.js";

export type RunOutcome =
  | "allowed"
  | "rate_limited"
  | "circuit_open"
  | "upstream_error"
  | "gateway_error"
  | "edge_rejected"
  | "network_error";

export interface RunResultRow {
  seq: number;
  target: string;
  instance: string | null;
  status: number;
  outcome: RunOutcome;
  startedAtMs: number;
  latencyMs: number;
  limit: number | null;
  remaining: number | null;
  reset: number | null;
  retryAfter: number | null;
  policyVersion: number | null;
  requestId: string;
  headers: Record<string, string>;
  body: string;
}

export interface RunResult {
  runId: string;
  startedAt: string;
  durationMs: number;
  targets: string[];
  rows: RunResultRow[];
}

const KEPT_HEADERS = [
  "ratelimit-limit",
  "ratelimit-remaining",
  "ratelimit-reset",
  "retry-after",
  "x-request-id",
  "x-gateway-instance",
  "x-ratelimit-policy-version",
  "x-lab-request-number",
  "content-type"
];

function numberHeader(value: string | null): number | null {
  if (value === null || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function classifyOutcome(status: number, body: string, hasInstanceHeader: boolean): RunOutcome {
  if (!hasInstanceHeader && (status === 429 || status === 503)) {
    return "edge_rejected";
  }
  let code: string | null = null;
  let message = "";
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown; message?: unknown } };
    if (parsed && typeof parsed.error === "object" && parsed.error) {
      code = typeof parsed.error.code === "string" ? parsed.error.code : null;
      message = typeof parsed.error.message === "string" ? parsed.error.message : "";
    }
  } catch {
    code = null;
  }
  if (code === "rate_limited") {
    return "rate_limited";
  }
  if (code === "service_unavailable" && /circuit open/i.test(message)) {
    return "circuit_open";
  }
  if (code) {
    return status >= 500 && (code === "bad_gateway" || code === "gateway_timeout") ? "upstream_error" : "gateway_error";
  }
  if (status >= 500) {
    return "upstream_error";
  }
  return status < 400 ? "allowed" : "gateway_error";
}

export function runTargets(): string[] {
  return env.demoPeerUrls.length > 0 ? env.demoPeerUrls : [`http://127.0.0.1:${env.port}`];
}

export async function runBurst(input: RunInput & { apiKey: string; clientIp: string }): Promise<RunResult> {
  const runId = randomBytes(4).toString("hex");
  const targets = runTargets();
  const rows: RunResultRow[] = new Array(input.count);
  const started = Date.now();
  const startedHr = process.hrtime.bigint();
  let next = 0;

  async function fire(seq: number): Promise<void> {
    const target = targets[seq % targets.length]!;
    const headers: Record<string, string> = {
      ...input.headers,
      "x-api-key": input.apiKey,
      "x-forwarded-for": input.clientIp,
      "x-request-id": `run-${runId}-${seq}`
    };
    if (input.rotateHeader) {
      headers[input.rotateHeader.name] = `user-${seq % input.rotateHeader.values}`;
    }
    if (input.method === "POST") {
      headers["content-type"] = "application/json";
    }
    const sentAt = process.hrtime.bigint();
    const startedAtMs = Number(sentAt - startedHr) / 1e6;
    try {
      const response = await fetch(target + input.path, {
        method: input.method,
        headers,
        body: input.method === "POST" ? input.body ?? "{}" : undefined,
        signal: AbortSignal.timeout(8_000)
      });
      const text = await response.text();
      const latencyMs = Number(process.hrtime.bigint() - sentAt) / 1e6;
      const kept: Record<string, string> = {};
      for (const name of KEPT_HEADERS) {
        const value = response.headers.get(name);
        if (value !== null) {
          kept[name] = value;
        }
      }
      const instance = response.headers.get("x-gateway-instance");
      rows[seq] = {
        seq,
        target,
        instance,
        status: response.status,
        outcome: classifyOutcome(response.status, text, instance !== null),
        startedAtMs: Number(startedAtMs.toFixed(2)),
        latencyMs: Number(latencyMs.toFixed(2)),
        limit: numberHeader(response.headers.get("ratelimit-limit")),
        remaining: numberHeader(response.headers.get("ratelimit-remaining")),
        reset: numberHeader(response.headers.get("ratelimit-reset")),
        retryAfter: numberHeader(response.headers.get("retry-after")),
        policyVersion: numberHeader(response.headers.get("x-ratelimit-policy-version")),
        requestId: response.headers.get("x-request-id") ?? headers["x-request-id"]!,
        headers: kept,
        body: text.slice(0, 600)
      };
    } catch (error) {
      rows[seq] = {
        seq,
        target,
        instance: null,
        status: 0,
        outcome: "network_error",
        startedAtMs: Number(startedAtMs.toFixed(2)),
        latencyMs: Number((Number(process.hrtime.bigint() - sentAt) / 1e6).toFixed(2)),
        limit: null,
        remaining: null,
        reset: null,
        retryAfter: null,
        policyVersion: null,
        requestId: headers["x-request-id"]!,
        headers: {},
        body: error instanceof Error ? error.message : "request failed"
      };
    }
  }

  async function worker(): Promise<void> {
    while (next < input.count) {
      const seq = next;
      next += 1;
      await fire(seq);
    }
  }

  await Promise.all(Array.from({ length: Math.min(input.concurrency, input.count) }, () => worker()));

  return {
    runId,
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    targets,
    rows
  };
}

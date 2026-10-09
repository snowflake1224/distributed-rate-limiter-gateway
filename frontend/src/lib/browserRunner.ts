import { classifyOutcome } from "./classify";
import type { ResultRow, RunConfig } from "./types";

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

export function credentialHeader(config: RunConfig, sandboxKey: string | null): Record<string, string> {
  switch (config.credential) {
    case "sandbox":
      return sandboxKey ? { "x-api-key": sandboxKey } : {};
    case "preset":
      return config.presetKey ? { "x-api-key": config.presetKey } : {};
    case "invalid":
      return { "x-api-key": "gwk_invalid_thiskeydoesnotexist" };
    default:
      return {};
  }
}

export function requestHeadersFor(config: RunConfig, sandboxKey: string | null, seq: number): Record<string, string> {
  const headers: Record<string, string> = { ...config.headers, ...credentialHeader(config, sandboxKey) };
  if (config.rotateHeader) {
    headers[config.rotateHeader.name] = `user-${seq % config.rotateHeader.values}`;
  }
  if (config.method === "POST") {
    headers["content-type"] = "application/json";
  }
  return headers;
}

export interface BrowserRunCallbacks {
  onRow: (row: ResultRow) => void;
  signal: AbortSignal;
}

export async function runInBrowser(
  config: RunConfig,
  sandboxKey: string | null,
  callbacks: BrowserRunCallbacks
): Promise<{ durationMs: number; cancelled: boolean }> {
  const started = performance.now();
  let next = 0;

  async function fire(seq: number): Promise<void> {
    const headers = requestHeadersFor(config, sandboxKey, seq);
    const sentAt = performance.now();
    const base = {
      seq,
      target: window.location.origin,
      startedAtMs: Number((sentAt - started).toFixed(2)),
      sentHeaders: headers,
      dimensionValue: config.rotateHeader ? headers[config.rotateHeader.name] : undefined
    };
    try {
      const response = await fetch(config.path, {
        method: config.method,
        headers,
        body: config.method === "POST" ? config.body || "{}" : undefined,
        signal: callbacks.signal,
        cache: "no-store"
      });
      const text = await response.text();
      const kept: Record<string, string> = {};
      for (const name of KEPT_HEADERS) {
        const value = response.headers.get(name);
        if (value !== null) {
          kept[name] = value;
        }
      }
      const instance = response.headers.get("x-gateway-instance");
      callbacks.onRow({
        ...base,
        instance,
        status: response.status,
        outcome: classifyOutcome(response.status, text, instance !== null),
        latencyMs: Number((performance.now() - sentAt).toFixed(2)),
        limit: numberHeader(response.headers.get("ratelimit-limit")),
        remaining: numberHeader(response.headers.get("ratelimit-remaining")),
        reset: numberHeader(response.headers.get("ratelimit-reset")),
        retryAfter: numberHeader(response.headers.get("retry-after")),
        policyVersion: numberHeader(response.headers.get("x-ratelimit-policy-version")),
        requestId: response.headers.get("x-request-id") ?? "",
        headers: kept,
        body: text.slice(0, 2_000)
      });
    } catch (error) {
      if (callbacks.signal.aborted) {
        return;
      }
      callbacks.onRow({
        ...base,
        instance: null,
        status: 0,
        outcome: "network_error",
        latencyMs: Number((performance.now() - sentAt).toFixed(2)),
        limit: null,
        remaining: null,
        reset: null,
        retryAfter: null,
        policyVersion: null,
        requestId: "",
        headers: {},
        body: error instanceof Error ? error.message : "request failed"
      });
    }
  }

  async function worker(): Promise<void> {
    while (next < config.count && !callbacks.signal.aborted) {
      const seq = next;
      next += 1;
      await fire(seq);
      if (config.intervalMs > 0 && next < config.count && !callbacks.signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, config.intervalMs));
      }
    }
  }

  const workers = Math.max(1, Math.min(config.concurrency, config.count));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return { durationMs: Math.round(performance.now() - started), cancelled: callbacks.signal.aborted };
}

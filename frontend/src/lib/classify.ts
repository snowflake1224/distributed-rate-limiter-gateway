import type { RunOutcome } from "./types";

export function classifyOutcome(status: number, body: string, hasInstanceHeader: boolean): RunOutcome {
  if (status === 0) {
    return "network_error";
  }
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
    return code === "bad_gateway" || code === "gateway_timeout" ? "upstream_error" : "gateway_error";
  }
  if (status >= 500) {
    return "upstream_error";
  }
  return status < 400 ? "allowed" : "gateway_error";
}

export const OUTCOME_LABEL: Record<RunOutcome, string> = {
  allowed: "Allowed",
  rate_limited: "Rate limited (429)",
  circuit_open: "Circuit open (fast fail)",
  upstream_error: "Upstream error",
  gateway_error: "Gateway error",
  edge_rejected: "Rejected at Nginx edge",
  network_error: "Network error"
};

export const OUTCOME_ORDER: RunOutcome[] = [
  "allowed",
  "rate_limited",
  "circuit_open",
  "upstream_error",
  "gateway_error",
  "edge_rejected",
  "network_error"
];

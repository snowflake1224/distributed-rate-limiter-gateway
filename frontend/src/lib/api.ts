import type {
  InstanceState,
  Manifest,
  PolicyConfig,
  ResultRow,
  SandboxSession,
  SandboxView,
  UpstreamConfig
} from "./types";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function call<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (init.token) {
    headers.set("x-sandbox-token", init.token);
  }
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch (error) {
    throw new ApiError(0, "network_error", error instanceof Error ? error.message : "Network error");
  }
  if (response.status === 204) {
    return undefined as T;
  }
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const error = (parsed as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    throw new ApiError(
      response.status,
      error?.code ?? "http_error",
      error?.message ?? `HTTP ${response.status}${text && !parsed ? `: ${text.slice(0, 120)}` : ""}`,
      error?.details
    );
  }
  return parsed as T;
}

export function describeIssues(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return error instanceof Error ? error.message : String(error);
  }
  const issues = (error.details as { issues?: Array<{ path?: unknown[]; message?: string }> } | undefined)?.issues;
  if (Array.isArray(issues) && issues.length > 0) {
    return issues.map((issue) => `${(issue.path ?? []).join(".") || "body"}: ${issue.message ?? "invalid"}`).join("; ");
  }
  return error.message;
}

export const api = {
  manifest: () => call<Manifest>("/demo/v1/manifest"),

  ready: () => call<{ status: string; instance: string; checks: { postgres: boolean; redis: boolean } }>("/health/ready"),

  createSandbox: (policy: PolicyConfig, upstream: UpstreamConfig) =>
    call<SandboxSession>("/demo/v1/sandboxes", {
      method: "POST",
      body: JSON.stringify({ policy, upstream })
    }),

  getSandbox: (session: SandboxSession) =>
    call<{ sandbox: SandboxView; instances: InstanceState[] }>(`/demo/v1/sandboxes/${session.sandbox.id}`, {
      token: session.token
    }),

  patchSandbox: (
    session: SandboxSession,
    body: {
      policy?: Partial<PolicyConfig>;
      upstream?: Partial<UpstreamConfig>;
      restartUpstreamCounter?: boolean;
      resetCircuit?: boolean;
    }
  ) =>
    call<{ sandbox: SandboxView; handledBy: string }>(`/demo/v1/sandboxes/${session.sandbox.id}`, {
      method: "PATCH",
      token: session.token,
      body: JSON.stringify(body)
    }),

  deleteSandbox: (session: SandboxSession) =>
    call<void>(`/demo/v1/sandboxes/${session.sandbox.id}`, { method: "DELETE", token: session.token }),

  serverRun: (
    session: SandboxSession,
    body: {
      method: "GET" | "POST";
      path: string;
      count: number;
      concurrency: number;
      headers: Record<string, string>;
      rotateHeader?: { name: string; values: number };
      body?: string;
    }
  ) =>
    call<{ runId: string; startedAt: string; durationMs: number; targets: string[]; rows: ResultRow[]; handledBy: string }>(
      `/demo/v1/sandboxes/${session.sandbox.id}/runs`,
      {
        method: "POST",
        token: session.token,
        headers: { "x-sandbox-api-key": session.apiKey },
        body: JSON.stringify(body)
      }
    )
};

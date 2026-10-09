import { Router, type NextFunction, type Request, type Response } from "express";
import { env } from "../config/env.js";
import { HttpError, badRequest, notFound } from "../errors.js";
import { logger } from "../logging/logger.js";
import { forgetSandbox, localSandboxState, type LocalSandboxState } from "../demo/localState.js";
import { runBurst, runTargets } from "../demo/runner.js";
import {
  createSandbox,
  deleteSandbox,
  describeSandbox,
  loadSandbox,
  patchSandbox,
  routePrefixFor,
  type SandboxRecord
} from "../demo/sandboxes.js";
import { SANDBOX_BOUNDS, runSchema, sandboxCreateSchema, sandboxPatchSchema } from "../demo/schemas.js";

export const demoRouter = Router();

const activeRuns = new Set<string>();

function parse<T>(
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: { issues: unknown } } },
  body: unknown
): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw badRequest("Validation failed", { issues: result.error.issues });
  }
  return result.data;
}

export function demoClientIp(req: Request): string {
  const forwarded = req.header("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return (first || req.ip || req.socket.remoteAddress || "unknown").slice(0, 64);
}

function requireSandboxEnabled(_req: Request, _res: Response, next: NextFunction): void {
  if (!env.demoSandboxEnabled) {
    next(new HttpError(404, "not_found", "The interactive lab is disabled on this deployment"));
    return;
  }
  next();
}

async function sandboxFromRequest(req: Request): Promise<SandboxRecord> {
  return loadSandbox(String(req.params.id ?? ""), req.header("x-sandbox-token") ?? "");
}

async function fetchPeerStates(req: Request, record: SandboxRecord): Promise<Array<LocalSandboxState | { instance: string; error: string }>> {
  if (env.demoPeerUrls.length === 0) {
    return [localSandboxState(record.tenantId, record.upstreamId)];
  }
  return Promise.all(
    env.demoPeerUrls.map(async (peer) => {
      try {
        const response = await fetch(`${peer}/demo/v1/sandboxes/${record.id}/local`, {
          headers: { "x-sandbox-token": req.header("x-sandbox-token") ?? "" },
          signal: AbortSignal.timeout(800)
        });
        if (!response.ok) {
          return { instance: peer, error: `HTTP ${response.status}` };
        }
        return (await response.json()) as LocalSandboxState;
      } catch (error) {
        return { instance: peer, error: error instanceof Error ? error.message : "unreachable" };
      }
    })
  );
}

async function forgetEverywhere(req: Request, record: SandboxRecord): Promise<void> {
  forgetSandbox(record.tenantId, record.upstreamId);
  await Promise.all(
    env.demoPeerUrls.map((peer) =>
      fetch(`${peer}/demo/v1/sandboxes/${record.id}/forget-local`, {
        method: "POST",
        headers: { "x-sandbox-token": req.header("x-sandbox-token") ?? "" },
        signal: AbortSignal.timeout(800)
      }).catch(() => undefined)
    )
  );
}

demoRouter.get("/manifest", (_req, res) => {
  res.json({
    instance: env.instanceId,
    sandboxEnabled: env.demoSandboxEnabled,
    sandboxTtlMs: env.demoSandboxTtlMs,
    policyCacheTtlMs: env.policyCacheTtlMs,
    apiKeyCacheTtlMs: env.apiKeyCacheTtlMs,
    gatewayInstances: runTargets().length,
    bounds: SANDBOX_BOUNDS,
    edge: { nginxRatePerSecond: 40, nginxBurst: 80 },
    presets: {
      available: Boolean(env.demoPublicAcmeKey),
      acmeKey: env.demoPublicAcmeKey || null,
      globexKey: env.demoPublicGlobexKey || null,
      routes: [
        { path: "/api/orders", tenant: "acme", algorithm: "token_bucket", summary: "burst 20, refill 10/s, per API key" },
        { path: "/api/search", tenant: "acme", algorithm: "sliding_window", summary: "5 per 10s, per X-User-Id" },
        { path: "/api/ip-demo", tenant: "acme", algorithm: "token_bucket", summary: "burst 15, refill 5/s, per client IP" },
        { path: "/api/flaky", tenant: "acme", algorithm: "token_bucket", summary: "fail-open policy, 75% failing upstream" },
        { path: "/api/catalog", tenant: "globex", algorithm: "sliding_window", summary: "20 per 5s, per API key" }
      ]
    }
  });
});

demoRouter.use(requireSandboxEnabled);

demoRouter.post("/sandboxes", async (req, res, next) => {
  try {
    const body = parse(sandboxCreateSchema, req.body);
    const created = await createSandbox(body, demoClientIp(req));
    res.status(201).json({ sandbox: created.view, apiKey: created.apiKey, token: created.token });
  } catch (error) {
    next(error);
  }
});

demoRouter.get("/sandboxes/:id", async (req, res, next) => {
  try {
    const record = await sandboxFromRequest(req);
    const [sandbox, instances] = await Promise.all([describeSandbox(record), fetchPeerStates(req, record)]);
    res.json({ sandbox, instances });
  } catch (error) {
    next(error);
  }
});

demoRouter.get("/sandboxes/:id/local", async (req, res, next) => {
  try {
    const record = await sandboxFromRequest(req);
    res.json(localSandboxState(record.tenantId, record.upstreamId));
  } catch (error) {
    next(error);
  }
});

demoRouter.patch("/sandboxes/:id", async (req, res, next) => {
  try {
    const record = await sandboxFromRequest(req);
    const body = parse(sandboxPatchSchema, req.body);
    const sandbox =
      body.policy || body.upstream || body.restartUpstreamCounter
        ? await patchSandbox(record, body)
        : await describeSandbox(record);
    if (body.resetCircuit) {
      await forgetEverywhere(req, record);
    }
    res.json({ sandbox, handledBy: env.instanceId });
  } catch (error) {
    next(error);
  }
});

demoRouter.delete("/sandboxes/:id", async (req, res, next) => {
  try {
    const record = await sandboxFromRequest(req);
    await forgetEverywhere(req, record);
    await deleteSandbox(record);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

demoRouter.post("/sandboxes/:id/forget-local", async (req, res, next) => {
  try {
    const record = await sandboxFromRequest(req);
    forgetSandbox(record.tenantId, record.upstreamId);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

demoRouter.post("/sandboxes/:id/runs", async (req, res, next) => {
  let runKey = "";
  try {
    const record = await sandboxFromRequest(req);
    const body = parse(runSchema, req.body);
    const apiKey = req.header("x-sandbox-api-key") ?? "";
    if (!apiKey.startsWith("gwk_")) {
      throw badRequest("Send the sandbox API key in X-Sandbox-Api-Key so the runner uses the same credentials you do");
    }
    const prefix = routePrefixFor(record.id);
    if (!body.path.startsWith(`${prefix}/`) || body.path.includes("..")) {
      throw badRequest(`The runner can only target your sandbox route (${prefix}/...)`);
    }
    if (activeRuns.has(record.id)) {
      throw new HttpError(409, "run_in_progress", "A run is already in progress for this sandbox");
    }
    runKey = record.id;
    activeRuns.add(runKey);
    const result = await runBurst({ ...body, apiKey, clientIp: demoClientIp(req) });
    res.json({ ...result, handledBy: env.instanceId });
  } catch (error) {
    if (!(error instanceof HttpError)) {
      logger.error({ err: error }, "Lab run failed");
    }
    next(error);
  } finally {
    if (runKey) {
      activeRuns.delete(runKey);
    }
  }
});

demoRouter.use((_req, _res, next) => {
  next(notFound("Unknown lab endpoint"));
});

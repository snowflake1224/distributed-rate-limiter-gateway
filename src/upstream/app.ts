import express from "express";
import { parseLabPath } from "../demo/labSpec.js";

export type UpstreamMode = "ok" | "flaky" | "slow" | "lab";

export interface UpstreamOptions {
  mode: UpstreamMode;
  delayMs?: number;
  errorRate?: number;
  random?: () => number;
}

const MAX_LAB_COUNTERS = 5_000;

export function createUpstreamApp(options: UpstreamOptions): express.Express {
  const { mode } = options;
  const random = options.random ?? Math.random;
  const labCounters = new Map<string, number>();
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", mode });
  });

  if (mode === "lab") {
    app.all("*", async (req, res) => {
      const parsed = parseLabPath(req.path);
      if (!parsed) {
        res.status(404).json({ error: "unknown lab path", path: req.path });
        return;
      }
      const { spec, rest } = parsed;
      const counterKey = `${spec.sandboxId}:${spec.revision}`;
      const requestNumber = (labCounters.get(counterKey) ?? 0) + 1;
      labCounters.delete(counterKey);
      labCounters.set(counterKey, requestNumber);
      if (labCounters.size > MAX_LAB_COUNTERS) {
        const oldest = labCounters.keys().next().value;
        if (oldest !== undefined) {
          labCounters.delete(oldest);
        }
      }

      if (spec.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, spec.delayMs));
      }
      res.setHeader("x-lab-request-number", String(requestNumber));

      const forcedFailure = requestNumber <= spec.failFirstN;
      const randomFailure = !forcedFailure && spec.failRatePct > 0 && random() * 100 < spec.failRatePct;
      if (forcedFailure || randomFailure) {
        res.status(spec.errorStatus).json({
          error: "lab upstream failure",
          reason: forcedFailure ? `fail-first-${spec.failFirstN}` : `fail-rate-${spec.failRatePct}`,
          requestNumber,
          path: rest
        });
        return;
      }

      res.json({
        upstream: "lab",
        sandbox: spec.sandboxId,
        requestNumber,
        method: req.method,
        path: rest,
        query: req.query,
        delayMs: spec.delayMs,
        requestId: req.header("x-request-id") ?? null,
        echoed: req.body ?? null
      });
    });
    return app;
  }

  app.all("*", async (req, res) => {
    if (mode === "slow") {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 2000));
    }
    if (mode === "flaky") {
      if (random() < (options.errorRate ?? 0.7)) {
        res.status(503).json({ error: "upstream overloaded", path: req.path });
        return;
      }
    }
    res.json({
      upstream: mode,
      method: req.method,
      path: req.path,
      query: req.query,
      tenantId: req.header("x-tenant-id") ?? null,
      requestId: req.header("x-request-id") ?? null,
      echoed: req.body ?? null
    });
  });
  return app;
}

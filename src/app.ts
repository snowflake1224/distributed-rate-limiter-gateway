import express from "express";
import { adminRouter } from "./api/admin.js";
import { demoRouter } from "./api/demo.js";
import { errorHandler } from "./api/errorHandler.js";
import { env } from "./config/env.js";
import { handleGateway } from "./api/gateway.js";
import { healthRouter } from "./health/endpoints.js";
import { httpLogger } from "./logging/logger.js";
import { httpRequestsTotal, registry, requestDurationSeconds } from "./metrics/registry.js";

export function createApp(): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use(express.raw({ type: ["application/octet-stream"], limit: "1mb" }));
  app.use(httpLogger);

  app.use((req, res, next) => {
    req.requestStartedAt = process.hrtime.bigint();
    res.setHeader("x-gateway-instance", env.instanceId);
    const incoming = req.header("x-request-id");
    if (incoming) {
      res.setHeader("x-request-id", incoming);
    } else if (req.id) {
      res.setHeader("x-request-id", String(req.id));
    }
    res.on("finish", () => {
      const group = req.path.startsWith("/admin")
        ? "admin"
        : req.path.startsWith("/demo/v1")
          ? "demo"
          : req.path.startsWith("/health")
          ? "health"
          : req.path === "/metrics"
            ? "metrics"
            : "gateway";
      httpRequestsTotal.inc({
        method: req.method,
        route_group: group,
        status: String(res.statusCode)
      });
      if (req.requestStartedAt) {
        requestDurationSeconds.observe(
          { route_group: group, status: String(res.statusCode) },
          Number(process.hrtime.bigint() - req.requestStartedAt) / 1e9
        );
      }
    });
    next();
  });

  app.use("/health", healthRouter);
  app.get("/metrics", async (_req, res, next) => {
    try {
      res.setHeader("Content-Type", registry.contentType);
      res.end(await registry.metrics());
    } catch (error) {
      next(error);
    }
  });
  app.use("/admin/v1", adminRouter);
  app.use("/demo/v1", demoRouter);
  app.use(handleGateway);
  app.use(errorHandler);
  return app;
}

import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import pino from "pino";
import { env } from "../config/env.js";

export const logger = pino({
  level: env.logLevel,
  base: { service: "distributed-rate-limiter-gateway", instance: env.instanceId },
  timestamp: pino.stdTimeFunctions.isoTime
});

export function getRequestId(req: Request): string {
  const incoming = req.headers["x-request-id"];
  if (typeof incoming === "string" && incoming.length > 0 && incoming.length < 128) {
    return incoming;
  }
  return randomUUID();
}

export function httpLogger(req: Request, res: Response, next: NextFunction): void {
  const requestId = getRequestId(req);
  req.id = requestId;
  const started = process.hrtime.bigint();
  const url = req.url ?? "";
  const quiet = url === "/metrics" || url.startsWith("/health/");

  res.on("finish", () => {
    if (quiet) {
      return;
    }
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
    logger[level]({
      requestId,
      instance: env.instanceId,
      method: req.method,
      url,
      status: res.statusCode,
      durationMs: Number(durationMs.toFixed(2))
    }, "http_request");
  });
  next();
}

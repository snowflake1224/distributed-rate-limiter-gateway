import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { HttpError } from "../errors.js";
import { logger } from "../logging/logger.js";
import { applyRateLimitHeaders } from "./gateway.js";

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: { code: "bad_request", message: "Validation failed", details: err.issues }
    });
    return;
  }

  if (err instanceof HttpError) {
    if (err.retryAfterSeconds) {
      res.setHeader("Retry-After", String(err.retryAfterSeconds));
    }
    if (err.code === "rate_limited" && err.details) {
      applyRateLimitHeaders(res, {
        allowed: false,
        limit: Number(err.details.limit ?? 0),
        remaining: Number(err.details.remaining ?? 0),
        retryAfterMs: (err.retryAfterSeconds ?? 1) * 1000,
        resetEpochSeconds: Number(err.details.reset ?? Math.ceil(Date.now() / 1000)),
        algorithm: "token_bucket",
        key: ""
      });
    }
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
        requestId: req.id
      }
    });
    return;
  }

  logger.error({ err, requestId: req.id }, "Unhandled error");
  res.status(500).json({
    error: { code: "internal_error", message: "Internal server error", requestId: req.id }
  });
}

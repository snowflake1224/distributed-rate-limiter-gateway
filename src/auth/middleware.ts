import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env.js";
import { resolveAuthenticatedKey } from "../cache/configCache.js";
import { forbidden, unauthorized } from "../errors.js";
import { secretsEqual } from "./apiKeys.js";

export function extractClientApiKey(req: Request): string | null {
  const header = req.header("x-api-key");
  if (header) {
    return header.trim();
  }
  const auth = req.header("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  return null;
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  const provided = req.header("x-admin-key") ?? "";
  if (!secretsEqual(provided, env.adminApiKey)) {
    next(unauthorized("Invalid admin key"));
    return;
  }
  next();
}

export async function requireClientKey(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const plaintext = extractClientApiKey(req);
    if (!plaintext) {
      throw unauthorized("Missing API key");
    }
    const auth = await resolveAuthenticatedKey(plaintext);
    if (!auth) {
      throw unauthorized();
    }
    if (auth.tenantStatus !== "active") {
      throw forbidden("Tenant is suspended");
    }
    req.auth = auth;
    next();
  } catch (error) {
    next(error);
  }
}

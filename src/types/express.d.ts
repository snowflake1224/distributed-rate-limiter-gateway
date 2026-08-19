import type { AuthenticatedKey } from "../types.js";

declare global {
  namespace Express {
    interface Request {
      auth?: AuthenticatedKey;
      requestStartedAt?: bigint;
      id?: string;
    }
  }
}

export {};

export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly retryAfterSeconds?: number;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
    retryAfterSeconds?: number
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function badRequest(message: string, details?: Record<string, unknown>): HttpError {
  return new HttpError(400, "bad_request", message, details);
}

export function unauthorized(message = "Invalid API key"): HttpError {
  return new HttpError(401, "unauthorized", message);
}

export function forbidden(message = "Forbidden"): HttpError {
  return new HttpError(403, "forbidden", message);
}

export function notFound(message = "Not found"): HttpError {
  return new HttpError(404, "not_found", message);
}

export function rateLimited(retryAfterSeconds: number, details?: Record<string, unknown>): HttpError {
  return new HttpError(
    429,
    "rate_limited",
    "Rate limit exceeded",
    details,
    retryAfterSeconds
  );
}

export function serviceUnavailable(message: string, retryAfterSeconds = 1): HttpError {
  return new HttpError(503, "service_unavailable", message, undefined, retryAfterSeconds);
}

export function badGateway(message: string): HttpError {
  return new HttpError(502, "bad_gateway", message);
}

export function gatewayTimeout(message = "Upstream timed out"): HttpError {
  return new HttpError(504, "gateway_timeout", message);
}

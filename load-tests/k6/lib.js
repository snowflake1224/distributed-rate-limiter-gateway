export function apiKey() {
  const key = __ENV.API_KEY;
  if (!key) {
    throw new Error("API_KEY is required. Copy it from .local/seed-secrets.json");
  }
  return key;
}

export function baseUrl() {
  return __ENV.BASE_URL || "http://localhost:8080";
}

export function headers() {
  return {
    "X-API-Key": apiKey(),
    "X-User-Id": __ENV.USER_ID || "user-1"
  };
}

export function summarize(data) {
  return {
    "p50 latency": data.metrics.http_req_duration.values["p(50)"],
    "p95 latency": data.metrics.http_req_duration.values["p(95)"],
    "p99 latency": data.metrics.http_req_duration.values["p(99)"],
    throughput: data.metrics.http_reqs.values.rate,
    checks: data.metrics.checks.values.rate
  };
}

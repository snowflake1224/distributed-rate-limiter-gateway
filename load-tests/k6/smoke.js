import http from "k6/http";
import { check, sleep } from "k6";
import { apiKey, baseUrl, headers } from "./lib.js";

export const options = {
  vus: 2,
  duration: "20s",
  thresholds: {
    http_req_failed: ["rate<0.6"],
    http_req_duration: ["p(95)<500"]
  }
};

export default function () {
  const res = http.get(`${baseUrl()}/api/orders`, { headers: headers() });
  check(res, {
    "status is 200 or 429": (r) => r.status === 200 || r.status === 429,
    "has rate limit headers": (r) => Boolean(r.headers["Ratelimit-Limit"] || r.headers["RateLimit-Limit"])
  });
  sleep(0.2);
}

export function setup() {
  return { keyPrefix: apiKey().slice(0, 12) };
}

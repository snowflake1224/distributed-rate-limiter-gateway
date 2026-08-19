import http from "k6/http";
import { check } from "k6";
import { headers } from "./lib.js";

export const options = {
  scenarios: {
    sustained: {
      executor: "constant-arrival-rate",
      rate: Number(__ENV.RATE || 160),
      timeUnit: "1s",
      duration: __ENV.DURATION || "45s",
      preAllocatedVUs: 60,
      maxVUs: 120
    }
  }
};

const BASE = __ENV.BASE_URL || "http://localhost:8080";

export default function () {
  const res = http.get(`${BASE}/api/orders`, { headers: headers() });
  check(res, { "not 5xx": (r) => r.status < 500 });
}

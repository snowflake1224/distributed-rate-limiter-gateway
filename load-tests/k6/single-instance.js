import http from "k6/http";
import { check } from "k6";
import { headers } from "./lib.js";

export const options = {
  scenarios: {
    sustained: {
      executor: "constant-arrival-rate",
      rate: Number(__ENV.RATE || 80),
      timeUnit: "1s",
      duration: __ENV.DURATION || "45s",
      preAllocatedVUs: 40,
      maxVUs: 80
    }
  }
};

const BASE = __ENV.BASE_URL || "http://localhost:3000";

export default function () {
  const res = http.get(`${BASE}/api/orders`, { headers: headers() });
  check(res, { "not 5xx": (r) => r.status < 500 });
}

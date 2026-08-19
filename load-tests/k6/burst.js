import http from "k6/http";
import { check } from "k6";
import { headers } from "./lib.js";

export const options = {
  scenarios: {
    spike: {
      executor: "ramping-arrival-rate",
      startRate: 10,
      timeUnit: "1s",
      preAllocatedVUs: 50,
      maxVUs: 150,
      stages: [
        { target: 20, duration: "5s" },
        { target: 200, duration: "5s" },
        { target: 200, duration: "15s" },
        { target: 20, duration: "5s" }
      ]
    }
  }
};

const BASE = __ENV.BASE_URL || "http://localhost:8080";

export default function () {
  const res = http.get(`${BASE}/api/orders`, { headers: headers() });
  check(res, {
    "controlled": (r) => r.status === 200 || r.status === 429
  });
}

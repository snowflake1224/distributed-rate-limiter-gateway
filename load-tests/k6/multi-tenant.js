import http from "k6/http";
import { check } from "k6";

const BASE = __ENV.BASE_URL || "http://localhost:8080";
const ACME = __ENV.API_KEY;
const GLOBEX = __ENV.GLOBEX_API_KEY;

export const options = {
  vus: 20,
  duration: "30s"
};

export default function () {
  const acme = http.get(`${BASE}/api/orders`, { headers: { "X-API-Key": ACME } });
  const globex = http.get(`${BASE}/api/catalog`, { headers: { "X-API-Key": GLOBEX } });
  check(acme, { "acme isolated": (r) => r.status === 200 || r.status === 429 });
  check(globex, { "globex isolated": (r) => r.status === 200 || r.status === 429 });
}

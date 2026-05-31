// F0-7 / L6 smoke — run with: k6 run load/k6_smoke.js
//
// Hits /internal/library/retrieve at a low rate to validate the stack stays under p95 SLO.
// Real F1/F2 load suites extend this with full pipelines + bandwidth-goal ramps.
import http from "k6/http";
import { check } from "k6";

export const options = {
  vus: 5,
  duration: "30s",
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<500"],
  },
};

const SECRET = __ENV.SERVICE_SHARED_SECRET || "dev-service-secret-change-me";
const BASE = __ENV.ENGINE_BASE_URL || "http://localhost:8000";

export default function () {
  const res = http.post(
    `${BASE}/internal/library/retrieve`,
    JSON.stringify({ user_id: "00000000-0000-0000-0000-000000000000", limit: 5 }),
    { headers: { "content-type": "application/json", "x-service-secret": SECRET } },
  );
  check(res, {
    "200": (r) => r.status === 200,
    "ok body": (r) => r.json("status") === "ok",
  });
}

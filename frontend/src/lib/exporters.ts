import { byStartTime, expectationFor, summarize } from "./analysis";
import type { Run, RunConfig } from "./types";

const CSV_COLUMNS = [
  "seq",
  "startedAtMs",
  "latencyMs",
  "status",
  "outcome",
  "instance",
  "limit",
  "remaining",
  "reset",
  "retryAfter",
  "policyVersion",
  "requestId"
] as const;

function csvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(run: Run): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const row of byStartTime(run.rows)) {
    lines.push(CSV_COLUMNS.map((column) => csvCell(row[column])).join(","));
  }
  return lines.join("\n") + "\n";
}

export function toJson(run: Run): string {
  return JSON.stringify(
    {
      run: { id: run.id, label: run.label, startedAt: run.startedAt, durationMs: run.durationMs, config: run.config },
      policy: run.policy,
      upstream: run.upstream,
      summary: summarize(run.rows),
      expectation: expectationFor(run),
      rows: byStartTime(run.rows)
    },
    null,
    2
  );
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function headerList(config: RunConfig, apiKey: string | null): Array<[string, string]> {
  const headers: Array<[string, string]> = Object.entries(config.headers);
  if (config.credential === "sandbox" && apiKey) {
    headers.push(["x-api-key", apiKey]);
  } else if (config.credential === "preset" && config.presetKey) {
    headers.push(["x-api-key", config.presetKey]);
  } else if (config.credential === "invalid") {
    headers.push(["x-api-key", "gwk_invalid_thiskeydoesnotexist"]);
  }
  return headers;
}

export function toCurl(config: RunConfig, origin: string, apiKey: string | null): string {
  const url = origin + config.path;
  const headers = headerList(config, apiKey)
    .map(([name, value]) => `-H ${shellQuote(`${name}: ${value}`)}`)
    .join(" ");
  const rotate = config.rotateHeader
    ? ` -H "${config.rotateHeader.name}: user-$((i % ${config.rotateHeader.values}))"`
    : "";
  const body = config.method === "POST" ? ` -H 'content-type: application/json' --data ${shellQuote(config.body || "{}")}` : "";
  const single = `curl -s -o /dev/null -w "%{http_code} remaining=%header{ratelimit-remaining} instance=%header{x-gateway-instance}\\n" -X ${config.method} ${headers}${rotate}${body} ${shellQuote(url)}`;
  if (config.count <= 1) {
    return single.replace(/\$\(\(i % \d+\)\)/, "0");
  }
  const sleep = config.intervalMs > 0 ? `; sleep ${(config.intervalMs / 1000).toFixed(3)}` : "";
  return `# curl 7.83+ for %header{}. Sequential version of the run.\nfor i in $(seq 0 ${config.count - 1}); do\n  ${single}${sleep}\ndone`;
}

export function toPowerShell(config: RunConfig, origin: string, apiKey: string | null): string {
  const url = origin + config.path;
  const headerEntries = headerList(config, apiKey).map(([name, value]) => `${psQuote(name)} = ${psQuote(value)}`);
  const rotate = config.rotateHeader
    ? `\n  $headers[${psQuote(config.rotateHeader.name)}] = "user-$($i % ${config.rotateHeader.values})"`
    : "";
  const body =
    config.method === "POST" ? ` -ContentType 'application/json' -Body ${psQuote(config.body || "{}")}` : "";
  const sleep = config.intervalMs > 0 ? `\n  Start-Sleep -Milliseconds ${config.intervalMs}` : "";
  return [
    `# PowerShell 7+. Sequential version of the run.`,
    `for ($i = 0; $i -lt ${Math.max(1, config.count)}; $i++) {`,
    `  $headers = @{ ${headerEntries.join("; ")} }${rotate}`,
    `  $r = Invoke-WebRequest -Uri ${psQuote(url)} -Method ${config.method} -Headers $headers${body} -SkipHttpErrorCheck`,
    `  "{0} remaining={1} instance={2}" -f $r.StatusCode, $r.Headers['RateLimit-Remaining'], $r.Headers['X-Gateway-Instance']${sleep}`,
    `}`
  ].join("\n");
}

export function toK6(config: RunConfig, origin: string, apiKey: string | null): string {
  const headers = Object.fromEntries(headerList(config, apiKey));
  const rotate = config.rotateHeader
    ? `\n  headers[${JSON.stringify(config.rotateHeader.name)}] = \`user-\${__ITER % ${config.rotateHeader.values}}\`;`
    : "";
  const vus = Math.max(1, Math.min(config.concurrency, config.count));
  return `import http from "k6/http";
import { check } from "k6";

// Same shape as the lab run: ${config.count} requests, ${vus} at a time.
export const options = {
  scenarios: {
    lab: { executor: "shared-iterations", vus: ${vus}, iterations: ${config.count}, maxDuration: "60s" }
  }
};

const url = ${JSON.stringify(origin + config.path)};

export default function () {
  const headers = ${JSON.stringify(headers, null, 2).replace(/\n/g, "\n  ")};${rotate}
  const res = http.request(${JSON.stringify(config.method)}, url, ${config.method === "POST" ? JSON.stringify(config.body || "{}") : "null"}, { headers });
  check(res, {
    "allowed or rate limited": (r) => r.status === 200 || r.status === 429
  });
}
`;
}

export function downloadText(filename: string, text: string, type: string): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

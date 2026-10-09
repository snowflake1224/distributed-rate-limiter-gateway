import { useMemo, useState } from "react";
import { byStartTime, expectationFor, summarize, type Expectation, type RunSummary } from "../lib/analysis";
import { OUTCOME_LABEL, OUTCOME_ORDER } from "../lib/classify";
import { downloadText, toCsv, toCurl, toJson, toK6, toPowerShell } from "../lib/exporters";
import type { ResultRow, Run, RunOutcome } from "../lib/types";
import { InstanceSplit, LatencyHistogram, OutcomeTimeline, RemainingChart, outcomeClass } from "./Charts";
import { CopyButton, Section } from "./fields";

function Stat(props: { label: string; value: string | number; hint?: string; tone?: "good" | "bad" | "neutral" }) {
  return (
    <div className={`stat ${props.tone ? `stat-${props.tone}` : ""}`}>
      <span className="stat-value">{props.value}</span>
      <span className="stat-label">{props.label}</span>
      {props.hint ? <span className="stat-hint">{props.hint}</span> : null}
    </div>
  );
}

function SummaryGrid(props: { summary: RunSummary; run: Run }) {
  const { summary, run } = props;
  const rate =
    run.policy?.algorithm === "token_bucket"
      ? `${run.policy.refillRatePerSec}/s configured`
      : run.policy
        ? `${(run.policy.limitCount / (run.policy.windowMs / 1000)).toFixed(2)}/s configured`
        : undefined;
  return (
    <div className="stats">
      <Stat label="Requests" value={summary.total} hint={`${(summary.elapsedSec || 0).toFixed(2)} s`} />
      <Stat label="Allowed" value={summary.outcomes.allowed} tone="good" />
      <Stat label="Rate limited (429)" value={summary.outcomes.rate_limited} tone={summary.outcomes.rate_limited > 0 ? "bad" : "neutral"} />
      <Stat label="5xx / fast-fail" value={summary.outcomes.upstream_error + summary.outcomes.circuit_open} />
      <Stat label="First 429 at" value={summary.firstRateLimitedSeq === null ? "–" : `#${summary.firstRateLimitedSeq}`} />
      <Stat label="p50 / p95" value={`${summary.latency.p50.toFixed(0)} / ${summary.latency.p95.toFixed(0)} ms`} hint={`p99 ${summary.latency.p99.toFixed(0)} ms`} />
      <Stat label="Allowed per second" value={summary.observedAllowedPerSec.toFixed(2)} hint={rate} />
      <Stat label="Policy versions seen" value={summary.policyVersions.length ? summary.policyVersions.map((v) => `v${v}`).join(", ") : "–"} />
    </div>
  );
}

function ExpectationBox(props: { expectation: Expectation }) {
  const e = props.expectation;
  if (!e.applicable) {
    return <p className="hint">{e.reason}</p>;
  }
  const verdictText = {
    match: "Matches the model exactly",
    within_tolerance: "Within tolerance",
    deviation: "Deviates from the model",
    not_applicable: "Not applicable"
  }[e.verdict];
  return (
    <div className={`expectation verdict-${e.verdict}`}>
      <div className="expectation-head">
        <div>
          <span className="expectation-verdict">{verdictText}</span>
          <p className="hint">{e.model}</p>
        </div>
        <div className="expectation-numbers">
          <div>
            <span className="big">{e.expectedAllowed}</span>
            <span className="hint">expected to pass</span>
          </div>
          <div>
            <span className="big">{e.observedAllowed}</span>
            <span className="hint">actually passed</span>
          </div>
          <div>
            <span className="big">{e.difference > 0 ? `+${e.difference}` : e.difference}</span>
            <span className="hint">difference (±{e.tolerance} ok)</span>
          </div>
        </div>
      </div>
      {e.groups.length > 1 ? (
        <table className="data-table compact">
          <thead>
            <tr>
              <th scope="col">Quota key</th>
              <th scope="col">Requests</th>
              <th scope="col">Start tokens</th>
              <th scope="col">Expected</th>
              <th scope="col">Observed</th>
            </tr>
          </thead>
          <tbody>
            {e.groups.map((g) => (
              <tr key={g.key}>
                <td className="mono">{g.key}</td>
                <td className="num">{g.requests}</td>
                <td className="num">{g.startTokens ?? "–"}</td>
                <td className="num">{g.expectedAllowed}</td>
                <td className="num">{g.observedAllowed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {e.naivePerInstanceAllowed !== null ? (
        <p className="callout">
          Requests were served by more than one instance. If each instance kept its own in-memory counter, up to{" "}
          <strong>{e.naivePerInstanceAllowed}</strong> could have passed. Redis kept the total at <strong>{e.observedAllowed}</strong>.
        </p>
      ) : null}
      <ul className="notes">
        {e.notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </div>
  );
}

function Inspector(props: { row: ResultRow; onClose: () => void }) {
  const { row } = props;
  let pretty = row.body;
  try {
    pretty = JSON.stringify(JSON.parse(row.body), null, 2);
  } catch {
    pretty = row.body;
  }
  return (
    <div className="inspector" role="dialog" aria-label={`Request ${row.seq} details`}>
      <div className="inspector-head">
        <h3>
          Request #{row.seq} · <span className={outcomeClass(row.outcome)}>{OUTCOME_LABEL[row.outcome]}</span>
        </h3>
        <button type="button" className="btn btn-ghost btn-small" onClick={props.onClose}>
          Close
        </button>
      </div>
      <div className="inspector-grid">
        <div>
          <h4>Response headers</h4>
          <dl className="kv">
            <dt>status</dt>
            <dd className="mono">{row.status || "no response"}</dd>
            {Object.entries(row.headers).map(([name, value]) => (
              <div key={name} className="kv-row">
                <dt className="mono">{name}</dt>
                <dd className="mono">{value}</dd>
              </div>
            ))}
          </dl>
          {row.sentHeaders ? (
            <>
              <h4>Sent headers</h4>
              <dl className="kv">
                {Object.entries(row.sentHeaders).map(([name, value]) => (
                  <div key={name} className="kv-row">
                    <dt className="mono">{name}</dt>
                    <dd className="mono">{name === "x-api-key" ? `${value.slice(0, 14)}…` : value}</dd>
                  </div>
                ))}
              </dl>
            </>
          ) : null}
        </div>
        <div>
          <h4>Body</h4>
          <pre className="code">{pretty || "(empty)"}</pre>
        </div>
      </div>
    </div>
  );
}

function ExportBar(props: { run: Run; apiKey: string | null }) {
  const origin = window.location.origin;
  const [snippet, setSnippet] = useState<"curl" | "powershell" | "k6" | null>(null);
  const text =
    snippet === "curl"
      ? toCurl(props.run.config, origin, props.apiKey)
      : snippet === "powershell"
        ? toPowerShell(props.run.config, origin, props.apiKey)
        : snippet === "k6"
          ? toK6(props.run.config, origin, props.apiKey)
          : "";
  return (
    <div className="export">
      <div className="button-row">
        <span className="label">Verify it yourself</span>
        <button type="button" className={`btn btn-small ${snippet === "curl" ? "active" : ""}`} onClick={() => setSnippet(snippet === "curl" ? null : "curl")}>
          curl
        </button>
        <button type="button" className={`btn btn-small ${snippet === "powershell" ? "active" : ""}`} onClick={() => setSnippet(snippet === "powershell" ? null : "powershell")}>
          PowerShell
        </button>
        <button type="button" className={`btn btn-small ${snippet === "k6" ? "active" : ""}`} onClick={() => setSnippet(snippet === "k6" ? null : "k6")}>
          k6
        </button>
        <span className="spacer" />
        <button type="button" className="btn btn-small" onClick={() => downloadText(`${props.run.id}.json`, toJson(props.run), "application/json")}>
          Download JSON
        </button>
        <button type="button" className="btn btn-small" onClick={() => downloadText(`${props.run.id}.csv`, toCsv(props.run), "text/csv")}>
          Download CSV
        </button>
      </div>
      {snippet ? (
        <div className="snippet">
          <div className="snippet-head">
            <span className="hint">
              Uses your real sandbox key against this deployment. Run it from your own terminal and compare the status codes.
            </span>
            <CopyButton text={text} />
          </div>
          <pre className="code">{text}</pre>
        </div>
      ) : null}
    </div>
  );
}

function CompareTable(props: { a: Run; b: Run }) {
  const sa = summarize(props.a.rows);
  const sb = summarize(props.b.rows);
  const ea = expectationFor(props.a);
  const eb = expectationFor(props.b);
  const policyText = (run: Run) =>
    run.policy
      ? run.policy.algorithm === "token_bucket"
        ? `TB ${run.policy.burstCapacity} @ ${run.policy.refillRatePerSec}/s · v${run.policy.version}`
        : `SW ${run.policy.limitCount} / ${run.policy.windowMs / 1000}s · v${run.policy.version}`
      : "seeded / none";
  const rows: Array<[string, string | number, string | number]> = [
    ["Policy", policyText(props.a), policyText(props.b)],
    ["Requests", sa.total, sb.total],
    ["Allowed", sa.outcomes.allowed, sb.outcomes.allowed],
    ["Rate limited", sa.outcomes.rate_limited, sb.outcomes.rate_limited],
    ["Upstream errors", sa.outcomes.upstream_error, sb.outcomes.upstream_error],
    ["Fast-fail (circuit open)", sa.outcomes.circuit_open, sb.outcomes.circuit_open],
    ["Expected to pass", ea.applicable ? ea.expectedAllowed : "–", eb.applicable ? eb.expectedAllowed : "–"],
    ["p95 latency (ms)", sa.latency.p95.toFixed(0), sb.latency.p95.toFixed(0)],
    ["Duration (s)", sa.elapsedSec.toFixed(2), sb.elapsedSec.toFixed(2)]
  ];
  return (
    <table className="data-table compact compare">
      <thead>
        <tr>
          <th scope="col">Metric</th>
          <th scope="col">{props.a.label}</th>
          <th scope="col">{props.b.label}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, va, vb]) => (
          <tr key={label}>
            <th scope="row">{label}</th>
            <td className="num">{va}</td>
            <td className="num">{vb}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ResultsPanel(props: {
  runs: Run[];
  selectedRun: Run | null;
  onSelect: (id: string) => void;
  onClear: () => void;
  apiKey: string | null;
}) {
  const run = props.selectedRun;
  const [outcomeFilter, setOutcomeFilter] = useState<RunOutcome | "all">("all");
  const [instanceFilter, setInstanceFilter] = useState<string>("all");
  const [inspected, setInspected] = useState<number | null>(null);
  const [compareId, setCompareId] = useState<string>("");

  const ordered = useMemo(() => (run ? byStartTime(run.rows) : []), [run]);
  const summary = useMemo(() => (run ? summarize(run.rows) : null), [run]);
  const expectation = useMemo(() => (run ? expectationFor(run) : null), [run]);
  const instances = useMemo(() => [...new Set(ordered.map((r) => r.instance ?? "none"))].sort(), [ordered]);
  const filtered = ordered.filter(
    (r) => (outcomeFilter === "all" || r.outcome === outcomeFilter) && (instanceFilter === "all" || (r.instance ?? "none") === instanceFilter)
  );
  const inspectedRow = inspected === null ? null : ordered.find((r) => r.seq === inspected) ?? null;
  const compareRun = props.runs.find((r) => r.id === compareId && r.id !== run?.id) ?? null;

  if (!run || !summary || !expectation) {
    return (
      <Section title="3. Results and analysis" subtitle="Runs appear here with every request, its headers and body, and an expected-versus-observed check.">
        <p className="empty">No runs yet. Create a sandbox and send some traffic, or start a guided experiment above.</p>
      </Section>
    );
  }

  return (
    <Section
      title="3. Results and analysis"
      subtitle={`${run.label} · started ${new Date(run.startedAt).toLocaleTimeString()}${run.cancelled ? " · stopped early" : ""}`}
      actions={
        <>
          <label className="inline-select">
            <span className="label">Run</span>
            <select value={run.id} onChange={(e) => props.onSelect(e.target.value)}>
              {props.runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <label className="inline-select">
            <span className="label">Compare with</span>
            <select value={compareId} onChange={(e) => setCompareId(e.target.value)}>
              <option value="">–</option>
              {props.runs
                .filter((r) => r.id !== run.id)
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
            </select>
          </label>
          <button type="button" className="btn btn-ghost btn-small" onClick={props.onClear}>
            Clear runs
          </button>
        </>
      }
    >
      {run.error ? (
        <div className="banner banner-error" role="alert">
          {run.error}
        </div>
      ) : null}

      <SummaryGrid summary={summary} run={run} />

      <h3 className="subhead">Expected vs observed</h3>
      <ExpectationBox expectation={expectation} />

      {compareRun ? (
        <>
          <h3 className="subhead">Comparison</h3>
          <CompareTable a={run} b={compareRun} />
        </>
      ) : null}

      <div className="charts">
        <OutcomeTimeline rows={run.rows} />
        <RemainingChart
          rows={run.rows}
          capacity={run.policy ? (run.policy.algorithm === "token_bucket" ? run.policy.burstCapacity : run.policy.limitCount) : null}
        />
        <LatencyHistogram rows={run.rows} />
        <InstanceSplit byInstance={summary.byInstance} />
      </div>

      <ExportBar run={run} apiKey={props.apiKey} />

      <div className="table-toolbar">
        <h3 className="subhead">Every request</h3>
        <label className="inline-select">
          <span className="label">Outcome</span>
          <select value={outcomeFilter} onChange={(e) => setOutcomeFilter(e.target.value as RunOutcome | "all")}>
            <option value="all">All ({ordered.length})</option>
            {OUTCOME_ORDER.filter((o) => summary.outcomes[o] > 0).map((o) => (
              <option key={o} value={o}>
                {OUTCOME_LABEL[o]} ({summary.outcomes[o]})
              </option>
            ))}
          </select>
        </label>
        <label className="inline-select">
          <span className="label">Instance</span>
          <select value={instanceFilter} onChange={(e) => setInstanceFilter(e.target.value)}>
            <option value="all">All</option>
            {instances.map((i) => (
              <option key={i} value={i}>
                {i}
              </option>
            ))}
          </select>
        </label>
      </div>

      {inspectedRow ? <Inspector row={inspectedRow} onClose={() => setInspected(null)} /> : null}

      <div className="table-wrap tall">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Sent at</th>
              <th scope="col">Latency</th>
              <th scope="col">Status</th>
              <th scope="col">Outcome</th>
              <th scope="col">Instance</th>
              <th scope="col">Remaining</th>
              <th scope="col">Retry-After</th>
              <th scope="col">Policy</th>
              <th scope="col">Request ID</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => (
              <tr
                key={row.seq}
                className={inspected === row.seq ? "selected" : undefined}
                tabIndex={0}
                onClick={() => setInspected(row.seq)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setInspected(row.seq);
                  }
                }}
              >
                <td className="num">{row.seq}</td>
                <td className="num">{(row.startedAtMs / 1000).toFixed(3)}s</td>
                <td className="num">{row.latencyMs.toFixed(1)} ms</td>
                <td className="num">{row.status || "–"}</td>
                <td>
                  <span className={outcomeClass(row.outcome)}>{OUTCOME_LABEL[row.outcome]}</span>
                </td>
                <td className="mono">{row.instance ?? "–"}</td>
                <td className="num">
                  {row.remaining ?? "–"}
                  {row.limit !== null ? <span className="hint">/{row.limit}</span> : null}
                </td>
                <td className="num">{row.retryAfter !== null ? `${row.retryAfter}s` : "–"}</td>
                <td className="num">{row.policyVersion !== null ? `v${row.policyVersion}` : "–"}</td>
                <td className="mono small truncate">{row.requestId || "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

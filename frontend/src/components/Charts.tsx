import { useMemo } from "react";
import { byStartTime } from "../lib/analysis";
import { OUTCOME_LABEL, OUTCOME_ORDER } from "../lib/classify";
import type { ResultRow, RunOutcome } from "../lib/types";

const W = 560;
const H = 180;
const PAD = { top: 12, right: 12, bottom: 32, left: 44 };
const INSTANCE_CLASSES = ["series-a", "series-b", "series-c", "series-d"];

function niceMax(value: number): number {
  if (value <= 0) {
    return 1;
  }
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

function Axes(props: { xMax: number; yMax: number; xLabel: string; yLabel: string; yTicks?: number[] }) {
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const yTicks = props.yTicks ?? [0, props.yMax / 2, props.yMax];
  const xTicks = [0, props.xMax / 2, props.xMax];
  return (
    <g className="axes">
      <line x1={PAD.left} y1={PAD.top + innerH} x2={PAD.left + innerW} y2={PAD.top + innerH} />
      <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={PAD.top + innerH} />
      {yTicks.map((tick) => {
        const y = PAD.top + innerH - (tick / props.yMax) * innerH;
        return (
          <g key={`y${tick}`}>
            <line className="grid" x1={PAD.left} x2={PAD.left + innerW} y1={y} y2={y} />
            <text x={PAD.left - 6} y={y + 4} textAnchor="end">
              {Number.isInteger(tick) ? tick : tick.toFixed(1)}
            </text>
          </g>
        );
      })}
      {xTicks.map((tick) => (
        <text key={`x${tick}`} x={PAD.left + (tick / props.xMax) * innerW} y={H - 16} textAnchor="middle">
          {tick >= 10 ? Math.round(tick) : tick.toFixed(1)}
        </text>
      ))}
      <text x={PAD.left + innerW / 2} y={H - 2} textAnchor="middle" className="axis-label">
        {props.xLabel}
      </text>
      <text x={10} y={PAD.top + innerH / 2} textAnchor="middle" className="axis-label" transform={`rotate(-90 10 ${PAD.top + innerH / 2})`}>
        {props.yLabel}
      </text>
    </g>
  );
}

function instanceClassMap(rows: ResultRow[]): Map<string, string> {
  const names = [...new Set(rows.map((r) => r.instance ?? "edge"))].sort();
  return new Map(names.map((name, i) => [name, INSTANCE_CLASSES[i % INSTANCE_CLASSES.length]!]));
}

export function OutcomeTimeline(props: { rows: ResultRow[] }) {
  const rows = useMemo(() => byStartTime(props.rows), [props.rows]);
  const present = OUTCOME_ORDER.filter((o) => rows.some((r) => r.outcome === o));
  const xMax = Math.max(0.1, ...rows.map((r) => r.startedAtMs / 1000));
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const band = innerH / Math.max(1, present.length);
  return (
    <figure className="chart">
      <figcaption>Outcome of each request over time</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Scatter plot of request outcomes by send time">
        <Axes xMax={xMax} yMax={1} yTicks={[]} xLabel="Seconds since first request" yLabel="" />
        {present.map((outcome, i) => (
          <text key={outcome} x={PAD.left + 6} y={PAD.top + band * i + 12} className="band-label">
            {OUTCOME_LABEL[outcome]}
          </text>
        ))}
        {rows.map((row) => {
          const bandIndex = present.indexOf(row.outcome);
          return (
            <circle
              key={row.seq}
              className={`dot-${row.outcome}`}
              cx={PAD.left + (row.startedAtMs / 1000 / xMax) * innerW}
              cy={PAD.top + band * bandIndex + band / 2 + 4}
              r={3.5}
            >
              <title>
                #{row.seq} · {row.status} · {row.instance ?? "no instance"} · {row.latencyMs} ms
              </title>
            </circle>
          );
        })}
      </svg>
    </figure>
  );
}

export function RemainingChart(props: { rows: ResultRow[]; capacity: number | null }) {
  const rows = useMemo(() => byStartTime(props.rows).filter((r) => r.remaining !== null && r.remaining >= 0), [props.rows]);
  if (rows.length === 0) {
    return null;
  }
  const classes = instanceClassMap(rows);
  const xMax = Math.max(0.1, ...rows.map((r) => r.startedAtMs / 1000));
  const yMax = niceMax(Math.max(props.capacity ?? 0, ...rows.map((r) => r.remaining ?? 0)));
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const point = (r: ResultRow) => ({
    x: PAD.left + (r.startedAtMs / 1000 / xMax) * innerW,
    y: PAD.top + innerH - ((r.remaining ?? 0) / yMax) * innerH
  });
  const path = rows.map((r, i) => `${i === 0 ? "M" : "L"}${point(r).x.toFixed(1)},${point(r).y.toFixed(1)}`).join(" ");
  return (
    <figure className="chart">
      <figcaption>RateLimit-Remaining reported by each response</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Line chart of remaining quota over time">
        <Axes xMax={xMax} yMax={yMax} xLabel="Seconds since first request" yLabel="Remaining" />
        <path d={path} className="line-remaining" />
        {rows.map((r) => (
          <circle key={r.seq} className={classes.get(r.instance ?? "edge")} cx={point(r).x} cy={point(r).y} r={3}>
            <title>
              #{r.seq} · remaining {r.remaining} · {r.instance}
            </title>
          </circle>
        ))}
      </svg>
      <Legend classes={classes} />
      <p className="chart-note">One line through both instances: the count keeps going down across gateways because the state lives in Redis.</p>
    </figure>
  );
}

function Legend(props: { classes: Map<string, string> }) {
  return (
    <div className="legend">
      {[...props.classes.entries()].map(([name, cls]) => (
        <span key={name} className="legend-item">
          <svg width="10" height="10" aria-hidden="true">
            <circle className={cls} cx="5" cy="5" r="4" />
          </svg>
          {name}
        </span>
      ))}
    </div>
  );
}

export function LatencyHistogram(props: { rows: ResultRow[] }) {
  const latencies = props.rows.filter((r) => r.status !== 0).map((r) => r.latencyMs);
  if (latencies.length === 0) {
    return null;
  }
  const max = Math.max(...latencies);
  const buckets = 12;
  const size = niceMax(max) / buckets || 1;
  const counts = Array.from({ length: buckets }, () => 0);
  for (const latency of latencies) {
    counts[Math.min(buckets - 1, Math.floor(latency / size))] += 1;
  }
  const yMax = niceMax(Math.max(...counts));
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const barW = innerW / buckets;
  return (
    <figure className="chart">
      <figcaption>Latency distribution (client-measured)</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Histogram of request latency">
        <Axes xMax={size * buckets} yMax={yMax} xLabel="Latency (ms)" yLabel="Requests" />
        {counts.map((count, i) => (
          <rect
            key={i}
            className="bar"
            x={PAD.left + i * barW + 1}
            width={Math.max(1, barW - 2)}
            y={PAD.top + innerH - (count / yMax) * innerH}
            height={(count / yMax) * innerH}
          >
            <title>
              {Math.round(i * size)}–{Math.round((i + 1) * size)} ms: {count}
            </title>
          </rect>
        ))}
      </svg>
    </figure>
  );
}

export function InstanceSplit(props: { byInstance: Array<{ instance: string; total: number; allowed: number }> }) {
  const total = props.byInstance.reduce((sum, i) => sum + i.total, 0);
  if (total === 0) {
    return null;
  }
  return (
    <figure className="chart">
      <figcaption>Which gateway instance answered</figcaption>
      <div className="split-bars">
        {props.byInstance.map((entry, i) => (
          <div key={entry.instance} className="split-row">
            <span className="mono split-name">{entry.instance}</span>
            <span className="split-track">
              <span className={`split-fill ${INSTANCE_CLASSES[i % INSTANCE_CLASSES.length]}`} style={{ width: `${(entry.total / total) * 100}%` }} />
            </span>
            <span className="num">
              {entry.total} ({entry.allowed} allowed)
            </span>
          </div>
        ))}
      </div>
    </figure>
  );
}

export function outcomeClass(outcome: RunOutcome): string {
  return `tag tag-${outcome}`;
}

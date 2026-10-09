import { summarize } from "../lib/analysis";
import type { Run } from "../lib/types";

interface Stage {
  id: string;
  title: string;
  detail: string;
  stopped: number;
  stoppedLabel: string;
}

export function ArchitectureFlow(props: { run: Run | null; instanceCount: number }) {
  const summary = props.run ? summarize(props.run.rows) : null;
  const o = summary?.outcomes;
  const stages: Stage[] = [
    {
      id: "edge",
      title: "Nginx",
      detail: "least_conn load balancing, per-IP limit_req",
      stopped: o?.edge_rejected ?? 0,
      stoppedLabel: "rejected at edge"
    },
    {
      id: "gateway",
      title: `Gateway × ${props.instanceCount}`,
      detail: "API-key auth, route + policy from cached PostgreSQL config",
      stopped: o?.gateway_error ?? 0,
      stoppedLabel: "auth / route / config errors"
    },
    {
      id: "redis",
      title: "Redis Lua",
      detail: "one atomic script decides allow or deny for every instance",
      stopped: o?.rate_limited ?? 0,
      stoppedLabel: "rate limited (429)"
    },
    {
      id: "breaker",
      title: "Circuit breaker",
      detail: "per instance, per upstream",
      stopped: o?.circuit_open ?? 0,
      stoppedLabel: "failed fast (open)"
    },
    {
      id: "upstream",
      title: "Upstream",
      detail: "your programmable mock service",
      stopped: o?.upstream_error ?? 0,
      stoppedLabel: "upstream errors"
    }
  ];

  return (
    <section className="flow" aria-label="Request path">
      <div className="flow-head">
        <h2>Where requests went</h2>
        <p className="section-subtitle">
          {props.run
            ? `Selected run: ${props.run.label}. ${o?.allowed ?? 0} of ${summary?.total ?? 0} reached the upstream successfully.`
            : "Send traffic to see how many requests each layer stopped."}
        </p>
      </div>
      <ol className="flow-stages">
        {stages.map((stage) => (
          <li key={stage.id} className={`flow-stage ${stage.stopped > 0 ? "has-stops" : ""}`}>
            <span className="flow-title">{stage.title}</span>
            <span className="flow-detail">{stage.detail}</span>
            {props.run ? (
              <span className="flow-count">
                <strong>{stage.stopped}</strong> {stage.stoppedLabel}
              </span>
            ) : null}
          </li>
        ))}
        <li className="flow-stage flow-final">
          <span className="flow-title">Response</span>
          <span className="flow-detail">RateLimit-* headers, X-Gateway-Instance, X-Request-ID</span>
          {props.run ? (
            <span className="flow-count">
              <strong>{o?.allowed ?? 0}</strong> successful
            </span>
          ) : null}
        </li>
      </ol>
    </section>
  );
}

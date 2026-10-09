import type { InstanceState, SandboxSession } from "../lib/types";
import { Section } from "./fields";

const STATE_LABEL = { closed: "Closed", open: "Open", half_open: "Half-open" } as const;

export function SystemState(props: {
  session: SandboxSession | null;
  instances: InstanceState[];
  ready: { postgres: boolean; redis: boolean; instance: string } | null;
  lastUpdated: number | null;
  activity: Array<{ at: number; text: string }>;
}) {
  const currentVersion = props.session?.sandbox.policy.version ?? null;
  return (
    <Section
      title="Live system state"
      subtitle={
        props.lastUpdated
          ? `Polled from every gateway instance · updated ${new Date(props.lastUpdated).toLocaleTimeString()}`
          : "Polled from every gateway instance once a sandbox exists."
      }
      className="system-state"
    >
      <div className="health-row">
        <span className={`pill ${props.ready?.postgres ? "pill-ok" : "pill-bad"}`}>PostgreSQL {props.ready ? (props.ready.postgres ? "up" : "down") : "…"}</span>
        <span className={`pill ${props.ready?.redis ? "pill-ok" : "pill-bad"}`}>Redis {props.ready ? (props.ready.redis ? "up" : "down") : "…"}</span>
        {props.ready ? <span className="hint">readiness answered by {props.ready.instance}</span> : null}
      </div>

      {props.session && props.instances.length > 0 ? (
        <div className="table-wrap">
          <table className="data-table compact">
            <thead>
              <tr>
                <th scope="col">Instance</th>
                <th scope="col">Breaker</th>
                <th scope="col">Failures</th>
                <th scope="col">Cached policy</th>
                <th scope="col">Allowed</th>
                <th scope="col">429</th>
                <th scope="col">Upstream err</th>
                <th scope="col">Fast-fail</th>
              </tr>
            </thead>
            <tbody>
              {props.instances.map((instance) => {
                if (instance.error) {
                  return (
                    <tr key={instance.instance}>
                      <td className="mono">{instance.instance}</td>
                      <td colSpan={7} className="error-text">
                        Unreachable: {instance.error}
                      </td>
                    </tr>
                  );
                }
                const breaker = instance.breaker;
                const cached = instance.cachedPolicyVersions ?? [];
                const stale = cached.some((c) => currentVersion !== null && c.policyVersion !== currentVersion);
                return (
                  <tr key={instance.instance}>
                    <td className="mono">{instance.instance}</td>
                    <td>
                      <span className={`state state-${breaker?.state ?? "closed"}`}>{STATE_LABEL[breaker?.state ?? "closed"]}</span>
                      {breaker?.state === "open" ? <span className="hint"> · probe in {(breaker.retryInMs / 1000).toFixed(1)}s</span> : null}
                    </td>
                    <td className="num">
                      {breaker ? `${breaker.consecutiveFailures}/${breaker.failureThreshold}` : "–"}
                    </td>
                    <td className={stale ? "warn-text" : undefined}>
                      {cached.length === 0
                        ? "not cached"
                        : cached.map((c) => `v${c.policyVersion} (${(c.expiresInMs / 1000).toFixed(1)}s left)`).join(", ")}
                      {stale ? " · stale" : ""}
                    </td>
                    <td className="num">{instance.counts?.allowed ?? 0}</td>
                    <td className="num">{instance.counts?.rate_limited ?? 0}</td>
                    <td className="num">{instance.counts?.upstream_error ?? 0}</td>
                    <td className="num">{instance.counts?.circuit_open ?? 0}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="hint">Create a sandbox to see per-instance breaker state, cached policy versions and decision counts.</p>
      )}

      {props.activity.length > 0 ? (
        <>
          <h3 className="subhead">Control-plane activity</h3>
          <ol className="activity">
            {props.activity.slice(0, 8).map((entry) => (
              <li key={`${entry.at}-${entry.text}`}>
                <time className="mono">{new Date(entry.at).toLocaleTimeString()}</time> {entry.text}
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </Section>
  );
}

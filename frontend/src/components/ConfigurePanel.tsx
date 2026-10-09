import { useEffect, useState } from "react";
import type { Bound, PolicyConfig, SandboxSession, UpstreamConfig } from "../lib/types";
import { CopyButton, Section } from "./fields";
import { PolicyBuilder } from "./PolicyBuilder";
import { UpstreamBehavior } from "./UpstreamBehavior";

function useCountdown(iso: string | null): string {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!iso) {
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [iso]);
  if (!iso) {
    return "";
  }
  const ms = Math.max(0, new Date(iso).getTime() - now);
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function ConfigurePanel(props: {
  session: SandboxSession | null;
  enabled: boolean;
  policy: PolicyConfig;
  upstream: UpstreamConfig;
  onPolicy: (next: PolicyConfig) => void;
  onUpstream: (next: UpstreamConfig) => void;
  policyErrors: string[];
  upstreamErrors: string[];
  dirty: boolean;
  busy: boolean;
  bounds?: Record<string, Bound>;
  onCreate: () => void;
  onApply: () => void;
  onRevert: () => void;
  onDelete: () => void;
  onResetCircuit: () => void;
}) {
  const [tab, setTab] = useState<"policy" | "upstream">("policy");
  const [showKey, setShowKey] = useState(false);
  const countdown = useCountdown(props.session?.sandbox.expiresAt ?? null);
  const invalid = props.policyErrors.length > 0 || props.upstreamErrors.length > 0;
  const { session } = props;

  return (
    <Section
      title="1. Configure your sandbox"
      subtitle="You get a private tenant, API key, policy, route and mock upstream. It is deleted automatically after 30 minutes."
      className="configure"
    >
      {session ? (
        <dl className="sandbox-facts">
          <div>
            <dt>Sandbox</dt>
            <dd className="mono">{session.sandbox.tenantSlug}</dd>
          </div>
          <div>
            <dt>Route</dt>
            <dd className="mono">{session.sandbox.routePattern}</dd>
          </div>
          <div>
            <dt>Policy version</dt>
            <dd className="mono">v{session.sandbox.policy.version}</dd>
          </div>
          <div>
            <dt>Expires in</dt>
            <dd className="mono">{countdown}</dd>
          </div>
          <div className="span-2">
            <dt>API key</dt>
            <dd className="key-row">
              <code className="mono truncate">{showKey ? session.apiKey : `${session.apiKey.slice(0, 18)}…`}</code>
              <button type="button" className="btn btn-ghost btn-small" onClick={() => setShowKey((v) => !v)}>
                {showKey ? "Hide" : "Show"}
              </button>
              <CopyButton text={session.apiKey} />
            </dd>
          </div>
          <div className="span-2">
            <dt>Redis key for your requests</dt>
            <dd className="mono small wrap">{session.sandbox.policy.redisKeyFormat}</dd>
          </div>
        </dl>
      ) : null}

      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "policy"} className={tab === "policy" ? "active" : ""} onClick={() => setTab("policy")}>
          Rate-limit policy {props.policyErrors.length > 0 ? <span className="dot dot-error" aria-label="has errors" /> : null}
        </button>
        <button type="button" role="tab" aria-selected={tab === "upstream"} className={tab === "upstream" ? "active" : ""} onClick={() => setTab("upstream")}>
          Upstream behavior {props.upstreamErrors.length > 0 ? <span className="dot dot-error" aria-label="has errors" /> : null}
        </button>
      </div>

      {tab === "policy" ? (
        <PolicyBuilder draft={props.policy} onChange={props.onPolicy} bounds={props.bounds} errors={props.policyErrors} disabled={props.busy} />
      ) : (
        <UpstreamBehavior draft={props.upstream} onChange={props.onUpstream} bounds={props.bounds} errors={props.upstreamErrors} disabled={props.busy} />
      )}

      <div className="button-row sticky-actions">
        {!props.enabled ? (
          <p className="hint">The interactive sandbox is disabled on this deployment. Preset routes still work in the request panel.</p>
        ) : session ? (
          <>
            <button type="button" className="btn btn-primary" disabled={!props.dirty || invalid || props.busy} onClick={props.onApply}>
              Apply changes live
            </button>
            <button type="button" className="btn" disabled={!props.dirty || props.busy} onClick={props.onRevert}>
              Revert
            </button>
            <button type="button" className="btn btn-ghost" disabled={props.busy} onClick={props.onResetCircuit} title="Clear breaker state on every gateway instance">
              Reset breakers
            </button>
            <button type="button" className="btn btn-danger-ghost" disabled={props.busy} onClick={props.onDelete}>
              Delete sandbox
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-primary" disabled={invalid || props.busy} onClick={props.onCreate}>
            {props.busy ? "Creating…" : "Create sandbox"}
          </button>
        )}
      </div>
      {session && props.dirty ? (
        <p className="hint">
          Applying bumps the policy version. New decisions use a new Redis key, so the bucket starts fresh. The instance that handles
          the change drops its cache at once; the other one picks it up within the config cache TTL.
        </p>
      ) : null}
    </Section>
  );
}

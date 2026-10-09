import { UPSTREAM_PRESETS } from "../lib/defaults";
import { bound } from "../lib/validation";
import type { Bound, UpstreamConfig } from "../lib/types";
import { NumberField, Segmented } from "./fields";

export function UpstreamBehavior(props: {
  draft: UpstreamConfig;
  onChange: (next: UpstreamConfig) => void;
  bounds?: Record<string, Bound>;
  errors: string[];
  disabled?: boolean;
}) {
  const { draft, onChange, bounds } = props;
  const set = <K extends keyof UpstreamConfig>(key: K, value: UpstreamConfig[K]) => onChange({ ...draft, [key]: value });
  const active = UPSTREAM_PRESETS.find((preset) =>
    Object.entries(preset.values).every(([key, value]) => draft[key as keyof UpstreamConfig] === value)
  );

  return (
    <div className="form-grid">
      <div className="field">
        <span className="label">Quick presets</span>
        <div className="chip-row">
          {UPSTREAM_PRESETS.map((preset) => (
            <button
              type="button"
              key={preset.id}
              disabled={props.disabled}
              className={`chip ${active?.id === preset.id ? "active" : ""}`}
              title={preset.description}
              onClick={() => onChange({ ...draft, ...preset.values })}
            >
              {preset.label}
            </button>
          ))}
        </div>
        <small className="hint">{active ? active.description : "Custom behavior."}</small>
      </div>

      <div className="row-2">
        <NumberField label="Added latency" value={draft.delayMs} onChange={(v) => set("delayMs", v)} {...bound(bounds, "delayMs")} step={50} unit="ms" disabled={props.disabled} />
        <NumberField label="Gateway timeout" value={draft.timeoutMs} onChange={(v) => set("timeoutMs", v)} {...bound(bounds, "timeoutMs")} step={100} unit="ms" disabled={props.disabled} hint="Gateway gives up and returns 504" />
      </div>
      <div className="row-2">
        <NumberField label="Random failure rate" value={draft.failRatePct} onChange={(v) => set("failRatePct", v)} {...bound(bounds, "failRatePct")} unit="%" disabled={props.disabled} />
        <NumberField label="Fail the first N requests" value={draft.failFirstN} onChange={(v) => set("failFirstN", v)} {...bound(bounds, "failFirstN")} disabled={props.disabled} hint="Deterministic outage, then recovery" />
      </div>
      <Segmented
        label="Error status returned by the upstream"
        value={draft.errorStatus}
        disabled={props.disabled}
        onChange={(value) => set("errorStatus", value)}
        options={[
          { value: 500, label: "500" },
          { value: 502, label: "502" },
          { value: 503, label: "503" }
        ]}
      />

      <h3 className="subhead">Circuit breaker (per gateway instance)</h3>
      <div className="row-3">
        <NumberField label="Open after" value={draft.cbFailureThreshold} onChange={(v) => set("cbFailureThreshold", v)} {...bound(bounds, "cbFailureThreshold")} unit="failures" disabled={props.disabled} />
        <NumberField label="Stay open for" value={draft.cbRecoveryMs} onChange={(v) => set("cbRecoveryMs", v)} {...bound(bounds, "cbRecoveryMs")} step={500} unit="ms" disabled={props.disabled} />
        <NumberField label="Half-open probes" value={draft.cbHalfOpenMaxProbes} onChange={(v) => set("cbHalfOpenMaxProbes", v)} {...bound(bounds, "cbHalfOpenMaxProbes")} disabled={props.disabled} />
      </div>
      <p className="explainer">
        Consecutive upstream 5xx, timeouts or connection errors open the breaker. While open, the gateway answers 503 immediately without
        calling the upstream. After the recovery time it lets a probe through: success closes it, failure re-opens it. Each gateway
        instance keeps its own breaker, which you can see in Live system state.
      </p>

      {props.errors.length > 0 ? (
        <ul className="error-list" role="alert">
          {props.errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

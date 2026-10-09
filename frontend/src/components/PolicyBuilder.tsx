import { DIMENSION_HELP } from "../lib/defaults";
import { bound } from "../lib/validation";
import type { Bound, Dimension, PolicyConfig } from "../lib/types";
import { NumberField, Segmented, TextField } from "./fields";

const DIMENSIONS: Dimension[] = ["tenant", "api_key", "route", "ip", "custom"];

export function PolicyBuilder(props: {
  draft: PolicyConfig;
  onChange: (next: PolicyConfig) => void;
  bounds?: Record<string, Bound>;
  errors: string[];
  disabled?: boolean;
}) {
  const { draft, onChange, bounds } = props;
  const set = <K extends keyof PolicyConfig>(key: K, value: PolicyConfig[K]) => onChange({ ...draft, [key]: value });

  function toggleDimension(dimension: Dimension) {
    const has = draft.dimensions.includes(dimension);
    set(
      "dimensions",
      has ? draft.dimensions.filter((d) => d !== dimension) : DIMENSIONS.filter((d) => d === dimension || draft.dimensions.includes(d))
    );
  }

  return (
    <div className="form-grid">
      <Segmented
        label="Algorithm"
        value={draft.algorithm}
        disabled={props.disabled}
        onChange={(value) => set("algorithm", value)}
        options={[
          { value: "token_bucket", label: "Token bucket", title: "Burst up to capacity, then a steady refill rate" },
          { value: "sliding_window", label: "Sliding window", title: "At most N requests in any rolling window" }
        ]}
      />
      <p className="explainer">
        {draft.algorithm === "token_bucket"
          ? "Each request spends one token. The bucket holds at most the capacity and refills continuously. Good for allowing short bursts with a steady average."
          : "Redis keeps a sorted set of accepted request timestamps. A request is allowed only if fewer than the limit happened in the last window. Precise, but memory grows with the limit."}
      </p>
      {draft.algorithm === "token_bucket" ? (
        <div className="row-2">
          <NumberField
            label="Capacity (burst)"
            value={draft.burstCapacity}
            onChange={(v) => set("burstCapacity", v)}
            {...bound(bounds, "burstCapacity")}
            unit="tokens"
            disabled={props.disabled}
          />
          <NumberField
            label="Refill rate"
            value={draft.refillRatePerSec}
            onChange={(v) => set("refillRatePerSec", v)}
            {...bound(bounds, "refillRatePerSec")}
            step={0.1}
            unit="/ sec"
            disabled={props.disabled}
          />
        </div>
      ) : (
        <div className="row-2">
          <NumberField
            label="Limit"
            value={draft.limitCount}
            onChange={(v) => set("limitCount", v)}
            {...bound(bounds, "limitCount")}
            unit="requests"
            disabled={props.disabled}
          />
          <NumberField
            label="Window"
            value={draft.windowMs}
            onChange={(v) => set("windowMs", v)}
            {...bound(bounds, "windowMs")}
            step={500}
            unit="ms"
            disabled={props.disabled}
          />
        </div>
      )}

      <fieldset className="field" disabled={props.disabled}>
        <legend>Count requests per</legend>
        <div className="checks">
          {DIMENSIONS.map((dimension) => (
            <label key={dimension} className="check" title={DIMENSION_HELP[dimension]}>
              <input
                type="checkbox"
                checked={draft.dimensions.includes(dimension)}
                onChange={() => toggleDimension(dimension)}
              />
              <span className="mono">{dimension}</span>
            </label>
          ))}
        </div>
        <small className="hint">
          The selected values are hashed into the Redis key. More dimensions means narrower, separate quotas.
        </small>
      </fieldset>

      {draft.dimensions.includes("custom") ? (
        <TextField
          label="Custom dimension header"
          value={draft.customHeader}
          onChange={(v) => set("customHeader", v.toLowerCase())}
          mono
          hint="Requests without this header share the value 'anonymous'."
          disabled={props.disabled}
        />
      ) : null}

      <Segmented
        label="If Redis is unreachable"
        value={draft.failMode}
        disabled={props.disabled}
        onChange={(value) => set("failMode", value)}
        options={[
          { value: "fail_closed", label: "Fail closed (503)", title: "Protect the upstream: reject when the limiter cannot decide" },
          { value: "fail_open", label: "Fail open (allow)", title: "Protect availability: allow when the limiter cannot decide" }
        ]}
      />

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

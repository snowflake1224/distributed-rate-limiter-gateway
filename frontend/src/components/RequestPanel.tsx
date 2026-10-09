import { useEffect, useState } from "react";
import { BROWSER_MAX_CONCURRENCY, bound } from "../lib/validation";
import type { Manifest, RunConfig, SandboxSession } from "../lib/types";
import { NumberField, Section, Segmented, TextField } from "./fields";

interface HeaderRow {
  id: number;
  name: string;
  value: string;
}

let headerRowId = 0;

function toRows(headers: Record<string, string>): HeaderRow[] {
  return Object.entries(headers).map(([name, value]) => ({ id: headerRowId++, name, value }));
}

function HeadersEditor(props: { headers: Record<string, string>; onChange: (next: Record<string, string>) => void; disabled?: boolean }) {
  const [rows, setRows] = useState<HeaderRow[]>(() => toRows(props.headers));
  const serialized = JSON.stringify(props.headers);

  useEffect(() => {
    const current = Object.fromEntries(rows.filter((r) => r.name).map((r) => [r.name, r.value]));
    if (JSON.stringify(current) !== serialized) {
      setRows(toRows(props.headers));
    }
    // Only resync when the parent changes headers from outside (e.g. an experiment).
  }, [serialized]);

  function commit(next: HeaderRow[]) {
    setRows(next);
    props.onChange(Object.fromEntries(next.filter((r) => r.name.trim()).map((r) => [r.name.trim().toLowerCase(), r.value])));
  }

  return (
    <div className="field">
      <span className="label">Extra headers</span>
      {rows.map((row) => (
        <div className="header-row" key={row.id}>
          <input
            aria-label="Header name"
            className="mono"
            placeholder="x-user-id"
            value={row.name}
            disabled={props.disabled}
            onChange={(e) => commit(rows.map((r) => (r.id === row.id ? { ...r, name: e.target.value } : r)))}
          />
          <input
            aria-label="Header value"
            className="mono"
            placeholder="alice"
            value={row.value}
            disabled={props.disabled}
            onChange={(e) => commit(rows.map((r) => (r.id === row.id ? { ...r, value: e.target.value } : r)))}
          />
          <button
            type="button"
            className="btn btn-ghost btn-small"
            aria-label={`Remove header ${row.name}`}
            disabled={props.disabled}
            onClick={() => commit(rows.filter((r) => r.id !== row.id))}
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn btn-ghost btn-small align-start"
        disabled={props.disabled || rows.length >= 5}
        onClick={() => setRows([...rows, { id: headerRowId++, name: "", value: "" }])}
      >
        Add header
      </button>
    </div>
  );
}

export function RequestPanel(props: {
  config: RunConfig;
  onChange: (next: RunConfig) => void;
  session: SandboxSession | null;
  manifest: Manifest | null;
  errors: string[];
  running: boolean;
  progress: { done: number; total: number } | null;
  onSend: () => void;
  onStop: () => void;
}) {
  const { config, onChange, manifest } = props;
  const set = <K extends keyof RunConfig>(key: K, value: RunConfig[K]) => onChange({ ...config, [key]: value });
  const bounds = manifest?.bounds;
  const single = config.mode === "single";
  const presets = manifest?.presets;

  function selectCredential(value: RunConfig["credential"]) {
    if (value === "preset" && presets?.acmeKey) {
      onChange({ ...config, credential: value, presetKey: presets.acmeKey, path: "/api/orders", mode: config.mode === "server" ? "browser" : config.mode });
      return;
    }
    if (value === "sandbox" && props.session) {
      onChange({ ...config, credential: value, path: `${props.session.sandbox.routePrefix}/orders` });
      return;
    }
    set("credential", value);
  }

  return (
    <Section
      title="2. Send real traffic"
      subtitle="Every request below goes through Nginx to one of the two gateway instances, Redis, and the mock upstream. Nothing is simulated."
    >
      <div className="form-grid">
        <Segmented
          label="Mode"
          value={config.mode}
          disabled={props.running}
          onChange={(value) => onChange({ ...config, mode: value, concurrency: value === "browser" ? Math.min(config.concurrency, BROWSER_MAX_CONCURRENCY) : config.concurrency, credential: value === "server" ? "sandbox" : config.credential })}
          options={[
            { value: "single", label: "Single request", title: "Send one request and inspect the full response" },
            { value: "browser", label: "Load from browser", title: "Your browser sends the requests through Nginx" },
            { value: "server", label: "Server-side burst", title: "The gateway fires the burst at both instances directly, up to 50 at once" }
          ]}
        />
        {config.mode === "server" ? (
          <p className="explainer">
            Browsers open only about 6 connections per host, so they cannot create a real race. The server-side runner sends up to 50
            requests at the same moment, alternating between gateway-1 and gateway-2 directly (bypassing Nginx), using your sandbox key.
            Use it to check that two instances never admit more than the limit.
          </p>
        ) : null}

        <div className="row-method">
          <Segmented
            label="Method"
            value={config.method}
            disabled={props.running}
            onChange={(value) => set("method", value)}
            options={[
              { value: "GET", label: "GET" },
              { value: "POST", label: "POST" }
            ]}
          />
          <TextField label="Path" value={config.path} onChange={(v) => set("path", v)} mono disabled={props.running} hint={props.session ? `Anything under ${props.session.sandbox.routePrefix}/ reaches your sandbox upstream.` : undefined} />
        </div>

        <div className="field">
          <label htmlFor="credential">API key</label>
          <select id="credential" value={config.credential} disabled={props.running} onChange={(e) => selectCredential(e.target.value as RunConfig["credential"])}>
            <option value="sandbox" disabled={!props.session}>
              My sandbox key{props.session ? "" : " (create a sandbox first)"}
            </option>
            {config.mode !== "server" ? (
              <>
                <option value="preset" disabled={!presets?.available}>
                  Public demo tenant (seeded routes)
                </option>
                <option value="none">No key (expect 401)</option>
                <option value="invalid">Invalid key (expect 401)</option>
              </>
            ) : null}
          </select>
        </div>

        {config.credential === "preset" && presets?.available ? (
          <div className="field">
            <label htmlFor="preset-route">Seeded route</label>
            <select
              id="preset-route"
              value={config.path}
              disabled={props.running}
              onChange={(e) => {
                const route = presets.routes.find((r) => r.path === e.target.value);
                onChange({ ...config, path: e.target.value, presetKey: route?.tenant === "globex" ? presets.globexKey ?? undefined : presets.acmeKey ?? undefined });
              }}
            >
              {presets.routes.map((route) => (
                <option key={route.path} value={route.path}>
                  {route.path} ({route.tenant}): {route.summary}
                </option>
              ))}
            </select>
            <small className="hint">The seeded policies are shared by every visitor, so other people's traffic can affect what you see.</small>
          </div>
        ) : null}

        <HeadersEditor headers={config.headers} onChange={(headers) => set("headers", headers)} disabled={props.running} />

        {config.method === "POST" ? (
          <div className="field">
            <label htmlFor="body">JSON body</label>
            <textarea id="body" className="mono" rows={3} value={config.body ?? ""} placeholder='{"amount": 42}' disabled={props.running} onChange={(e) => set("body", e.target.value)} />
          </div>
        ) : null}

        {!single ? (
          <>
            <div className="row-3">
              <NumberField label="Requests" value={config.count} onChange={(v) => set("count", v)} {...bound(bounds, "runCount")} disabled={props.running} />
              <NumberField
                label="In flight at once"
                value={config.concurrency}
                onChange={(v) => set("concurrency", v)}
                min={1}
                max={config.mode === "browser" ? BROWSER_MAX_CONCURRENCY : bound(bounds, "runConcurrency").max}
                disabled={props.running}
              />
              {config.mode === "browser" ? (
                <NumberField label="Pause between" value={config.intervalMs} onChange={(v) => set("intervalMs", v)} min={0} max={10_000} step={50} unit="ms" disabled={props.running} hint="Per in-flight slot" />
              ) : (
                <div />
              )}
            </div>
            <div className="field">
              <label className="check">
                <input
                  type="checkbox"
                  checked={Boolean(config.rotateHeader)}
                  disabled={props.running}
                  onChange={(e) => set("rotateHeader", e.target.checked ? { name: "x-user-id", values: 3 } : undefined)}
                />
                <span>Rotate a header across simulated users</span>
              </label>
              {config.rotateHeader ? (
                <div className="row-2">
                  <TextField label="Header" value={config.rotateHeader.name} mono onChange={(v) => set("rotateHeader", { ...config.rotateHeader!, name: v.toLowerCase() })} disabled={props.running} />
                  <NumberField label="Distinct values" value={config.rotateHeader.values} onChange={(v) => set("rotateHeader", { ...config.rotateHeader!, values: v })} {...bound(bounds, "rotateValues")} disabled={props.running} hint="user-0, user-1, …" />
                </div>
              ) : null}
            </div>
          </>
        ) : null}

        {props.errors.length > 0 ? (
          <ul className="error-list" role="alert">
            {props.errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        ) : null}

        <div className="button-row">
          {props.running ? (
            <button type="button" className="btn btn-danger" onClick={props.onStop} disabled={config.mode === "server"}>
              {config.mode === "server" ? "Running on server…" : "Stop"}
            </button>
          ) : (
            <button type="button" className="btn btn-primary" disabled={props.errors.length > 0} onClick={props.onSend}>
              {single ? "Send request" : config.mode === "server" ? `Fire ${config.count} requests on the server` : `Send ${config.count} requests`}
            </button>
          )}
          {props.progress ? (
            <span className="progress" aria-live="polite">
              <span className="progress-bar">
                <span style={{ width: `${(props.progress.done / Math.max(1, props.progress.total)) * 100}%` }} />
              </span>
              {props.progress.done}/{props.progress.total}
            </span>
          ) : null}
        </div>
      </div>
    </Section>
  );
}

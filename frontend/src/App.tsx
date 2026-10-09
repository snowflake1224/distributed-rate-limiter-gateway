import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, describeIssues } from "./lib/api";
import { runInBrowser } from "./lib/browserRunner";
import { DEFAULT_POLICY, DEFAULT_RUN, DEFAULT_UPSTREAM } from "./lib/defaults";
import type { LabContext } from "./lib/experiments";
import type {
  InstanceState,
  Manifest,
  PolicyConfig,
  ResultRow,
  Run,
  RunConfig,
  SandboxSession,
  SandboxView,
  UpstreamConfig
} from "./lib/types";
import { validatePolicy, validateRun, validateUpstream } from "./lib/validation";
import { ArchitectureFlow } from "./components/ArchitectureFlow";
import { ConfigurePanel } from "./components/ConfigurePanel";
import { ExperimentsPanel } from "./components/ExperimentsPanel";
import { RequestPanel } from "./components/RequestPanel";
import { ResultsPanel } from "./components/ResultsPanel";
import { SystemState } from "./components/SystemState";

const SESSION_KEY = "gateway-lab-session";

function loadSession(): SandboxSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as SandboxSession) : null;
  } catch {
    return null;
  }
}

function policyOf(view: SandboxView): PolicyConfig {
  const p = view.policy;
  return {
    algorithm: p.algorithm,
    burstCapacity: p.burstCapacity,
    refillRatePerSec: p.refillRatePerSec,
    limitCount: p.limitCount,
    windowMs: p.windowMs,
    dimensions: p.dimensions,
    customHeader: p.customHeader,
    failMode: p.failMode
  };
}

function upstreamOf(view: SandboxView): UpstreamConfig {
  const u = view.upstream;
  return {
    delayMs: u.delayMs,
    failRatePct: u.failRatePct,
    failFirstN: u.failFirstN,
    errorStatus: u.errorStatus,
    timeoutMs: u.timeoutMs,
    cbFailureThreshold: u.cbFailureThreshold,
    cbRecoveryMs: u.cbRecoveryMs,
    cbHalfOpenMaxProbes: u.cbHalfOpenMaxProbes
  };
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

let runCounter = 0;

export default function App() {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [session, setSessionState] = useState<SandboxSession | null>(loadSession);
  const [policy, setPolicy] = useState<PolicyConfig>(() => (session ? policyOf(session.sandbox) : DEFAULT_POLICY));
  const [upstream, setUpstream] = useState<UpstreamConfig>(() => (session ? upstreamOf(session.sandbox) : DEFAULT_UPSTREAM));
  const [runConfig, setRunConfig] = useState<RunConfig>(() => ({
    ...DEFAULT_RUN,
    path: session ? `${session.sandbox.routePrefix}/orders` : "/api/orders"
  }));
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [instances, setInstances] = useState<InstanceState[]>([]);
  const [stateUpdated, setStateUpdated] = useState<number | null>(null);
  const [ready, setReady] = useState<{ postgres: boolean; redis: boolean; instance: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [activity, setActivity] = useState<Array<{ at: number; text: string }>>([]);
  const [banner, setBanner] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sessionRef = useRef<SandboxSession | null>(session);

  const setSession = useCallback((next: SandboxSession | null) => {
    sessionRef.current = next;
    setSessionState(next);
    if (next) {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(next));
    } else {
      sessionStorage.removeItem(SESSION_KEY);
    }
  }, []);

  const note = useCallback((text: string) => {
    setActivity((prev) => [{ at: Date.now(), text }, ...prev].slice(0, 30));
  }, []);

  useEffect(() => {
    api
      .manifest()
      .then((loaded) => {
        setManifest(loaded);
        if (!sessionRef.current && loaded.presets.available && loaded.presets.acmeKey) {
          setRunConfig((prev) =>
            prev.credential === "sandbox" ? { ...prev, credential: "preset", presetKey: loaded.presets.acmeKey ?? undefined, path: "/api/orders" } : prev
          );
        }
      })
      .catch((error) => setManifestError(describeIssues(error)));
    const loadReady = () =>
      api
        .ready()
        .then((r) => setReady({ ...r.checks, instance: r.instance }))
        .catch(() => setReady({ postgres: false, redis: false, instance: "unreachable" }));
    void loadReady();
    const timer = setInterval(loadReady, 10_000);
    return () => clearInterval(timer);
  }, []);

  const refreshState = useCallback(async (): Promise<InstanceState[]> => {
    const current = sessionRef.current;
    if (!current) {
      return [];
    }
    try {
      const result = await api.getSandbox(current);
      setInstances(result.instances);
      setStateUpdated(Date.now());
      if (sessionRef.current && result.sandbox.policy.version !== sessionRef.current.sandbox.policy.version) {
        setSession({ ...sessionRef.current, sandbox: result.sandbox });
      }
      return result.instances;
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 401)) {
        setSession(null);
        setInstances([]);
        setBanner({ kind: "info", text: "Your sandbox expired or was removed. Create a new one to continue." });
      }
      return [];
    }
  }, [setSession]);

  useEffect(() => {
    if (!session) {
      return;
    }
    void refreshState();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        void refreshState();
      }
    }, 2_000);
    return () => clearInterval(timer);
  }, [session?.sandbox.id, refreshState]);

  const policyErrors = useMemo(() => validatePolicy(policy, manifest?.bounds), [policy, manifest]);
  const upstreamErrors = useMemo(() => validateUpstream(upstream, manifest?.bounds), [upstream, manifest]);
  const runErrors = useMemo(() => {
    const errors = validateRun(runConfig, session?.sandbox.routePrefix ?? null, manifest?.bounds);
    if (runConfig.credential === "sandbox" && !session) {
      errors.unshift("Create a sandbox first, or pick the public demo tenant key.");
    }
    return errors;
  }, [runConfig, session, manifest]);

  const dirty = Boolean(session) && (!sameJson(policy, policyOf(session!.sandbox)) || !sameJson(upstream, upstreamOf(session!.sandbox)));

  const adoptSandbox = useCallback(
    (next: SandboxSession) => {
      setSession(next);
      setPolicy(policyOf(next.sandbox));
      setUpstream(upstreamOf(next.sandbox));
    },
    [setSession]
  );

  async function createSandbox(nextPolicy = policy, nextUpstream = upstream): Promise<SandboxSession> {
    const created = await api.createSandbox(nextPolicy, nextUpstream);
    adoptSandbox(created);
    setRunConfig((prev) => ({ ...prev, credential: "sandbox", path: `${created.sandbox.routePrefix}/orders` }));
    note(`Sandbox ${created.sandbox.tenantSlug} created (policy v${created.sandbox.policy.version}).`);
    return created;
  }

  async function guarded(action: () => Promise<unknown>) {
    setBusy(true);
    setBanner(null);
    try {
      await action();
    } catch (error) {
      setBanner({ kind: "error", text: describeIssues(error) });
    } finally {
      setBusy(false);
    }
  }

  async function applyChanges() {
    const current = sessionRef.current;
    if (!current) {
      return;
    }
    const body: Parameters<typeof api.patchSandbox>[1] = {};
    if (!sameJson(policy, policyOf(current.sandbox))) {
      body.policy = policy;
    }
    if (!sameJson(upstream, upstreamOf(current.sandbox))) {
      body.upstream = upstream;
    }
    const result = await api.patchSandbox(current, body);
    adoptSandbox({ ...current, sandbox: result.sandbox });
    note(
      `${body.policy ? `Policy updated to v${result.sandbox.policy.version}` : "Upstream behavior updated"} · handled by ${result.handledBy}.`
    );
    void refreshState();
  }

  async function deleteSandbox() {
    const current = sessionRef.current;
    if (!current) {
      return;
    }
    await api.deleteSandbox(current).catch((error) => {
      if (!(error instanceof ApiError && error.status === 404)) {
        throw error;
      }
    });
    note(`Sandbox ${current.sandbox.tenantSlug} deleted.`);
    setSession(null);
    setInstances([]);
    setRunConfig((prev) => ({ ...prev, credential: manifest?.presets.available ? "preset" : "none", path: "/api/orders", presetKey: manifest?.presets.acmeKey ?? undefined }));
  }

  async function resetCircuit() {
    const current = sessionRef.current;
    if (!current) {
      return;
    }
    await api.patchSandbox(current, { resetCircuit: true });
    note("Circuit breakers reset on every instance.");
    void refreshState();
  }

  const executeRun = useCallback(
    async (config: RunConfig, label: string, signal?: AbortSignal): Promise<Run> => {
      const current = sessionRef.current;
      const id = `run-${++runCounter}`;
      const effective: RunConfig = config.mode === "single" ? { ...config, count: 1, concurrency: 1, intervalMs: 0 } : config;
      const run: Run = {
        id,
        label,
        startedAt: new Date().toISOString(),
        durationMs: 0,
        config: effective,
        policy: effective.credential === "sandbox" && current ? { ...policyOf(current.sandbox), version: current.sandbox.policy.version } : null,
        upstream: effective.credential === "sandbox" && current ? upstreamOf(current.sandbox) : null,
        rows: [],
        targets: []
      };
      setRuns((prev) => [run, ...prev].slice(0, 25));
      setSelectedRunId(id);
      setRunning(true);
      setProgress({ done: 0, total: effective.count });
      const controller = new AbortController();
      abortRef.current = controller;
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort);
      const update = (patch: Partial<Run>) => {
        Object.assign(run, patch);
        setRuns((prev) => prev.map((r) => (r.id === id ? { ...run } : r)));
      };

      try {
        if (effective.mode === "server") {
          if (!current) {
            throw new Error("Create a sandbox first");
          }
          const result = await api.serverRun(current, {
            method: effective.method,
            path: effective.path,
            count: effective.count,
            concurrency: effective.concurrency,
            headers: effective.headers,
            rotateHeader: effective.rotateHeader,
            body: effective.method === "POST" ? effective.body || "{}" : undefined
          });
          update({ rows: result.rows, durationMs: result.durationMs, targets: result.targets });
          setProgress({ done: result.rows.length, total: effective.count });
        } else {
          const rows: ResultRow[] = [];
          let pending = false;
          const result = await runInBrowser(effective, current?.apiKey ?? null, {
            signal: controller.signal,
            onRow: (row) => {
              rows.push(row);
              setProgress({ done: rows.length, total: effective.count });
              if (!pending) {
                pending = true;
                requestAnimationFrame(() => {
                  pending = false;
                  update({ rows: [...rows] });
                });
              }
            }
          });
          update({ rows: [...rows], durationMs: result.durationMs, cancelled: result.cancelled, targets: [window.location.origin] });
        }
      } catch (error) {
        update({ error: describeIssues(error) });
        if (signal?.aborted) {
          throw error;
        }
      } finally {
        signal?.removeEventListener("abort", onAbort);
        abortRef.current = null;
        setRunning(false);
        setProgress(null);
        void refreshState();
      }
      return { ...run };
    },
    [refreshState]
  );

  const labContext = useMemo<Omit<LabContext, "signal" | "log">>(
    () => ({
      configure: async (nextPolicy, nextUpstream, options) => {
        const current = sessionRef.current;
        const fullPolicy: PolicyConfig = { ...(current ? policyOf(current.sandbox) : DEFAULT_POLICY), ...nextPolicy };
        const fullUpstream: UpstreamConfig = { ...(current ? upstreamOf(current.sandbox) : DEFAULT_UPSTREAM), ...(nextUpstream ?? {}) };
        if (!current) {
          return createSandbox(fullPolicy, fullUpstream);
        }
        const result = await api.patchSandbox(current, {
          policy: fullPolicy,
          upstream: fullUpstream,
          restartUpstreamCounter: options?.restartCounter,
          resetCircuit: options?.resetCircuit
        });
        const next = { ...current, sandbox: result.sandbox };
        adoptSandbox(next);
        note(`Experiment set policy v${result.sandbox.policy.version} · handled by ${result.handledBy}.`);
        return { ...next, handledBy: result.handledBy };
      },
      patchPolicy: async (partial) => {
        const current = sessionRef.current;
        if (!current) {
          throw new Error("No sandbox");
        }
        const result = await api.patchSandbox(current, { policy: partial });
        const next = { ...current, sandbox: result.sandbox };
        adoptSandbox(next);
        note(`Policy updated to v${result.sandbox.policy.version} · handled by ${result.handledBy}.`);
        return { ...next, handledBy: result.handledBy };
      },
      run: async (partial, label, signal) => {
        const current = sessionRef.current;
        const config: RunConfig = {
          ...DEFAULT_RUN,
          path: current ? `${current.sandbox.routePrefix}/orders` : "/api/orders",
          ...partial,
          headers: partial.headers ?? {}
        };
        setRunConfig(config);
        return executeRun(config, label, signal);
      },
      state: refreshState,
      session: () => sessionRef.current
    }),
    [executeRun, refreshState, adoptSandbox, note]
  );

  async function send() {
    const label =
      runConfig.mode === "single"
        ? `${runConfig.method} ${runConfig.path}`
        : `${runConfig.count} × ${runConfig.method} ${runConfig.path} (${runConfig.mode === "server" ? "server" : "browser"}, ${runConfig.concurrency} at once)`;
    await executeRun(runConfig, label);
  }

  const selectedRun = runs.find((r) => r.id === selectedRunId) ?? runs[0] ?? null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <h1>Gateway Lab</h1>
            <p>Distributed rate limiter · two Node.js gateways · Redis Lua · PostgreSQL config · circuit breakers</p>
          </div>
        </div>
        <div className="topbar-meta">
          {manifest ? (
            <>
              <span className="pill pill-ok">{manifest.gatewayInstances} gateway instances</span>
              <span className="pill">config cache TTL {manifest.policyCacheTtlMs / 1000}s</span>
            </>
          ) : manifestError ? (
            <span className="pill pill-bad">Gateway unreachable</span>
          ) : (
            <span className="pill">Connecting…</span>
          )}
        </div>
      </header>

      {manifestError ? (
        <div className="banner banner-error" role="alert">
          Could not reach the gateway API ({manifestError}). The lab needs the backend running; locally use <code>docker compose up --build</code>.
        </div>
      ) : null}
      {banner ? (
        <div className={`banner banner-${banner.kind}`} role={banner.kind === "error" ? "alert" : "status"}>
          {banner.text}
          <button type="button" className="btn btn-ghost btn-small" onClick={() => setBanner(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      <ArchitectureFlow run={selectedRun} instanceCount={manifest?.gatewayInstances ?? 2} />

      <main className="layout">
        <aside className="col-left">
          <ConfigurePanel
            session={session}
            enabled={manifest?.sandboxEnabled ?? false}
            policy={policy}
            upstream={upstream}
            onPolicy={setPolicy}
            onUpstream={setUpstream}
            policyErrors={policyErrors}
            upstreamErrors={upstreamErrors}
            dirty={dirty}
            busy={busy || running}
            bounds={manifest?.bounds}
            onCreate={() => void guarded(() => createSandbox())}
            onApply={() => void guarded(applyChanges)}
            onRevert={() => {
              if (session) {
                setPolicy(policyOf(session.sandbox));
                setUpstream(upstreamOf(session.sandbox));
              }
            }}
            onDelete={() => void guarded(deleteSandbox)}
            onResetCircuit={() => void guarded(resetCircuit)}
          />
        </aside>

        <div className="col-main">
          <ExperimentsPanel
            context={labContext}
            disabled={!manifest?.sandboxEnabled || running || busy}
            policyCacheTtlMs={manifest?.policyCacheTtlMs ?? 5_000}
            onError={(text) => setBanner({ kind: "error", text })}
            onSelectRun={setSelectedRunId}
          />
          <div className="split">
            <RequestPanel
              config={runConfig}
              onChange={setRunConfig}
              session={session}
              manifest={manifest}
              errors={runErrors}
              running={running}
              progress={progress}
              onSend={() => void send()}
              onStop={() => abortRef.current?.abort()}
            />
            <SystemState session={session} instances={instances} ready={ready} lastUpdated={stateUpdated} activity={activity} />
          </div>
          <ResultsPanel
            runs={runs}
            selectedRun={selectedRun}
            onSelect={setSelectedRunId}
            onClear={() => {
              setRuns([]);
              setSelectedRunId(null);
            }}
            apiKey={session?.apiKey ?? null}
          />
        </div>
      </main>

      <footer className="footer">
        <p>
          Every number on this page comes from a real HTTP response and can be traced by its request ID. Source, architecture notes and
          load-test results are in the repository README.
        </p>
      </footer>
    </div>
  );
}

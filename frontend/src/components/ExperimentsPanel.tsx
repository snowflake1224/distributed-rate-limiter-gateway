import { useRef, useState } from "react";
import { describeIssues } from "../lib/api";
import {
  EXPERIMENTS,
  defaultParams,
  validateParams,
  type Experiment,
  type ExperimentOutcome,
  type LabContext,
  type Params,
  type StepUpdate
} from "../lib/experiments";
import { CopyButton, NumberField, Section, Segmented } from "./fields";

interface Execution {
  experimentId: string;
  steps: StepUpdate[];
  outcome: ExperimentOutcome | null;
  error: string | null;
  log: Array<{ at: number; text: string }>;
}

function ParamInputs(props: { experiment: Experiment; params: Params; onChange: (next: Params) => void; disabled: boolean }) {
  const { experiment, params } = props;
  if (experiment.params.length === 0) {
    return null;
  }
  return (
    <div className="row-3">
      {experiment.params.map((param) =>
        param.options ? (
          <Segmented
            key={param.key}
            label={param.label}
            value={params[param.key] ?? param.defaultValue}
            options={param.options}
            disabled={props.disabled}
            onChange={(value) => props.onChange({ ...params, [param.key]: value })}
          />
        ) : (
          <NumberField
            key={param.key}
            label={param.label}
            value={params[param.key] ?? param.defaultValue}
            min={param.min}
            max={param.max}
            step={param.step}
            unit={param.unit}
            disabled={props.disabled}
            onChange={(value) => props.onChange({ ...params, [param.key]: value })}
          />
        )
      )}
    </div>
  );
}

export function ExperimentsPanel(props: {
  context: Omit<LabContext, "signal" | "log">;
  disabled: boolean;
  policyCacheTtlMs: number;
  onError: (text: string) => void;
  onSelectRun: (runId: string) => void;
}) {
  const [selectedId, setSelectedId] = useState(EXPERIMENTS[0]!.id);
  const [paramsById, setParamsById] = useState<Record<string, Params>>(() =>
    Object.fromEntries(EXPERIMENTS.map((experiment) => [experiment.id, defaultParams(experiment)]))
  );
  const [execution, setExecution] = useState<Execution | null>(null);
  const [active, setActive] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  const experiment = EXPERIMENTS.find((e) => e.id === selectedId) ?? EXPERIMENTS[0]!;
  const params = paramsById[experiment.id] ?? defaultParams(experiment);
  const paramErrors = validateParams(experiment, params);
  const plannedSteps = experiment.steps(params);
  const shown = execution?.experimentId === experiment.id ? execution : null;

  async function start() {
    const controller = new AbortController();
    controllerRef.current = controller;
    const initial: Execution = {
      experimentId: experiment.id,
      steps: plannedSteps.map(() => ({ status: "pending" })),
      outcome: null,
      error: null,
      log: []
    };
    setExecution(initial);
    setActive(true);

    const report = (index: number, update: StepUpdate) => {
      setExecution((prev) => (prev ? { ...prev, steps: prev.steps.map((s, i) => (i === index ? { ...s, ...update } : s)) } : prev));
      if (update.runId) {
        props.onSelectRun(update.runId);
      }
    };
    const ctx: LabContext = {
      ...props.context,
      signal: controller.signal,
      log: (text) => setExecution((prev) => (prev ? { ...prev, log: [...prev.log, { at: Date.now(), text }] } : prev))
    };

    try {
      const outcome = await experiment.execute(ctx, params, report, { policyCacheTtlMs: props.policyCacheTtlMs });
      setExecution((prev) => (prev ? { ...prev, outcome } : prev));
    } catch (error) {
      const stopped = controller.signal.aborted;
      const text = stopped ? "Stopped." : describeIssues(error);
      setExecution((prev) =>
        prev ? { ...prev, error: text, steps: prev.steps.map((s) => (s.status === "running" ? { ...s, status: "failed", result: text } : s)) } : prev
      );
      if (!stopped) {
        props.onError(`Experiment "${experiment.title}" failed: ${text}`);
      }
    } finally {
      controllerRef.current = null;
      setActive(false);
    }
  }

  const passed = shown?.outcome?.checks.filter((c) => c.status === "pass").length ?? 0;
  const failed = shown?.outcome?.checks.filter((c) => c.status === "fail").length ?? 0;

  return (
    <Section
      title="Guided experiments"
      subtitle="Each experiment configures your sandbox, sends real traffic, and checks the result against a stated hypothesis. Change the parameters to try to break it."
      className="experiments"
    >
      <div className="experiments-grid">
        <ul className="exp-list" aria-label="Experiments">
          {EXPERIMENTS.map((e, index) => (
            <li key={e.id}>
              <button
                type="button"
                className={e.id === experiment.id ? "active" : ""}
                aria-current={e.id === experiment.id}
                disabled={active && e.id !== experiment.id}
                onClick={() => setSelectedId(e.id)}
              >
                <span className="exp-name">
                  {index + 1}. {e.title}
                  {execution?.experimentId === e.id && execution.outcome ? (
                    <span className={execution.outcome.checks.some((c) => c.status === "fail") ? "check-fail" : "check-pass"}>
                      {execution.outcome.checks.some((c) => c.status === "fail") ? "Review" : "Passed"}
                    </span>
                  ) : null}
                </span>
                <span className="exp-teaser">{e.teaser}</span>
              </button>
            </li>
          ))}
        </ul>

        <div className="exp-detail">
          <h3>{experiment.title}</h3>
          <p className="hypothesis">
            <strong>Hypothesis.</strong> {experiment.hypothesis(params)}
          </p>

          <ParamInputs
            experiment={experiment}
            params={params}
            disabled={active}
            onChange={(next) => setParamsById((prev) => ({ ...prev, [experiment.id]: next }))}
          />

          <div>
            <h4 className="subhead">Steps</h4>
            <ol className="exp-steps">
              {plannedSteps.map((text, i) => {
                const state = shown?.steps[i];
                return (
                  <li key={i} className={state ? `step-${state.status}` : undefined}>
                    <span>
                      {text}
                      {state?.runId ? (
                        <button type="button" className="btn btn-ghost btn-small run-link" onClick={() => props.onSelectRun(state.runId!)}>
                          View run
                        </button>
                      ) : null}
                      {state?.result ? <span className="step-result">{state.result}</span> : null}
                    </span>
                  </li>
                );
              })}
            </ol>
          </div>

          {experiment.commands ? (
            <div className="cmd-block">
              <div className="snippet-head">
                <span className="hint">Run on a local copy (docker compose):</span>
                <CopyButton text={experiment.commands} />
              </div>
              <pre className="code">{experiment.commands}</pre>
            </div>
          ) : null}

          {paramErrors.length > 0 ? (
            <ul className="error-list" role="alert">
              {paramErrors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          ) : null}

          <div className="button-row">
            {active ? (
              <button type="button" className="btn btn-danger" onClick={() => controllerRef.current?.abort()}>
                Stop experiment
              </button>
            ) : (
              <button type="button" className="btn btn-primary" disabled={props.disabled || paramErrors.length > 0} onClick={() => void start()}>
                {shown ? "Run again" : "Run experiment"}
              </button>
            )}
            <button
              type="button"
              className="btn btn-ghost btn-small"
              disabled={active}
              onClick={() => setParamsById((prev) => ({ ...prev, [experiment.id]: defaultParams(experiment) }))}
            >
              Reset parameters
            </button>
            {props.disabled && !active ? <span className="hint">Waiting for the gateway, or another run is in progress.</span> : null}
          </div>

          {shown?.outcome ? (
            <div aria-live="polite">
              <h4 className="subhead">
                Checks · {passed} passed{failed > 0 ? ` · ${failed} need review` : ""}
              </h4>
              <ul className="checks-list">
                {shown.outcome.checks.map((check) => (
                  <li key={check.label}>
                    <span className={`check-${check.status}`}>{check.status === "pass" ? "PASS" : check.status === "fail" ? "FAIL" : "INFO"}</span>
                    <span>
                      <strong>{check.label}.</strong> <span className="hint">{check.detail}</span>
                    </span>
                  </li>
                ))}
              </ul>
              <p className="exp-conclusion">{shown.outcome.conclusion}</p>
            </div>
          ) : shown?.error ? (
            <p className="error-text">{shown.error}</p>
          ) : null}

          {shown && shown.log.length > 0 ? (
            <ol className="activity">
              {shown.log.map((entry) => (
                <li key={`${entry.at}-${entry.text}`}>
                  <time className="mono">{new Date(entry.at).toLocaleTimeString()}</time> {entry.text}
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      </div>
    </Section>
  );
}

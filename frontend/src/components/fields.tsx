import { useId, type ReactNode } from "react";

export function NumberField(props: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  hint?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const invalid = !Number.isFinite(props.value) || props.value < props.min || props.value > props.max;
  return (
    <div className={`field ${invalid ? "field-invalid" : ""}`}>
      <label htmlFor={id}>{props.label}</label>
      <div className="field-input">
        <input
          id={id}
          type="number"
          inputMode="decimal"
          value={Number.isFinite(props.value) ? props.value : ""}
          min={props.min}
          max={props.max}
          step={props.step ?? 1}
          disabled={props.disabled}
          aria-invalid={invalid}
          onChange={(event) => props.onChange(event.target.value === "" ? Number.NaN : Number(event.target.value))}
        />
        {props.unit ? <span className="unit">{props.unit}</span> : null}
      </div>
      <small className={invalid ? "error-text" : "hint"}>
        {invalid ? `Allowed range ${props.min}–${props.max}` : props.hint ?? `${props.min}–${props.max}`}
      </small>
    </div>
  );
}

export function TextField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: string;
  error?: string | null;
  disabled?: boolean;
  mono?: boolean;
}) {
  const id = useId();
  return (
    <div className={`field ${props.error ? "field-invalid" : ""}`}>
      <label htmlFor={id}>{props.label}</label>
      <input
        id={id}
        className={props.mono ? "mono" : undefined}
        value={props.value}
        placeholder={props.placeholder}
        disabled={props.disabled}
        aria-invalid={Boolean(props.error)}
        onChange={(event) => props.onChange(event.target.value)}
      />
      {props.error ? <small className="error-text">{props.error}</small> : props.hint ? <small className="hint">{props.hint}</small> : null}
    </div>
  );
}

export function Segmented<T extends string | number>(props: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string; title?: string }>;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="field segmented" disabled={props.disabled}>
      <legend>{props.label}</legend>
      <div className="segmented-options" role="radiogroup">
        {props.options.map((option) => (
          <button
            type="button"
            key={String(option.value)}
            role="radio"
            aria-checked={option.value === props.value}
            title={option.title}
            className={option.value === props.value ? "active" : ""}
            onClick={() => props.onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

export function Section(props: { title: string; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`section ${props.className ?? ""}`}>
      <header className="section-header">
        <div>
          <h2>{props.title}</h2>
          {props.subtitle ? <p className="section-subtitle">{props.subtitle}</p> : null}
        </div>
        {props.actions ? <div className="section-actions">{props.actions}</div> : null}
      </header>
      {props.children}
    </section>
  );
}

export function CopyButton(props: { text: string; label?: string; className?: string }) {
  return (
    <button
      type="button"
      className={`btn btn-ghost btn-small ${props.className ?? ""}`}
      onClick={(event) => {
        const button = event.currentTarget;
        void navigator.clipboard.writeText(props.text).then(() => {
          const original = button.textContent;
          button.textContent = "Copied";
          setTimeout(() => {
            button.textContent = original;
          }, 1_200);
        });
      }}
    >
      {props.label ?? "Copy"}
    </button>
  );
}

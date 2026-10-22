import { createContext, useContext, type InputHTMLAttributes, type ReactNode } from "react";
import { errorKey } from "./model.ts";

/** A resolver or schema error as the form got it: the stable code, the message and the path into the document. */
export interface FieldError {
  readonly code: string;
  readonly message: string;
  readonly path?: string | undefined;
}

/** The error the draft is in, so the field it points at can show the error state with its code. */
const ErrorContext = createContext<FieldError | undefined>(undefined);
export const FieldErrorProvider = ErrorContext.Provider;

const inputProps = (testId: string, extra: InputHTMLAttributes<HTMLInputElement> = {}) =>
  ({ "data-testid": testId, className: "mono", ...extra }) as InputHTMLAttributes<HTMLInputElement>;

/** The error that points at the field `key` (the last segment of its path), if there is one. */
function useFieldError(key: string | undefined): FieldError | undefined {
  const e = useContext(ErrorContext);
  return key !== undefined && e !== undefined && errorKey(e) === key ? e : undefined;
}

type InputState = "inh" | "set" | "err";

/**
 * One line: the label (with a short second line), the input, then the help: where the value comes from, or the error with its code
 * and path. The input has three states: inherited (dashed, grey), set (accent edge), error (alarm tint).
 */
export function FieldRow(props: {
  label: string;
  sub?: string | undefined;
  state: InputState;
  help?: ReactNode;
  error?: FieldError | undefined;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <label className={`rc-row ${props.state}`} data-state={props.state} data-testid={props.testId}>
      <span className="rc-label">
        {props.label}
        {props.sub && <small>{props.sub}</small>}
      </span>
      <span className="rc-input">{props.children}</span>
      <span className={`rc-help${props.error ? " st-alm" : ""}`}>
        {props.error ? (
          <>
            <span className="code">✕ {props.error.code}</span> {props.error.message}
            {props.error.path && <span className="muted"> · {props.error.path}</span>}
          </>
        ) : (
          props.help
        )}
      </span>
    </label>
  );
}

/**
 * Optional number: empty means "not set here" (inherit from the lower precedence levels). Out-of-range values
 * are kept in the document so the validator reports them with their stable codes instead of the field hiding them.
 */
export function NumberField(props: {
  label: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  testId: string;
  integer?: boolean;
  step?: number;
  placeholder?: string;
  /** The schema key of the field: an error whose path ends in it is shown on this row. */
  fieldKey?: string;
  sub?: string;
  unit?: string;
  help?: ReactNode;
}) {
  const error = useFieldError(props.fieldKey);
  const state: InputState = error ? "err" : props.value === undefined ? "inh" : "set";
  return (
    <FieldRow
      label={props.label}
      sub={props.sub}
      state={state}
      error={error}
      help={props.help ?? (props.value === undefined ? "inherited" : "set here")}
    >
      <input
        type="number"
        {...inputProps(props.testId, { step: props.step ?? (props.integer ? 1 : "any") })}
        aria-label={props.label}
        aria-invalid={error ? true : undefined}
        value={props.value ?? ""}
        placeholder={props.placeholder ?? "inherit"}
        onChange={(e) => {
          const t = e.target.value.trim();
          if (t === "") return props.onChange(undefined);
          const n = Number(t);
          if (Number.isFinite(n)) props.onChange(props.integer ? Math.trunc(n) : n);
        }}
      />
      {props.unit && <span className="unit">{props.unit}</span>}
    </FieldRow>
  );
}

/** Select over string options; the empty option is "inherit". */
export function OptionField<T extends string>(props: {
  label: string;
  value: T | undefined;
  options: readonly T[];
  onChange: (v: T | undefined) => void;
  testId: string;
  inheritLabel?: string;
  fieldKey?: string;
  sub?: string;
  help?: ReactNode;
}) {
  const error = useFieldError(props.fieldKey);
  const state: InputState = error ? "err" : props.value === undefined ? "inh" : "set";
  return (
    <FieldRow
      label={props.label}
      sub={props.sub}
      state={state}
      error={error}
      help={props.help ?? (props.value === undefined ? "inherited" : "set here")}
    >
      <select
        {...(inputProps(props.testId, {
          "aria-label": props.label,
        } as InputHTMLAttributes<HTMLInputElement>) as object)}
        value={props.value ?? ""}
        onChange={(e) => {
          const v = e.target.value;
          props.onChange(v === "" ? undefined : (props.options.find((o) => o === v) ?? undefined));
        }}
      >
        <option value="">{props.inheritLabel ?? "(inherit)"}</option>
        {props.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </FieldRow>
  );
}

/** A validation problem: glyph + stable code + message (colour is never the only signal). */
export function Issue(props: { code: string; message: string; testId: string; children?: ReactNode }) {
  return (
    <p className="danger issue" role="alert" data-testid={props.testId}>
      ✕ <span className="mono">{props.code}</span> {props.message}
      {props.children}
    </p>
  );
}

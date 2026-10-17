import NativeSelect from "@mui/material/NativeSelect";
import TextField from "@mui/material/TextField";
import type { InputHTMLAttributes, ReactNode } from "react";

const inputProps = (testId: string, extra: InputHTMLAttributes<HTMLInputElement> = {}) => ({ "data-testid": testId, className: "mono", ...extra }) as InputHTMLAttributes<HTMLInputElement>;

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
}) {
  return (
    <TextField
      label={props.label}
      type="number"
      size="small"
      value={props.value ?? ""}
      placeholder={props.placeholder ?? "inherit"}
      onChange={(e) => {
        const t = e.target.value.trim();
        if (t === "") return props.onChange(undefined);
        const n = Number(t);
        if (Number.isFinite(n)) props.onChange(props.integer ? Math.trunc(n) : n);
      }}
      slotProps={{ htmlInput: inputProps(props.testId, { step: props.step ?? (props.integer ? 1 : "any") }), inputLabel: { shrink: true } }}
    />
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
}) {
  return (
    <label className="field">
      <span className="field-label">{props.label}</span>
      <NativeSelect
        value={props.value ?? ""}
        onChange={(e) => {
          const v = e.target.value;
          props.onChange(v === "" ? undefined : (props.options.find((o) => o === v) ?? undefined));
        }}
        inputProps={inputProps(props.testId, { "aria-label": props.label } as InputHTMLAttributes<HTMLInputElement>) as object}
      >
        <option value="">{props.inheritLabel ?? "(inherit)"}</option>
        {props.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </NativeSelect>
    </label>
  );
}

/** A validation problem: glyph + stable code + message (colour is never the only signal). */
export function Issue(props: { code: string; message: string; testId: string; children?: ReactNode }) {
  return (
    <p className="danger issue" role="alert" data-testid={props.testId}>
      ✗ <span className="mono">{props.code}</span> {props.message}
      {props.children}
    </p>
  );
}

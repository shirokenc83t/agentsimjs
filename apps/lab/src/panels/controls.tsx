import type { ChangeEvent, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

/**
 * The plain controls of the Configurations panels (ADR-0042): square, token-styled, no library behind them. Their props follow the
 * few the forms use; the look is `.btn`, `.rc-input` and the field rows of panels.css.
 */

/** `contained` is the primary action, `error` the destructive one; anything else is a plain button. */
export function Button(props: {
  variant?: "contained" | "outlined" | "text";
  color?: "inherit" | "error";
  size?: "small";
  disabled?: boolean | undefined;
  onClick?: () => void;
  children: ReactNode;
  "aria-disabled"?: boolean;
  "aria-pressed"?: boolean;
  "aria-label"?: string;
  "data-testid"?: string;
}) {
  const { variant, color, size: _size, children, ...rest } = props;
  const pressed = props["aria-pressed"] === true;
  return (
    <button
      type="button"
      className={`btn${variant === "contained" && !pressed && color === undefined ? " pri" : ""}${pressed ? " on" : ""}${color === "error" ? " dng" : ""}`}
      {...rest}
    >
      {children}
    </button>
  );
}

/** A native select; `inputProps` carries its label and test ID. */
export function NativeSelect(props: {
  value: string;
  onChange: (e: ChangeEvent<HTMLSelectElement>) => void;
  inputProps?: object;
  children: ReactNode;
}) {
  return (
    <select
      className="rc-select mono"
      value={props.value}
      onChange={props.onChange}
      {...(props.inputProps as SelectHTMLAttributes<HTMLSelectElement>)}
    >
      {props.children}
    </select>
  );
}

/** A labelled text input; the error state shows the alarm edge and tint with the message under it. */
export function TextField(props: {
  label: string;
  value: string;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  error?: boolean | undefined;
  helperText?: string | undefined;
  size?: "small";
  slotProps?: { htmlInput?: InputHTMLAttributes<HTMLInputElement> };
}) {
  const extra = props.slotProps?.htmlInput;
  return (
    <label className="rc-tf">
      <span className="field-label">{props.label}</span>
      <input
        {...extra}
        className={`rc-text-in${extra?.className ? ` ${extra.className}` : ""}${props.error ? " err" : ""}`}
        value={props.value}
        aria-label={props.label}
        aria-invalid={props.error ? true : undefined}
        onChange={props.onChange}
      />
      {props.helperText && <span className="rc-help st-alm">{props.helperText}</span>}
    </label>
  );
}

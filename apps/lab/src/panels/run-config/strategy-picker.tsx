import { PLANNING_STRATEGY_PRESETS, type PlanningEntry, type PlanningStrategy, type StrategyRef } from "@agentsim/scenarios";
import { useMemo, useState } from "react";
import { FieldRow, Issue } from "./fields.tsx";
import { parseInlineStrategy, strategyRefOf } from "./model.ts";

const INLINE = "inline";
const refKey = (r: { readonly id: string; readonly version: number } | { readonly ref: string; readonly version: number }): string => `${"ref" in r ? r.ref : r.id}@${r.version}`;

function presetOf(key: string): PlanningStrategy | undefined {
  return PLANNING_STRATEGY_PRESETS.find((p) => refKey(p) === key);
}

/** A resolver error as the panel got it: stable code, message and the path into the document. */
export interface StrategyIssue {
  readonly code: string;
  readonly message: string;
  readonly path?: string | undefined;
}

/**
 * The planner of one planning entry when it is a strategy (ADR-0037): a shipped preset (shown read-only) or an inline
 * JSON document. The editor checks JSON syntax only; the resolver's codes and paths for everything else arrive as
 * `issue` and are shown next to the editor. A preset is copied into the inline editor on request, never edited in place
 * (shipped strategies are immutable by id and version).
 */
export function StrategyPicker(props: { value: NonNullable<PlanningEntry["strategy"]>; onChange: (s: NonNullable<PlanningEntry["strategy"]>) => void; issue?: StrategyIssue | undefined }) {
  const ref = strategyRefOf({ strategy: props.value });
  const selected = ref ? refKey({ ref: ref.ref, version: ref.version }) : INLINE;
  const preset = ref ? presetOf(selected) : undefined;
  const choose = (key: string) => {
    if (key === INLINE) return props.onChange(preset ? asInline(preset) : props.value);
    const p = presetOf(key);
    if (p) props.onChange({ ref: p.id, version: p.version } satisfies StrategyRef);
  };
  return (
    <div data-testid="rc-strategy">
      <FieldRow
        label="strategy"
        state="set"
        help={
          preset && (
            <button type="button" className="btn" onClick={() => props.onChange(asInline(preset))} data-testid="rc-strategy-edit-inline">
              Edit as inline
            </button>
          )
        }
      >
        <select className="mono" value={selected} onChange={(e) => choose(e.target.value)} aria-label="Strategy" data-testid="rc-strategy-preset">
          {PLANNING_STRATEGY_PRESETS.map((p) => (
            <option key={refKey(p)} value={refKey(p)}>
              {p.id} · v{p.version}
            </option>
          ))}
          <option value={INLINE}>inline JSON…</option>
        </select>
      </FieldRow>
      {ref && !preset && <Issue code="strategy_unknown_ref" message={`no shipped strategy ${ref.ref} v${ref.version}`} testId="rc-strategy-error" />}
      {preset ? (
        <>
          <p className="muted" data-testid="rc-strategy-description">
            {preset.description}
          </p>
          <pre className="mono strategy-view" data-testid="rc-strategy-view" aria-label="Strategy document (read-only)">
            {JSON.stringify(preset.root, null, 2)}
          </pre>
        </>
      ) : ref ? null : (
        <InlineEditor value={props.value} onChange={props.onChange} />
      )}
      {props.issue && !(ref && !preset) && (
        <Issue code={props.issue.code} message={props.issue.message} testId="rc-strategy-error">
          {props.issue.path && <span className="muted mono"> at {props.issue.path}</span>}
        </Issue>
      )}
    </div>
  );
}

const asInline = (p: PlanningStrategy): NonNullable<PlanningEntry["strategy"]> => JSON.parse(JSON.stringify(p)) as NonNullable<PlanningEntry["strategy"]>;

/** The inline document as text; a parseable text goes into the draft at once (the resolver judges it), a broken one stays here. */
function InlineEditor(props: { value: NonNullable<PlanningEntry["strategy"]>; onChange: (s: NonNullable<PlanningEntry["strategy"]>) => void }) {
  const initial = useMemo(() => JSON.stringify(props.value, null, 2), [props.value]);
  const [text, setText] = useState(initial);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  return (
    <>
      <textarea
        className="mono rc-textarea"
        rows={10}
        value={text}
        spellCheck={false}
        aria-label="Strategy JSON"
        data-testid="rc-strategy-json"
        onChange={(e) => {
          const t = e.target.value;
          setText(t);
          const r = parseInlineStrategy(t);
          if (!r.ok) return setError(r);
          setError(null);
          if (r.value) props.onChange(r.value);
        }}
      />
      {error && <Issue code={error.code} message={error.message} testId="rc-strategy-json-error" />}
    </>
  );
}

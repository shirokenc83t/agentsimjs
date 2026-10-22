import { F1_FEATURES, type CostProfile, type Feature } from "@agentsim/scenarios";
import { Issue, NumberField } from "./fields.tsx";
import { constraintIssue, profileIssue } from "./model.ts";

/** Hard limits of the profile schema (ADR-0014): the form refuses to go past them. */
const MAX_CONSTRAINTS = 16;
const MAX_CONSTRAINT_CHARS = 512;

const FEATURE_HINT: Readonly<Record<Feature, string>> = {
  distance: "per metre",
  time: "per second at the body's speed",
  energy: "per Wh",
  terrain: "per metre × terrain code / 10 (UGV)",
  turn: "per radian of heading change",
  unknown: "× cost into never-observed cells (default 1: optimistic)",
};

/**
 * Cost-profile form (ADR-0014, ADR-0026): weights of the named F1 features and whitelisted constraints. The
 * profile is data: constraints are parsed against the expression grammar to report problems, never run as code.
 * Problems are shown inline with their stable codes; the profile is kept as typed so the codes stay visible.
 */
export function CostProfileForm(props: { value: CostProfile; onChange: (p: CostProfile) => void; testId: string }) {
  const p = props.value;
  const weights = p.weights ?? {};
  const constraints = p.constraints ?? [];
  const setWeight = (f: Feature, w: number | undefined) => {
    const next: Record<string, number> = { ...weights };
    if (w === undefined) delete next[f];
    else next[f] = w;
    props.onChange({ ...p, weights: next });
  };
  const setConstraints = (cs: string[]) => {
    const next: CostProfile = { ...p, constraints: cs };
    if (cs.length === 0) delete next.constraints;
    props.onChange(next);
  };
  const issue = profileIssue(p);
  return (
    <fieldset className="cost-profile" data-testid={props.testId}>
      <legend>Cost profile</legend>
      <div className="field-grid">
        {F1_FEATURES.map((f) => (
          <div key={f} className="field-with-hint">
            <NumberField label={f} value={weights[f]} onChange={(w) => setWeight(f, w)} testId={`${props.testId}-weight-${f}`} step={0.1} placeholder="0" />
            <span className="muted hint">{FEATURE_HINT[f]}</span>
          </div>
        ))}
      </div>
      <h5>Constraints</h5>
      <p className="muted hint">
        Boolean expressions over <span className="mono">altitude terrain slope vehicle distance turn</span>, e.g.{" "}
        <span className="mono">slope &lt; 0.3</span> or <span className="mono">vehicle == "ugv"</span>. A cell or move that breaks one is excluded.
      </p>
      {constraints.map((c, k) => {
        const ci = c.trim() === "" ? { code: "constraint_invalid", message: "empty constraint" } : constraintIssue(c);
        return (
          <div key={k} className="constraint-row">
            <input
              className={`mono rc-constraint${ci ? " err" : ""}`}
              value={c}
              aria-label={`constraint ${k + 1}`}
              aria-invalid={ci !== undefined ? true : undefined}
              placeholder={`constraint ${k + 1}`}
              spellCheck={false}
              data-testid={`${props.testId}-constraint-${k}`}
              onChange={(e) => setConstraints(constraints.map((x, j) => (j === k ? e.target.value.slice(0, MAX_CONSTRAINT_CHARS) : x)))}
            />
            <button type="button" className="btn" aria-label={`Remove constraint ${k + 1}`} onClick={() => setConstraints(constraints.filter((_, j) => j !== k))}>
              ✕
            </button>
            {ci && <Issue code={ci.code} message={ci.message} testId={`${props.testId}-constraint-${k}-issue`} />}
          </div>
        );
      })}
      <button type="button" className="btn" disabled={constraints.length >= MAX_CONSTRAINTS} onClick={() => setConstraints([...constraints, ""])} data-testid={`${props.testId}-add-constraint`}>
        + constraint
      </button>
      {/* Constraint problems are shown on their row; the profile line reports the rest (weights, features). */}
      {!issue ? (
        <p className="muted" data-testid={`${props.testId}-ok`}>
          ✓ valid profile
        </p>
      ) : issue.code !== "constraint_invalid" ? (
        <Issue code={issue.code} message={issue.message} testId={`${props.testId}-issue`} />
      ) : null}
    </fieldset>
  );
}

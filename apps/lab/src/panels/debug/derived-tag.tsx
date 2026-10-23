import type { ReplayDerived } from "../../sim/run-source.ts";

/** The mark of a derived run (a re-simulated window of another run, ADR-0035 section 3) in the title meta of the views that show it: `◇ derived`, the details in the tooltip. */
export function DerivedTag(props: { derived: ReplayDerived | undefined }) {
  const d = props.derived;
  if (d === undefined) return null;
  const verdict = d.status === "matches" ? "every recorded checkpoint in the window was reproduced" : `the first checkpoint that was not reproduced is at tick ${d.divergenceTick ?? "?"}`;
  return (
    <span className="derived-mark mono" data-testid="derived-tag" title={`A re-simulated window (${d.t0S.toFixed(1)}–${d.t1S.toFixed(1)} s) of ${d.parentRunId}: ${verdict}`}>
      ◇ derived
    </span>
  );
}

/** The `copyOf` of a record a derived run carries from its parent (`run-000001#12`), when it is one. */
export function copyOfRecord(payload: unknown): string | undefined {
  const c = payload !== null && typeof payload === "object" ? (payload as { copyOf?: unknown }).copyOf : undefined;
  return typeof c === "string" ? c : undefined;
}

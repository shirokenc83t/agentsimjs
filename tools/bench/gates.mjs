// The limits of one row of bench/thresholds.json, and whether a measurement meets them (used by check.mjs; tested in gates.test.ts).
//
// A row has one limit (`stat`, default p95, and `max`) or, for a row whose p95 is noisy, a gate on the median plus a looser guard on the tail (`stat: "median"`, `max`, and
// `tailStat`, default p95, with `tailMax`). With CI set, `ciStat`/`ciMax` replace all of that (shared runners, ADR-0030): one limit, no tail guard.

/** The limits that apply to a row in this mode, in the order they are shown. */
export function limitsOf(t, ci) {
  if (ci && t.ciMax !== undefined) return [{ stat: t.ciStat ?? t.stat ?? "p95", max: t.ciMax }];
  const limits = [{ stat: t.stat ?? "p95", max: t.max }];
  if (t.tailMax !== undefined) limits.push({ stat: t.tailStat ?? "p95", max: t.tailMax });
  return limits;
}

/** Whether a measurement meets every limit of its row (a row that is only reported always does), and which limits it does not. */
export function evaluate(t, m, ci) {
  const limits = limitsOf(t, ci);
  if (t.report) return { ok: true, limits, failures: [] };
  const failures = limits.filter((l) => !(typeof m[l.stat] === "number" && m[l.stat] <= l.max));
  return { ok: failures.length === 0, limits, failures };
}

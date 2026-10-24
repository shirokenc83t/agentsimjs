import { err, ok, type CodedError, type Result } from "@agentsim/core";
import type { RunHeader } from "@agentsim/trace";

/** Header consistency the schema cannot express: a scenario reference names both id and version. */
export function checkRunReferences(h: RunHeader): Result<void, CodedError<"invalid_header">> {
  if ((h.scenarioId === undefined) !== (h.scenarioVersion === undefined)) {
    return err({ code: "invalid_header", message: "scenarioId and scenarioVersion go together" });
  }
  return ok(undefined);
}

/**
 * What a derived run's header must say to be believable: the window runs forward, the span of ticks does too, a divergence is named exactly when the verdict is
 * `divergent`, and the run does not claim to be its own parent. That its parent exists is the store's to check (it holds the runs).
 */
export function checkRunDerived(h: RunHeader): Result<void, CodedError<"invalid_header">> {
  const d = h.derived;
  if (d === undefined) return ok(undefined);
  const bad = (message: string) => err({ code: "invalid_header" as const, message });
  // An imported derived run names a run of the database it came from, whose number can be the one this database gave the import.
  if (d.parentRunId === h.runId && h.importedFrom === undefined) return bad("a derived run is not its own parent");
  if (d.t1S < d.t0S) return bad("the window of a derived run ends before it starts");
  if (d.endTick < d.startTick) return bad("the ticks of a derived run end before they start");
  if ((d.status === "divergent") !== (d.divergence !== undefined)) return bad("a derived run names its divergence exactly when it is divergent");
  if (d.divergence !== undefined && (d.divergence.tick < d.startTick || d.divergence.tick > d.endTick)) return bad("the divergence of a derived run is outside its ticks");
  return ok(undefined);
}

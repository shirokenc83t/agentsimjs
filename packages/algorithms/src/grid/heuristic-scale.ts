import { err, ok, type CodedError, type Result } from "@agentsim/core";
import type { SearchSpace } from "./search-space.ts";

/**
 * Guard of ADR-0037 addition of 2026-10-13, §7: the heuristic of A* is admissible only if its scale (`heuristicPerCell`
 * per cell, i.e. per metre) is not above the cheapest cost per metre any move into a passable cell has on this view.
 * That cheapest cost is recomputed here from the view's own data (every passable cell's code and unknown flag), not
 * from the bound the view declared, so a view whose declared scale is wrong (a future cost feature that lowers the
 * minimum cost without lowering the bound) is caught. Turn costs only add and constraints only remove moves, so
 * neither can break it. A full scan of the view: for tests and the opt-in `checkAdmissibility` service option.
 */
export function checkHeuristicScale(space: SearchSpace): Result<undefined, CodedError<"heuristic_not_admissible">> {
  const mask = space.mask;
  const unknown = space.unknown;
  let cheapest = Number.POSITIVE_INFINITY;
  for (let n = 0; n < mask.length; n++) {
    const code = mask[n] ?? 0;
    if (code === 0) continue;
    let perMetre = space.basePerMetre + space.codePerMetre * code;
    if (unknown !== null && unknown[n] === 1) perMetre *= space.unknownFactor;
    if (perMetre < cheapest) cheapest = perMetre;
  }
  if (cheapest === Number.POSITIVE_INFINITY) return ok(undefined); // nothing passable: nothing to overestimate
  const scale = space.heuristicPerCell / space.resolutionM;
  if (scale > cheapest * (1 + 1e-12) + 1e-15) {
    return err({
      code: "heuristic_not_admissible",
      message: `the heuristic scale ${scale} per metre is above the cheapest move on this view (${cheapest} per metre): A* could return paths that are not optimal`,
    });
  }
  return ok(undefined);
}

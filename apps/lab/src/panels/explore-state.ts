import type { TraceRecord } from "@agentsim/trace";
import type { ExplorationView } from "@agentsim/ui";

/**
 * What exploration is doing for an agent at a moment (ADR-0040), from the run's records alone, so it reads the same live and from a
 * stored run: the iteration in progress (centre, radius, window), the targets set aside for it (temporary marks) and the targets
 * marked unreachable for good. The records are the agent's `explore-iteration` and `explore-target` notes and the start and end
 * of its explore action, in order; what happened after `uptoS` is not looked at (a replay window can reach past the cursor).
 * Marks that the map cleared since (a change around them) are not undone here: the overlay shows what explore marked.
 */
export function explorationOf(records: readonly TraceRecord[], agentId: string, uptoS: number, grid: { readonly sizeX: number; readonly resolutionM: number }): ExplorationView {
  let area: { x: number; y: number; radiusM: number; window: [number, number, number, number] } | undefined;
  let temporary: number[] = [];
  const permanent: number[] = [];
  const xyOf = (cell: number): [number, number] => [((cell % grid.sizeX) + 0.5) * grid.resolutionM, (Math.floor(cell / grid.sizeX) + 0.5) * grid.resolutionM];
  const windowOf = (w: unknown): [number, number, number, number] | undefined => (Array.isArray(w) && w.length === 4 && w.every((v) => typeof v === "number") ? (w as [number, number, number, number]) : undefined);
  for (const r of records) {
    if (r.agentId !== agentId || r.kind !== "action" || r.simTime > uptoS + 1e-9) continue;
    const p = r.payload as { op?: string; event?: string; name?: string; centre?: number[]; radiusM?: number; window?: unknown; group?: number; mark?: string };
    switch (p.op) {
      case "start":
        // A new explore: the iteration and the temporary marks of the one before are gone.
        if (p.name === "explore") {
          area = undefined;
          temporary = [];
        }
        break;
      case "end":
        if (p.name === "explore") {
          area = undefined;
          temporary = [];
        }
        break;
      case "explore-iteration": {
        temporary = [];
        const w = windowOf(p.window);
        if (p.event === "start" && p.centre && typeof p.radiusM === "number" && w) area = { x: p.centre[0] ?? 0, y: p.centre[1] ?? 0, radiusM: p.radiusM, window: w };
        else area = undefined;
        break;
      }
      case "explore-target": {
        // A target of an iteration names its centre and radius too, so a view that begins in the middle of one still has the area.
        const w = windowOf(p.window);
        if (p.event === "selected" && !area && p.centre && typeof p.radiusM === "number" && w) area = { x: p.centre[0] ?? 0, y: p.centre[1] ?? 0, radiusM: p.radiusM, window: w };
        if (p.event === "marked" && typeof p.group === "number") {
          const [x, y] = xyOf(p.group);
          if (p.mark === "temporary") temporary.push(x, y);
          else if (p.mark === "permanent") {
            temporary = withoutPoint(temporary, x, y);
            permanent.push(x, y);
          }
        }
        break;
      }
    }
  }
  return { ...(area ? { area } : {}), temporary, permanent };
}

function withoutPoint(xy: readonly number[], x: number, y: number): number[] {
  const out: number[] = [];
  for (let k = 0; k + 1 < xy.length; k += 2) if (xy[k] !== x || xy[k + 1] !== y) out.push(xy[k] ?? 0, xy[k + 1] ?? 0);
  return out;
}

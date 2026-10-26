import type { GridSpec } from "@agentsim/ui";
import { useEffect, useState } from "react";
import type { RunSource } from "../../sim/run-source.ts";
import type { MapModel } from "./analysis-model.ts";
import { blockedGridFrom } from "./world-map.ts";

/** How often the map asks the source for chunks that have not arrived (a replay reads them in the background), and how many times it asks. */
const RETRY_MS = 700;
const MAX_TRIES = 14;

/**
 * The blocked cells of the world for the top-down map, read through the run source (the live run's chunks, or the replay's): the same for a run being watched and a recorded
 * one. Chunks arrive after the run opens, so it reads again a few times until the cells are there; a run with no grid has none, and the map is drawn without obstacles.
 */
export function useBlockedGrid(source: Pick<RunSource, "cellAt">, dims: GridSpec["dims"] | undefined, runId: string | undefined): MapModel["blocked"] {
  const [grid, setGrid] = useState<MapModel["blocked"]>(undefined);
  useEffect(() => {
    setGrid(undefined);
    if (!dims) return;
    let tries = 0;
    let last = -1;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      const r = blockedGridFrom(dims, (i, j) => source.cellAt(i, j));
      // It reads again until two reads agree (every chunk is in), at most MAX_TRIES times.
      if (r.loaded && r.readCells !== last) setGrid(r.grid);
      const settled = r.loaded && r.readCells === last;
      last = r.readCells;
      if (!settled && ++tries < MAX_TRIES) timer = setTimeout(read, RETRY_MS);
    };
    read();
    return () => clearTimeout(timer);
  }, [source, dims, runId]);
  return grid;
}

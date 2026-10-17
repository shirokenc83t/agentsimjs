import { OCCUPANCY_BLOCKED } from "./grid/grid-space.ts";
import { GridSpatialModel } from "./spatial-model.ts";
import { describeSpatialModelContract } from "./testing/contract.ts";
import { buildReferenceGrid } from "./testing/reference-grid.ts";

describeSpatialModelContract("grid (GridSpatialModel)", () => {
  const grid = buildReferenceGrid();
  return {
    model: new GridSpatialModel(grid),
    blockAt: (x, y) => void grid.setCell("occupancy", grid.cellI(x), grid.cellJ(y), OCCUPANCY_BLOCKED),
  };
});

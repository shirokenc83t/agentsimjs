import { describeCorridorBands } from "./testing/corridor-bands.ts";

// Measured arrivals per band: 36, 185, 197, 189, 196 (CHANGELOG.md).
describeCorridorBands("forward-only", [32, 178, 190, 180, 190]);

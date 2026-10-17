import { describeCorridorBands } from "./testing/corridor-bands.ts";

// Measured arrivals per band: 59, 198, 200, 199, 200 (CHANGELOG.md).
describeCorridorBands("differential", [40, 190, 195, 190, 195]);

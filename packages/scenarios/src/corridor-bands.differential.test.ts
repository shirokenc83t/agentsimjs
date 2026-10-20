import { describeCorridorBands } from "./testing/corridor-bands.ts";

// Measured arrivals per band: 57, 198, 200, 200, 200 (the f3a tag and now, F2c M2).
describeCorridorBands("differential", [40, 190, 195, 190, 195]);

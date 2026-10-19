import { describeCorridorBands } from "./testing/corridor-bands.ts";

// Measured arrivals per band: 24, 181, 198, 195, 198 (the f3a tag and now, F2c M2).
describeCorridorBands("ackermann", [18, 172, 190, 185, 190]);

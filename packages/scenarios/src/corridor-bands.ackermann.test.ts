import { describeCorridorBands } from "./testing/corridor-bands.ts";

// Measured arrivals per band: 27, 182, 198, 195, 197 (CHANGELOG.md).
describeCorridorBands("ackermann", [18, 172, 190, 185, 190]);

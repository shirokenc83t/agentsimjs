import { describe, it } from "vitest";
import type { SimClient } from "../sim/sim-client.ts";
import type { ResearcherData } from "./researcher-data.ts";

// Type-level guard (checked by `pnpm typecheck`): observer data cannot be passed where anything is sent to the worker.
describe("researcher data has no way back to the worker", () => {
  it("is not assignable to a command's parameters or to a stream request", () => {
    const data = undefined as unknown as ResearcherData;
    // @ts-expect-error observer data is not a command parameter set
    const params: NonNullable<Parameters<SimClient["command"]>[2]> = data;
    // @ts-expect-error observer data is not a message to the worker
    const message: Parameters<SimClient["send"]>[0] = data;
    void params;
    void message;
  });
});

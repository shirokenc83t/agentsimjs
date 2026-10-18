import type { TraceRecord } from "@agentsim/trace";
import { f2DiscoveryScenario } from "@agentsim/scenarios";
import { latestPlans } from "./run-source.ts";

// Shared by the tests of replay: the scenario a recorded test run is made from, and the planned paths a trace says.

export { f2DiscoveryScenario };

/** The latest found plan per agent of some records, as the Scene draws planned paths. */
export const latestPlansOfRecords = (records: readonly TraceRecord[]) => latestPlans(records);

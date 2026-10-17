import type { SimResearcherDataMessage } from "@agentsim/core";
import type { StrategyTestResult } from "@agentsim/scenarios";

declare const researcherView: unique symbol;

/**
 * Observer data: how an agent's beliefs compare with the ground truth (ADR-0005 addition of 2026-10-12). The brand
 * makes it a type of its own, assignable to nothing else, so it cannot be passed to a command, a run input or any
 * message to the worker; only the researcher section takes it. Worker → UI only.
 */
export type ResearcherData = SimResearcherDataMessage & { readonly [researcherView]: "researcher view — not visible to the mind" };

export const asResearcherData = (m: SimResearcherDataMessage): ResearcherData => m as ResearcherData;

/**
 * A strategy test planned on the ground truth (ADR-0005, ADR-0037 item 16): what a path planned on the truth shows of the
 * world is observer data, so it has a brand of its own. The request that produced it carries none (`map: "truth"` and a
 * target), and nothing that sends to the worker accepts this type.
 */
export type ResearcherPlan = StrategyTestResult & { readonly [researcherView]: "researcher view — not visible to the mind" };

export const asResearcherPlan = (r: StrategyTestResult): ResearcherPlan => r as ResearcherPlan;

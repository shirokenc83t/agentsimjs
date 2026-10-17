import type { StrategyNode } from "./schema.ts";

/** What a (validated) strategy tree contains that the planner must prepare for or refuse. */
export interface StrategyFacts {
  /** Some leaf plans with `hpa`: the abstract graph must exist (built at load, ADR-0024). */
  readonly hpa: boolean;
  /** Some `refine` node is lazy (not executable before F2b M3). */
  readonly lazyRefine: boolean;
}

/** Walks the tree with an explicit stack (bounded by the node limit, ADR-0037 §1). */
export function strategyFacts(root: StrategyNode): StrategyFacts {
  let hpa = false;
  let lazyRefine = false;
  const stack: StrategyNode[] = [root];
  for (let n = stack.pop(); n !== undefined; n = stack.pop()) {
    switch (n.kind) {
      case "algorithm":
        if (n.algorithm === "hpa") hpa = true;
        break;
      case "anytime":
        break;
      case "select":
        for (const b of n.branches) stack.push(b.then);
        stack.push(n.else);
        break;
      case "fallback":
        for (const s of n.stages) stack.push(s);
        break;
      case "refine":
        if (n.mode === "lazy") lazyRefine = true;
        stack.push(n.coarse, n.local);
        break;
    }
  }
  return { hpa, lazyRefine };
}

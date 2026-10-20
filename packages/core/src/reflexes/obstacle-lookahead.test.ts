import { describe, expect, it } from "vitest";
import type { SimAgent } from "../actions/agent.ts";
import { makeUav } from "../actions/testing/fakes.ts";
import { obstacleReflex } from "./builtin.ts";
import type { ReflexContext } from "./reflex.ts";

// The look-ahead of the obstacle reflex samples the motion at least 0.5 m ahead, in steps of the move. A move of a picometre (a UAV
// finishing a leg a hair from its waypoint) must not make that half a billion samples: the number of samples is capped.
describe("the obstacle reflex's look-ahead", () => {
  const ctx = { proximity: { hits: () => [500, 500] } } as unknown as ReflexContext;
  const agent: SimAgent = makeUav(10, 10, 20, true);

  it("returns at once for a move of a picometre, and still looks ahead for a normal one", () => {
    const t0 = Date.now();
    expect(obstacleReflex.beforeMove?.(ctx, agent, { x: 10, y: 10, z: 20 }, { x: 10 + 1e-12, y: 10, z: 20 }, undefined)).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(500);
    // A sensed obstacle 0.3 m ahead of a 0.1 m step, not on the plan's map: the reflex fires.
    const near = { proximity: { hits: () => [10.4, 10] } } as unknown as ReflexContext;
    expect(obstacleReflex.beforeMove?.(near, agent, { x: 10, y: 10, z: 20 }, { x: 10.1, y: 10, z: 20 }, undefined)?.code).toBe("obstacle_ahead");
  });
});

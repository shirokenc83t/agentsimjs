import { isBatteryCritical } from "../body/battery.ts";
import type { SimAgent } from "../actions/agent.ts";
import type { PlanMap } from "../actions/ports.ts";
import type { Pose, Reflex, ReflexContext, ReflexTrigger } from "./reflex.ts";

/** How far ahead (along the motion) the obstacle reflex looks, at least. */
const MIN_LOOKAHEAD_M = 0.5;
/** Most look-ahead samples of one move: a move of a picometre (a UAV finishing a leg a hair from its waypoint) is not half a trillion samples. */
const MAX_LOOKAHEAD_SAMPLES = 64;

/**
 * Obstacle avoidance: stops the body before an obstacle that the plan did not account for. It looks ahead
 * along the motion (at least 0.5 m, at least two steps); an imminent obstacle is a point the proximity sensors
 * last reported within the footprint of a look-ahead position (ADR-0012 addition of 2026-10-09: it acts on what
 * the agent senses, never on ground truth, so a missed obstacle can be hit). It acts only if the plan's map
 * showed that spot as free: known obstacles are the planner's job, so reflex and planner never fight over them.
 * Without a plan (e.g. hold), nothing is accounted for.
 */
export const obstacleReflex: Reflex = {
  name: "obstacle",
  beforeMove(ctx: ReflexContext, agent: SimAgent, from: Pose, to: Pose, planMap: PlanMap | undefined): ReflexTrigger | undefined {
    const hits = ctx.proximity?.hits(agent.id);
    if (!hits || hits.length === 0) return undefined;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const step = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (step === 0) return undefined;
    const fp = agent.body.footprintRadiusM;
    const samples = Math.min(MAX_LOOKAHEAD_SAMPLES, Math.max(2, Math.ceil(MIN_LOOKAHEAD_M / step)));
    for (let k = 1; k <= samples; k++) {
      const x = from.x + dx * k;
      const y = from.y + dy * k;
      let blocked = false;
      for (let h = 0; h + 1 < hits.length && !blocked; h += 2) {
        const ex = (hits[h] ?? 0) - x;
        const ey = (hits[h + 1] ?? 0) - y;
        blocked = ex * ex + ey * ey < fp * fp;
      }
      if (!blocked) continue;
      const accounted = planMap !== undefined && planMap.clearanceM(x, y, fp) < fp;
      if (accounted) return undefined;
      return { code: "obstacle_ahead", message: `a sensed obstacle not on the plan's map is ${(step * k).toFixed(2)} m ahead` };
    }
    return undefined;
  },
};

/** Geofence: never leave the map or a geofence, never enter a no-fly volume. A hard, legal limit. */
export const geofenceReflex: Reflex = {
  name: "geofence",
  beforeMove(ctx: ReflexContext, _agent: SimAgent, _from: Pose, to: Pose): ReflexTrigger | undefined {
    return ctx.spatial.insideFence(to.x, to.y, to.z) ? undefined : { code: "geofence", message: "the next position is outside the geofence or inside a no-fly volume" };
  },
};

/**
 * Critical battery: once the state of charge reaches the body's critical level, the running action is
 * preempted and the agent returns to base (a UAV lands there); without a base, a UAV lands where it is and
 * a UGV holds. Latched: it acts once per agent. The latch is run state: `snapshot()` lists the agents it has acted on
 * (sorted) and `restore()` puts them back.
 */
export function batteryReflex(): Reflex {
  const fired = new Set<string>();
  return {
    name: "battery",
    snapshot: () => [...fired].sort(),
    restore(data: unknown): void {
      if (!Array.isArray(data) || data.some((id) => typeof id !== "string")) throw new RangeError("battery reflex snapshot must be a list of agent IDs");
      fired.clear();
      for (const id of data as string[]) fired.add(id);
    },
    afterStep(_ctx: ReflexContext, agent: SimAgent, runningAction: string | undefined): ReflexTrigger | undefined {
      if (fired.has(agent.id) || !isBatteryCritical(agent.battery, agent.body.battery) || agent.battery.soc <= 0) return undefined;
      if (runningAction === "returnToBase" || runningAction === "land") return undefined;
      fired.add(agent.id);
      const msg = `battery at ${(agent.battery.soc * 100).toFixed(1)} % (critical ${(agent.body.battery.criticalSoc * 100).toFixed(0)} %)`;
      if (agent.base) return { code: "battery_critical", message: msg, then: { name: "returnToBase", params: {} } };
      if (agent.kind === "uav" && agent.state.airborne) return { code: "battery_critical", message: msg, then: { name: "land", params: {} } };
      return { code: "battery_critical", message: msg, then: { name: "hold", params: {} } };
    },
  };
}

/** The F1 reflex set, in priority order (first trigger wins). */
export function defaultReflexes(): Reflex[] {
  return [geofenceReflex, obstacleReflex, batteryReflex()];
}

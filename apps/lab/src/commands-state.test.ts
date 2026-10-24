import { describe, expect, it } from "vitest";
import { commandButtonState } from "./commands.ts";
import type { ActionView, CommandView, ReflexView } from "./panels/agent-views.ts";

// The state of an action button comes from the action's state in the trace and not from the click (U-010 §1).

const action = (over: Partial<ActionView> = {}): ActionView => ({ actionId: "act-1", name: "explore", status: "running", phase: "following", failure: undefined, startedAtS: 1, ...over });
const refused: CommandView = { name: "land", ok: false, failure: "precondition_failed", requires: "airborne", atS: 3 };
const opts = { doneVisible: true, refusalAcked: false, kind: "uav" };

describe("the state of an action button", () => {
  it("is idle when nothing of this action is going on, and another action's state is not this one's", () => {
    expect(commandButtonState("explore", { action: undefined, command: undefined, reflex: undefined }, opts)).toEqual({ state: "idle" });
    expect(commandButtonState("land", { action: action(), command: undefined, reflex: undefined }, opts)).toEqual({ state: "idle" });
  });

  it("is running while this is the agent's current action, with its phase", () => {
    expect(commandButtonState("explore", { action: action(), command: undefined, reflex: undefined }, opts)).toEqual({ state: "running", phase: "following" });
  });

  it("is done when the action succeeded, for as long as the view says (4 s of wall time), then idle again", () => {
    const v = { action: action({ status: "succeeded" }), command: undefined, reflex: undefined };
    expect(commandButtonState("explore", v, opts)).toEqual({ state: "done" });
    expect(commandButtonState("explore", v, { ...opts, doneVisible: false })).toEqual({ state: "idle" });
  });

  it("is refused, in words, until the next click, and the refusal is that of this action", () => {
    const v = { action: undefined, command: refused, reflex: undefined };
    expect(commandButtonState("land", v, opts)).toEqual({ state: "refused", words: "land needs airborne · take off first" });
    expect(commandButtonState("land", v, { ...opts, refusalAcked: true })).toEqual({ state: "idle" });
    expect(commandButtonState("explore", v, opts)).toEqual({ state: "idle" });
  });

  it("is preempted when a reflex took the action over, naming the reflex", () => {
    const reflex: ReflexView = { reflex: "obstacle", code: "obstacle_ahead", then: undefined, atS: 5 };
    expect(commandButtonState("explore", { action: action({ status: "preempted" }), command: undefined, reflex }, opts)).toEqual({ state: "preempted", reflex: "obstacle" });
  });
});

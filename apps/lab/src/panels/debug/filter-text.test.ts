import { describe, expect, it } from "vitest";
import { parseFilter } from "@agentsim/trace";
import { shownChoices, termValues, toggleChoice, withTermValues } from "./filter-text.ts";

// The toggles of the log console write into the filter text: the text stays the one state, and every result is a filter that parses.

const KINDS = ["action", "reflex", "event", "snapshot"] as const;

describe("reading and rewriting one term of a filter", () => {
  it("finds the values of the first positive term of a key", () => {
    expect(termValues("agent:uav-001 kind:action,event t:>5", "kind")).toEqual(["action", "event"]);
    expect(termValues("agent:uav-001", "kind")).toBeUndefined();
    expect(termValues("-kind:snapshot", "kind")).toBeUndefined(); // a negated term is the researcher's, not the toggles'
    expect(termValues('text:"kind:x"', "kind")).toBeUndefined();
  });

  it("replaces the term in place, keeping the others and the spacing as typed", () => {
    expect(withTermValues("agent:uav-001  kind:action  t:>5", "kind", ["event", "reflex"])).toBe("agent:uav-001  kind:event,reflex  t:>5");
  });

  it("appends a term the filter does not have, and removes one that is set to nothing", () => {
    expect(withTermValues("agent:uav-001", "kind", ["action"])).toBe("agent:uav-001 kind:action");
    expect(withTermValues("", "kind", ["action"])).toBe("kind:action");
    expect(withTermValues("agent:uav-001 kind:action t:>5", "kind", undefined)).toBe("agent:uav-001 t:>5");
    expect(withTermValues("kind:action t:>5", "kind", [])).toBe("t:>5");
    expect(withTermValues("t:>5 kind:action", "kind", undefined)).toBe("t:>5");
    expect(withTermValues("kind:action", "kind", undefined)).toBe("");
    expect(withTermValues("agent:uav-001", "kind", undefined)).toBe("agent:uav-001");
  });
});

describe("the toggle of one choice (kinds, tiers)", () => {
  it("with no term every choice is shown; a click on one hides it and writes the others", () => {
    expect(toggleChoice("", "kind", "snapshot", KINDS, false)).toBe("kind:action,reflex,event");
    expect(toggleChoice("agent:uav-001", "kind", "action", KINDS, false)).toBe("agent:uav-001 kind:reflex,event,snapshot");
  });

  it("a click on a hidden one shows it again, in the order of the choices; all shown again is no term", () => {
    expect(toggleChoice("kind:reflex,event", "kind", "action", KINDS, false)).toBe("kind:action,reflex,event");
    expect(toggleChoice("kind:action,reflex,event", "kind", "snapshot", KINDS, false)).toBe("");
  });

  it("hiding the last one shown is no filter, not an empty console", () => {
    expect(toggleChoice("kind:event", "kind", "event", KINDS, false)).toBe("");
  });

  it("shift+click shows one alone, and again shows all", () => {
    expect(toggleChoice("", "kind", "reflex", KINDS, true)).toBe("kind:reflex");
    expect(toggleChoice("kind:reflex", "kind", "reflex", KINDS, true)).toBe("");
    expect(toggleChoice("kind:action,event", "kind", "event", KINDS, true)).toBe("kind:event");
  });

  it("reads which choices the text shows, and every text a toggle writes is a filter that parses", () => {
    expect([...shownChoices("kind:action,event", "kind", KINDS)]).toEqual(["action", "event"]);
    expect([...shownChoices("agent:uav-001", "kind", KINDS)]).toEqual([...KINDS]);
    let text = "agent:uav-001 t:>5";
    for (const [k, solo] of [["action", false], ["event", false], ["snapshot", true], ["snapshot", true], ["reflex", false]] as const) {
      text = toggleChoice(text, "kind", k, KINDS, solo);
      expect(parseFilter(text).ok, text).toBe(true);
    }
  });
});

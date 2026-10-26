import { createMemoryPorts, type StorageClient } from "@agentsim/storage";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ServicesProvider } from "../../services.tsx";
import type { RunSnapshot, RunSource } from "../../sim/run-source.ts";
import type { SimClient } from "../../sim/sim-client.ts";
import { effectiveFilter, EventListPanel, readFilter } from "./event-list-panel.tsx";

// The log console (UI-SPEC section 5): the prompt takes the filter language and says what is wrong and where; the quick toggles write into the text, and the text is read by them.
// (The rows are virtualized and need a layout: the rows, the tail and the keys are the e2e specs'; the rows' data is useLogRows' test.)

function setup() {
  const ports = createMemoryPorts();
  const view = { runId: "run-000001", entityIds: ["ugv-001", "uav-001"], run: { dtS: 0.1 }, persistedHeadTick: 100, simHeadTick: 100, mode: "replay" } as unknown as RunSnapshot;
  const source = { mode: "replay", snapshot: () => view } as unknown as RunSource;
  const storage = { ports, live: { subscribe: async () => ({ ok: true }), unsubscribe: async () => undefined, change: async () => ({ ok: true }) }, status: () => ({ state: "ready", mode: "memory-fallback" }), onStatus: () => () => {} } as unknown as StorageClient;
  render(
    <ServicesProvider value={{ storage, sim: {} as SimClient, source, setReplaySource: () => {} }}>
      <EventListPanel />
    </ServicesProvider>,
  );
  return { ports, input: screen.getByTestId("log-filter") as HTMLInputElement };
}

/** A click with shift held (user-event takes the modifier as a key held). */
async function shiftClick(el: HTMLElement) {
  const user = userEvent.setup(); // one instance: the held key is its state
  await user.keyboard("{Shift>}");
  await user.click(el);
  await user.keyboard("{/Shift}");
}

describe("readFilter", () => {
  it("is the text when it parses, and why and where when it does not", () => {
    expect(readFilter("kind:action agent:ugv-001")).toEqual({ ok: true, text: "kind:action agent:ugv-001" });
    expect(readFilter("")).toEqual({ ok: true, text: "" });
    expect(readFilter("kind:event agent:UAV")).toMatchObject({ ok: false, at: 11, message: expect.stringContaining("agent id") });
    expect(readFilter('text:"open')).toMatchObject({ ok: false, at: 5 });
  });

  it("a metric filter is not one for the console, which lists records, and says where the metric term is", () => {
    const r = readFilter("agent:uav-001 metric:agent.soc");
    expect(r).toMatchObject({ ok: false, at: 14 });
    expect(r.ok ? "" : r.message).toMatch(/lists records/);
  });
});

describe("effectiveFilter", () => {
  it("leaves the pose samples out unless the filter names a source", () => {
    expect(effectiveFilter("")).toBe("-source:*/body");
    expect(effectiveFilter("kind:action")).toBe("kind:action -source:*/body");
    expect(effectiveFilter("source:*/body kind:observation")).toBe("source:*/body kind:observation");
    expect(effectiveFilter("-source:*/planner")).toBe("-source:*/planner");
  });
});

describe("the log console's prompt", () => {
  it("takes a filter as typed, and a filter that does not parse is shown with its reason and its place, and nothing partial is run", async () => {
    const { input } = setup();
    expect(screen.queryByTestId("log-filter-error")).toBeNull();
    await userEvent.type(input, "kind:action agent:UAV");
    const err = await screen.findByTestId("log-filter-error");
    expect(err).toHaveTextContent("not an agent id");
    expect(err).toHaveTextContent("at 12");
    expect(err.querySelector(".log-caret")?.textContent).toBe("kind:action agent:UAV\n            ^");
    expect(input).toHaveAttribute("aria-invalid", "true");
    await userEvent.clear(input);
    await userEvent.type(input, "kind:action agent:uav-001");
    await waitFor(() => expect(screen.queryByTestId("log-filter-error")).toBeNull());
    expect(input).toHaveAttribute("aria-invalid", "false");
  });

  it("the kind toggles write into the text and read from it", async () => {
    const { input } = setup();
    const chip = (k: string) => screen.getByTestId(`event-kind-${k}`);
    expect(chip("action")).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(chip("snapshot"));
    expect(input.value).toBe("kind:action,reflex,injected,degradation,compute,plan,event,lifecycle,observation,thought,message");
    expect(chip("snapshot")).toHaveAttribute("aria-pressed", "false");
    await shiftClick(chip("reflex"));
    expect(input.value).toBe("kind:reflex");
    expect(chip("reflex")).toHaveAttribute("aria-pressed", "true");
    expect(chip("action")).toHaveAttribute("aria-pressed", "false");
    // Typed by hand, the chips follow.
    await userEvent.clear(input);
    await userEvent.type(input, "agent:uav-001 kind:event,plan");
    expect(chip("event")).toHaveAttribute("aria-pressed", "true");
    expect(chip("plan")).toHaveAttribute("aria-pressed", "true");
    expect(chip("action")).toHaveAttribute("aria-pressed", "false");
    // A toggle keeps the other terms as they are.
    await userEvent.click(chip("action"));
    expect(input.value).toBe("agent:uav-001 kind:action,plan,event");
  });

  it("the tier toggles and the agent choice write into the text too", async () => {
    const { input } = setup();
    await shiftClick(screen.getByTestId("event-tier-S2"));
    expect(input.value).toBe("tier:S2");
    await userEvent.selectOptions(screen.getByTestId("event-filter-agent"), "ugv-001");
    expect(input.value).toBe("tier:S2 agent:ugv-001");
    await userEvent.selectOptions(screen.getByTestId("event-filter-agent"), "");
    expect(input.value).toBe("tier:S2");
  });

  it("saves the filter under a name, offers it again, and forgets it", async () => {
    const { input, ports } = setup();
    await userEvent.type(input, "kind:action agent:ugv-001");
    await userEvent.click(screen.getByTestId("log-save"));
    await userEvent.type(screen.getByTestId("log-save-name"), "rover actions{Enter}");
    await waitFor(async () => expect(await ports.userData.get("log", "savedFilters")).toEqual([{ name: "rover actions", text: "kind:action agent:ugv-001" }]));
    await userEvent.clear(input);
    expect(input.value).toBe("");
    await userEvent.selectOptions(screen.getByTestId("log-saved"), "rover actions");
    expect(input.value).toBe("kind:action agent:ugv-001");
    await userEvent.click(screen.getByTestId("log-unsave"));
    await waitFor(async () => expect(await ports.userData.get("log", "savedFilters")).toEqual([]));
  });

  it("a replay has no tail: no tail state is shown", () => {
    setup();
    expect(screen.queryByTestId("log-tail")).toBeNull();
  });
});

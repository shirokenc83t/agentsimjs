import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mindsFixture } from "./minds-fixture.ts";
import { LimitNotice, MindsStatusSegments, MindsTiles, WaitingNote, waitingWords } from "./minds-ui.tsx";
import { clearMinds, setMinds, WARNING_NOTICE_MS } from "./minds-status.ts";

// The System 2 minds in the shell, with the states of the designer's board LimitsPause: the wait, the tiles, the chips, the 80 % notice, the pause notice and the dialog that raises a limit.

const NBSP = " ";
beforeEach(() => clearMinds());
afterEach(() => {
  clearMinds();
  vi.useRealTimers();
});

describe("waiting for S2", () => {
  it("says how many decisions wait and, for one agent, which and for how long; for several, the longest", () => {
    expect(waitingWords(mindsFixture("waiting"), 2400)).toBe("◷ waiting for S2 (1) · uav-001 · 2.4 s");
    expect(waitingWords(mindsFixture("waiting-several"), 4100)).toBe("◷ waiting for S2 (3) · longest 4.1 s");
  });

  it("shows under the clock only while a decision waits, and the status bar says it too", () => {
    render(
      <>
        <WaitingNote />
        <MindsStatusSegments />
      </>,
    );
    expect(screen.queryByTestId("player-s2-wait")).toBeNull();
    act(() => setMinds(mindsFixture("waiting"), performance.now()));
    expect(screen.getByTestId("player-s2-wait").textContent).toMatch(/^◷ waiting for S2 \(1\) · uav-001 · \d\.\d s$/);
    expect(screen.getByTestId("status-s2-wait").textContent).toMatch(/waiting for S2 \(1\)/);
    act(() => setMinds(mindsFixture("quiet")));
    expect(screen.queryByTestId("player-s2-wait")).toBeNull();
  });
});

describe("the player's tiles and the status bar's chips", () => {
  it("show what the mind has used of its limits, plain below 80 % and in the warning colour from it, with the chip", () => {
    render(
      <>
        <MindsTiles />
        <MindsStatusSegments />
      </>,
    );
    act(() => setMinds(mindsFixture("quiet")));
    expect(screen.getByTestId("player-llm-tile").textContent).toContain("11.2k /40k tok");
    expect(screen.getByTestId("player-llm-tile").getAttribute("data-warn")).toBe("false");
    expect(screen.queryByTestId("status-s2-warning")).toBeNull();
    act(() => setMinds(mindsFixture("warning")));
    expect(screen.getByTestId("player-llm-tile").getAttribute("data-warn")).toBe("true");
    expect(screen.getByTestId("player-llm-tile").textContent).toContain("32.8k /40k tok");
    expect(screen.getByTestId("player-calls-tile").textContent).toContain("13 /20");
    expect(screen.getByTestId("status-s2-warning").textContent).toBe("▲ tokens 82 % · uav-001");
    expect(screen.getByTestId("status-s2-minds").textContent).toBe("live · local-ollama · qwen2.5:7b");
  });

  it("show the pause as a chip with the figures, and after a raise the new limit in the tile", () => {
    render(
      <>
        <MindsTiles />
        <MindsStatusSegments />
      </>,
    );
    act(() => setMinds(mindsFixture("paused")));
    expect(screen.getByTestId("status-s2-limit").textContent).toBe(`■ tokens 40${NBSP}912 / 40${NBSP}000 · uav-001`);
    act(() => setMinds(mindsFixture("raised")));
    expect(screen.queryByTestId("status-s2-limit")).toBeNull();
    expect(screen.getByTestId("player-llm-tile").textContent).toContain("40.9k /80k tok");
  });
});

describe("the notice of a limit", () => {
  const props = () => ({ dtS: 0.1, onRaise: vi.fn(), onStop: vi.fn() });

  it("at the limit says which limit and whom, what was used with its meter, the other limits, that the world waits and nothing is lost, and offers Raise limit and Stop run", async () => {
    render(<LimitNotice {...props()} />);
    expect(screen.queryByTestId("limit-notice")).toBeNull();
    act(() => setMinds(mindsFixture("paused")));
    const n = screen.getByTestId("limit-notice");
    expect(within(n).getByText("Run paused: token limit reached")).toBeDefined();
    expect(n.textContent).toContain("34.2 s · tick 342");
    expect(n.textContent).toContain(`tokens per run · uav-001 · profile scout-llm v3`);
    expect(screen.getByTestId("limit-used").textContent).toContain(`40${NBSP}912 of 40${NBSP}000 (102 %)`);
    expect(n.textContent).toContain(`calls 14 / 20`);
    expect(n.textContent).toContain("cost — (no prices for local-ollama)");
    expect(n.textContent).toContain("The world waits at tick 342. Nothing is lost");
    expect(within(n).getByTestId("limit-raise").textContent).toBe("Raise limit…");
    expect(within(n).getByTestId("limit-stop").textContent).toBe("■ Stop run");
    expect(n.getAttribute("role")).toBe("alertdialog");
  });

  it("Stop run answers stop for that agent and limit", async () => {
    const p = props();
    render(<LimitNotice {...p} />);
    act(() => setMinds(mindsFixture("paused")));
    await userEvent.click(screen.getByTestId("limit-stop"));
    expect(p.onStop).toHaveBeenCalledWith({ agentId: "uav-001", limit: "tokens" });
    expect(p.onRaise).not.toHaveBeenCalled();
  });

  it("Raise limit opens a modal that states the new value, what it allows and whose consumption it is; its button says the value and raises to it", async () => {
    const p = props();
    render(<LimitNotice {...p} />);
    act(() => setMinds(mindsFixture("paused")));
    await userEvent.click(screen.getByTestId("limit-raise"));
    const d = screen.getByTestId("raise-dialog");
    expect(d.getAttribute("role")).toBe("dialog");
    expect(d.getAttribute("aria-modal")).toBe("true");
    expect(d.textContent).toContain("Raise the token limit for uav-001");
    expect(d.textContent).toContain(`40${NBSP}912 tokens · 14 calls · about 2${NBSP}900 tokens a call`);
    expect((screen.getByTestId("raise-input") as HTMLInputElement).value).toBe("80000");
    expect(screen.getByTestId("raise-allows").textContent).toBe("about 13 more calls at the current rate");
    expect(d.textContent).toContain("Consumption is your responsibility.");
    expect(d.textContent).toContain("recorded as a researcher input at tick 342 and replayed with the run");
    expect(d.textContent).toContain("no prices set for local-ollama");
    expect(screen.getByTestId("raise-confirm").textContent).toBe(`Raise to 80${NBSP}000 and resume`);
    await userEvent.click(screen.getByTestId("raise-preset-5"));
    expect((screen.getByTestId("raise-input") as HTMLInputElement).value).toBe("200000");
    expect(screen.getByTestId("raise-confirm").textContent).toBe(`Raise to 200${NBSP}000 and resume`);
    await userEvent.click(screen.getByTestId("raise-confirm"));
    expect(p.onRaise).toHaveBeenCalledWith({ agentId: "uav-001", limit: "tokens", value: 200_000 });
    expect(screen.queryByTestId("raise-dialog")).toBeNull();
  });

  it("refuses a value that is not above the limit in force, and Escape cancels the dialog without answering", async () => {
    const p = props();
    render(<LimitNotice {...p} />);
    act(() => setMinds(mindsFixture("paused")));
    await userEvent.click(screen.getByTestId("limit-raise"));
    const input = screen.getByTestId("raise-input") as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, "39000");
    expect((screen.getByTestId("raise-confirm") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("raise-allows").textContent).toContain(`a value above 40${NBSP}000`);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByTestId("raise-dialog")).toBeNull();
    expect(p.onRaise).not.toHaveBeenCalled();
    expect(screen.getByTestId("limit-notice")).toBeDefined(); // still paused: the notice stays
  });

  it("goes away when the run goes on (a raise was taken), and a warning shows once without buttons and closes after 8 s", () => {
    vi.useFakeTimers();
    render(<LimitNotice {...props()} />);
    act(() => setMinds(mindsFixture("warning"), performance.now()));
    const w = screen.getByTestId("limit-warning-notice");
    expect(w.textContent).toContain("token limit at 82 %");
    expect(within(w).queryByRole("button")).toBeNull();
    act(() => setMinds(mindsFixture("warning"), performance.now())); // the same warning again: not shown twice
    act(() => void vi.advanceTimersByTime(WARNING_NOTICE_MS + 50));
    expect(screen.queryByTestId("limit-warning-notice")).toBeNull();
    act(() => setMinds(mindsFixture("warning"), performance.now()));
    expect(screen.queryByTestId("limit-warning-notice")).toBeNull();
    act(() => setMinds(mindsFixture("paused")));
    expect(screen.getByTestId("limit-notice")).toBeDefined();
    act(() => setMinds(mindsFixture("raised")));
    expect(screen.queryByTestId("limit-notice")).toBeNull();
  });
});

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { RecordingControls } from "./recording-controls.tsx";
import { getRecordingSelection, setRecordingSelection, takeRecordingChoice } from "./sim/recording-choice.ts";

// F3a M2: the recording choice at launch (ADR-0035 addition of 2026-10-17, items 2 and 6).

beforeEach(() => setRecordingSelection({ preset: "default-research", optOut: false }));

describe("RecordingControls", () => {
  it("offers the presets, with default-research chosen, and a profile as JSON", async () => {
    render(<RecordingControls realtime={false} />);
    const select = screen.getByTestId("recording-preset") as HTMLSelectElement;
    expect(select.value).toBe("default-research");
    expect([...select.options].map((o) => o.value)).toEqual(["minimal", "default-research", "debug-full", "custom"]);
    await userEvent.selectOptions(select, "minimal");
    expect(getRecordingSelection().preset).toBe("minimal");
    expect(takeRecordingChoice().mode).toBe("stored");
  });

  it("has an opt-out that is off, says what it means, and is for the next run only", async () => {
    render(<RecordingControls realtime={false} />);
    const box = screen.getByTestId("recording-opt-out") as HTMLInputElement;
    expect(box.checked).toBe(false); // never a default
    expect(screen.queryByTestId("recording-opt-out-note")).toBeNull();
    await userEvent.click(box);
    expect(screen.getByTestId("recording-opt-out-note")).toHaveTextContent("○ This run will not be saved");
    expect(takeRecordingChoice()).toEqual({ mode: "none" });
    expect(getRecordingSelection().optOut).toBe(false); // cleared when the run took it
  });

  it("shows a profile typed as JSON and why it is refused", async () => {
    render(<RecordingControls realtime={false} />);
    await userEvent.selectOptions(screen.getByTestId("recording-preset"), "custom");
    const text = screen.getByTestId("recording-custom-json");
    expect(screen.queryByTestId("recording-custom-error")).toBeNull();
    await userEvent.clear(text);
    await userEvent.type(text, "{{}");
    expect(await screen.findByTestId("recording-custom-error")).toHaveTextContent("✗");
  });

  it("warns about a heavy profile only for a realtime run", async () => {
    const { rerender } = render(<RecordingControls realtime={false} />);
    await userEvent.selectOptions(screen.getByTestId("recording-preset"), "debug-full");
    expect(screen.queryByTestId("recording-heavy-warning")).toBeNull();
    rerender(<RecordingControls realtime />);
    expect(screen.getByTestId("recording-heavy-warning")).toHaveTextContent(/storage_backpressure/);
    await userEvent.selectOptions(screen.getByTestId("recording-preset"), "minimal");
    expect(screen.queryByTestId("recording-heavy-warning")).toBeNull();
  });
});

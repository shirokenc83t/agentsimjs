import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AttentionCounts } from "./attention-counts.tsx";

// A zero count is neutral, each other count has its own role colour (never the worst level's for both).
describe("AttentionCounts", () => {
  const classes = () => [screen.getByTestId("attention-count-alarm").className, screen.getByTestId("attention-count-warning").className];

  it("0 and 0: both neutral", () => {
    render(<AttentionCounts alarm={0} warning={0} />);
    expect(classes()).toEqual(["attn-zero", "attn-zero"]);
  });

  it("0 and n: the zero is neutral, the warnings are warn", () => {
    render(<AttentionCounts alarm={0} warning={3} />);
    expect(classes()).toEqual(["attn-zero", "warn"]);
    expect(screen.getByTestId("attention-count-alarm")).toHaveTextContent("✕0");
    expect(screen.getByTestId("attention-count-warning")).toHaveTextContent("▲3");
  });

  it("n and 0: the alarms are alm, the zero warnings are neutral", () => {
    render(<AttentionCounts alarm={2} warning={0} />);
    expect(classes()).toEqual(["danger", "attn-zero"]);
  });

  it("n and m: each its own role colour", () => {
    render(<AttentionCounts alarm={1} warning={4} />);
    expect(classes()).toEqual(["danger", "warn"]);
  });
});

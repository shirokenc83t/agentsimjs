import { describe, expect, it } from "vitest";
import { MIN_PANE, planGrid } from "./layout-plan.ts";

describe("planGrid", () => {
  it("lays one pane full, two side by side, three and four as 2 × 2 with a third spanning the row below", () => {
    expect(planGrid(["log"], 1200, 600)).toEqual({ mode: "grid", cols: 1, rows: 1, spans: [1] });
    expect(planGrid(["log", "series"], 1200, 600)).toEqual({ mode: "grid", cols: 2, rows: 1, spans: [1, 1] });
    expect(planGrid(["log", "table", "series"], 1200, 600)).toEqual({ mode: "grid", cols: 2, rows: 2, spans: [1, 1, 2] });
    expect(planGrid(["log", "table", "series", "log"], 1200, 600)).toEqual({ mode: "grid", cols: 2, rows: 2, spans: [1, 1, 1, 1] });
  });

  it("keeps every pane at its minimum size: when two do not fit side by side they go one above the other, and when nothing fits they are tabs", () => {
    // Two logs need 2 × 420 across; at 700 wide they stack if each has 200 high.
    expect(planGrid(["log", "log"], 700, 420)).toEqual({ mode: "grid", cols: 1, rows: 2, spans: [1, 1] });
    expect(planGrid(["log", "log"], 700, 300)).toEqual({ mode: "tabs" });
    // Four logs in 2 × 2 need 840 × 400.
    expect(planGrid(["log", "log", "log", "log"], 840, 400).mode).toBe("grid");
    expect(planGrid(["log", "log", "log", "log"], 839, 400).mode).toBe("tabs");
    expect(planGrid(["log", "log", "log", "log"], 840, 399).mode).toBe("tabs");
  });

  it("never gives a pane less than its view's minimum", () => {
    for (const views of [["log"], ["table", "series"], ["log", "table", "series"], ["series", "series", "table", "log"]] as const) {
      for (let w = 300; w <= 1600; w += 50) {
        for (let h = 150; h <= 900; h += 50) {
          const plan = planGrid(views, w, h);
          if (plan.mode !== "grid") continue;
          views.forEach((v, i) => {
            expect((w / plan.cols) * (plan.spans[i] ?? 1)).toBeGreaterThanOrEqual(MIN_PANE[v].w);
            expect(h / plan.rows).toBeGreaterThanOrEqual(MIN_PANE[v].h);
          });
        }
      }
    }
  });

  it("an empty area has nothing to lay out, and one pane that does not fit is shown alone as a tab", () => {
    expect(planGrid([], 100, 100)).toEqual({ mode: "grid", cols: 1, rows: 1, spans: [1] });
    expect(planGrid(["log"], 300, 100)).toEqual({ mode: "tabs" });
  });
});

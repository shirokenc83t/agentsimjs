import { describe, expect, it } from "vitest";
import { muiTheme } from "./mui.tsx";
import { FONT, RADIUS_PX, TOOLTIP_DELAY_MS } from "./tokens.ts";

// The MUI theme follows ADR-0042: Mono everywhere, square controls, tooltips after 400 ms.
describe("MUI theme", () => {
  it("is JetBrains Mono, square, with a tooltip delay of 400 ms", () => {
    expect(muiTheme.typography.fontFamily).toBe(FONT.mono);
    expect(muiTheme.shape.borderRadius).toBe(RADIUS_PX.control);
    expect(RADIUS_PX.control).toBe(0);
    const tip = muiTheme.components?.MuiTooltip?.defaultProps as { enterDelay?: number; enterNextDelay?: number } | undefined;
    expect(TOOLTIP_DELAY_MS).toBe(400);
    expect(tip?.enterDelay).toBe(400);
    expect(tip?.enterNextDelay).toBe(400);
  });
});

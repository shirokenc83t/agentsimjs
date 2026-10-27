import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import "./theme.css";
import { UiThemeProvider } from "./mui.tsx";
import { initTheme, setThemePreference } from "./theme-controller.ts";

// The Scene toolbar's toggles (MUI) follow ADR-0043 section 2 (U-016): on is `fg` with a 1 px accent line under its label, off is `fg3`, and nothing is filled. MUI filled the selected one and
// the toolbar read reversed in the dark theme (the selected dim on a fill, the others bright). Real Chromium, the real theme.

const mounted: HTMLElement[] = [];
afterEach(() => mounted.splice(0).forEach((el) => el.remove()));

const colour = (css: string): string => {
  const probe = document.createElement("span");
  probe.style.color = css;
  document.body.appendChild(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();
  return c;
};
const look = (el: Element) => {
  const s = getComputedStyle(el);
  return { color: s.color, fill: s.backgroundColor, line: s.boxShadow };
};

function mount(node: React.ReactNode): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  mounted.push(host);
  flushSync(() => createRoot(host).render(<UiThemeProvider>{node}</UiThemeProvider>));
  return host;
}

describe.each(["dark", "light"] as const)("MUI toggles, %s theme", (theme) => {
  it("the selected one is fg with the accent line and no fill, the others fg3 with no line and no fill, and the selected one is the brighter against the panel", () => {
    initTheme();
    setThemePreference(theme);
    const host = mount(
      <ToggleButtonGroup exclusive value="3d" aria-label="Map view">
        <ToggleButton value="2d">MAP 2D</ToggleButton>
        <ToggleButton value="3d">3D</ToggleButton>
      </ToggleButtonGroup>,
    );
    const [off, on] = Array.from(host.querySelectorAll("button")).map(look) as [ReturnType<typeof look>, ReturnType<typeof look>];
    expect(on.color).toBe(colour("var(--fg)"));
    expect(on.fill).toBe("rgba(0, 0, 0, 0)");
    expect(on.line).toContain(colour("var(--ac)"));
    expect(off.color).toBe(colour("var(--fg3)"));
    expect(off.fill).toBe("rgba(0, 0, 0, 0)");
    expect(off.line).toBe("none");
    const sum = (c: string) => (c.match(/\d+/g) ?? []).slice(0, 3).reduce((a, v) => a + Number(v), 0);
    const bg = sum(colour("var(--bg1)"));
    expect(Math.abs(sum(on.color) - bg)).toBeGreaterThan(Math.abs(sum(off.color) - bg));
  });
});

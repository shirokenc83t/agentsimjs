import Button from "@mui/material/Button";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import TextField from "@mui/material/TextField";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { userEvent } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import "./theme.css";
import { UiThemeProvider } from "./mui.tsx";
import { initTheme, setThemePreference } from "./theme-controller.ts";

// Keyboard focus is visible on every MUI control (ADR-0032 §8): the 2 px accent outline of the base stylesheet, which MUI's own focus rules would otherwise replace
// or clear. Real Chromium: focus-visible and the computed outline are what the user sees.

const mounted: HTMLElement[] = [];
afterEach(() => {
  for (const el of mounted.splice(0)) el.remove();
});

function mount(node: React.ReactNode): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  mounted.push(host);
  flushSync(() => createRoot(host).render(<UiThemeProvider>{node}</UiThemeProvider>));
  return host;
}

/** The outline the user sees for the focused element: its own, or its input root's (an input's outline is drawn on the field around it). */
function ring(el: Element) {
  for (const e of [el, el.closest(".MuiInputBase-root"), el.closest(".MuiButtonBase-root")]) {
    if (!e) continue;
    const s = getComputedStyle(e);
    if (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) return { width: parseFloat(s.outlineWidth), color: s.outlineColor };
  }
  return undefined;
}

describe.each(["dark", "light"] as const)("keyboard focus on MUI controls, %s theme", (theme) => {
  it("buttons, inputs, tabs and menu items show a 2 px accent outline when reached with the keyboard", async () => {
    initTheme();
    setThemePreference(theme);
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--ac").trim();
    const probe = document.createElement("span");
    probe.style.color = accent;
    document.body.appendChild(probe);
    const accentRgb = getComputedStyle(probe).color;
    probe.remove();

    mount(
      <>
        <Button>Run</Button>
        <TextField label="Name" slotProps={{ htmlInput: { "aria-label": "name" } }} />
        <Tabs value={0}>
          <Tab label="One" />
          <Tab label="Two" />
        </Tabs>
      </>,
    );
    const seen: string[] = [];
    for (let k = 0; k < 5; k++) {
      await userEvent.keyboard("{Tab}");
      const el = document.activeElement;
      if (!el || el === document.body) continue;
      const label = el.getAttribute("aria-label") ?? el.textContent ?? el.tagName;
      const r = ring(el);
      expect(r, `${label} has a focus outline`).toBeDefined();
      expect(r?.width, label).toBeGreaterThanOrEqual(2);
      expect(r?.color, label).toBe(accentRgb);
      seen.push(label);
    }
    for (const want of ["Run", "name", "One"]) expect(seen, `${want} was reached`).toContain(want);
  });

  it("menu items show it too, moved with the arrow keys", async () => {
    initTheme();
    setThemePreference(theme);
    const probe = document.createElement("span");
    probe.style.color = getComputedStyle(document.documentElement).getPropertyValue("--ac");
    document.body.appendChild(probe);
    const accentRgb = getComputedStyle(probe).color;
    probe.remove();
    mount(
      <Menu open anchorEl={document.body} disablePortal>
        <MenuItem>First item</MenuItem>
        <MenuItem>Second item</MenuItem>
      </Menu>,
    );
    for (const want of ["First item", "Second item"]) {
      await userEvent.keyboard(want === "First item" ? "{Tab}" : "{ArrowDown}");
      const el = document.activeElement;
      expect(el?.textContent).toBe(want);
      const r = el ? ring(el) : undefined;
      expect(r?.width, want).toBeGreaterThanOrEqual(2);
      expect(r?.color, want).toBe(accentRgb);
    }
  });
});

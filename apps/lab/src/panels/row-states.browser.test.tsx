import "@agentsim/ui/theme.css";
import "./panels.css";
import { initTheme, setThemePreference } from "@agentsim/ui";
import { userEvent } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";

// Every selectable row has the same three states (ADR-0042 §6), told apart by fill, edge colour and edge width: hover is a neutral fill with a 1 px neutral edge,
// selection an accent tint with a 1 px accent outline, keyboard focus the 2 px accent outline; no coloured side bar on a row. Real Chromium, the real stylesheets.

const ROWS = ["event-row", "explorer-row", "query-row"] as const;
const mounted: HTMLElement[] = [];
afterEach(() => mounted.splice(0).forEach((el) => el.remove()));

function rgb(cssColor: string): string {
  const probe = document.createElement("span");
  probe.style.color = cssColor;
  document.body.appendChild(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();
  return c;
}
const token = (name: string) => rgb(`var(${name})`);

function mount(cls: string): { row: HTMLElement; other: HTMLElement } {
  const host = document.createElement("div");
  host.innerHTML = `<div class="${cls} selectable" role="option" aria-selected="false" tabindex="0">a row</div><div class="${cls} selectable" role="option" aria-selected="true" tabindex="-1">selected row</div>`;
  document.body.appendChild(host);
  mounted.push(host);
  return { row: host.children[0] as HTMLElement, other: host.children[1] as HTMLElement };
}
const look = (el: HTMLElement) => {
  const s = getComputedStyle(el);
  return { bg: s.backgroundColor, outlineColor: s.outlineColor, outlineWidth: s.outlineStyle === "none" ? 0 : parseFloat(s.outlineWidth), shadow: s.boxShadow, cursor: s.cursor };
};

describe.each(["dark", "light"] as const)("selectable rows, %s theme", (theme) => {
  it.each(ROWS)("%s: hover, selection and keyboard focus are three different looks, none a side bar, all with the pointer cursor", async (cls) => {
    initTheme();
    setThemePreference(theme);
    const { row, other } = mount(cls);
    const rest = look(row);
    expect(rest.cursor).toBe("pointer");

    await userEvent.hover(row);
    const hover = look(row);
    expect(hover.bg).toBe(token("--bg3"));
    expect(hover.outlineColor).toBe(token("--fg3"));
    expect(hover.outlineWidth).toBe(1);
    expect(hover.outlineColor).not.toBe(token("--ac")); // never the accent

    await userEvent.unhover(row);
    const selected = look(other);
    expect(selected.bg).toBe(token("--acbg"));
    expect(selected.outlineColor).toBe(token("--ac"));
    expect(selected.outlineWidth).toBe(1);
    expect(selected.shadow).toBe("none"); // no coloured side bar

    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(row);
    const focus = look(row);
    expect(focus.outlineColor).toBe(token("--ac"));
    expect(focus.outlineWidth).toBe(2);

    // Told apart: hover from rest, from selection and from focus.
    expect(hover.bg).not.toBe(rest.bg);
    expect(hover.bg).not.toBe(selected.bg);
    expect(hover.outlineColor).not.toBe(selected.outlineColor);
    expect(focus.outlineWidth).toBeGreaterThan(hover.outlineWidth);
    expect(focus.outlineWidth).toBeGreaterThan(selected.outlineWidth);
  });
});

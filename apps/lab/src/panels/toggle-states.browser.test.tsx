import "@agentsim/ui/theme.css";
import "./panels.css";
import { initTheme, setThemePreference } from "@agentsim/ui";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

// Every toggle of the stylesheet follows ADR-0043 section 2 (U-016): on is `fg` with a 1 px accent line under its label, off is `fg3`, and nothing is filled (the MUI toggles are tested in
// the ui package, with the theme). Real Chromium, the real stylesheets.

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
  flushSync(() => createRoot(host).render(node));
  return host;
}

describe.each(["dark", "light"] as const)("toggles, %s theme", (theme) => {
  const setup = () => {
    initTheme();
    setThemePreference(theme);
  };

  it("the stylesheet's toggles (the Log's tags, the pane tabs, the filter chips, the buttons): pressed is fg with the accent line, not pressed is fg3, no fill either way", () => {
    setup();
    const host = mount(
      <div>
        {["kt", "chip", "btn"].map((cls) => (
          <span key={cls}>
            <button type="button" className={cls} aria-pressed="true" data-on>
              on
            </button>
            <button type="button" className={cls} aria-pressed="false" data-off>
              off
            </button>
          </span>
        ))}
      </div>,
    );
    for (const el of Array.from(host.querySelectorAll("[data-on]"))) {
      const l = look(el);
      expect(l.color, el.className).toBe(colour("var(--fg)"));
      expect(l.line, el.className).toContain(colour("var(--ac)"));
      expect(l.fill, el.className).not.toBe(colour("var(--acbg)"));
    }
    for (const el of Array.from(host.querySelectorAll("[data-off]")).filter((e) => e.className !== "btn")) {
      const l = look(el);
      expect(l.color, el.className).toBe(colour("var(--fg3)"));
      expect(l.line, el.className).toBe("none");
    }
  });
});

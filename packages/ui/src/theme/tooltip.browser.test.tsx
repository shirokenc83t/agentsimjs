import "./theme.css";
import { userEvent } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { initTooltips } from "./tooltips.ts";

// The tooltip of a compact control (`data-tip`) appears 400 ms after the pointer rests on it, and on keyboard focus after
// the same delay, so a Tab across a toolbar does not flash every tip (ADR-0042 §6). Real Chromium, the real stylesheet.

const mounted: HTMLElement[] = [];
afterEach(() => mounted.splice(0).forEach((el) => el.remove()));

const tipOpacity = (el: Element) => Number(getComputedStyle(el, "::after").opacity);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("data-tip tooltips", () => {
  it("appear after 400 ms of hover, not before, and go away at once", async () => {
    const host = document.createElement("div");
    host.innerHTML = '<button aria-label="pause" data-tip="Pause · Space">pause</button>';
    document.body.appendChild(host);
    mounted.push(host);
    const button = host.firstElementChild as HTMLElement;
    expect(tipOpacity(button)).toBe(0);
    await userEvent.hover(button);
    await wait(150);
    expect(tipOpacity(button)).toBe(0);
    await wait(500);
    expect(tipOpacity(button)).toBe(1);
    await userEvent.unhover(button);
    await wait(50);
    expect(tipOpacity(button)).toBe(0);
  });

  it("close on a click or a key and stay closed until the pointer leaves, so a tip never covers what the control just did", async () => {
    const off = initTooltips();
    try {
      const host = document.createElement("div");
      host.innerHTML = '<button aria-label="run" data-tip="Run · Ctrl+Enter">run</button><span id="away">away</span>';
      document.body.appendChild(host);
      mounted.push(host);
      const button = host.firstElementChild as HTMLElement;
      await userEvent.hover(button);
      await wait(550);
      expect(tipOpacity(button)).toBe(1);
      await userEvent.click(button);
      expect(getComputedStyle(button, "::after").display).toBe("none");
      await wait(550);
      expect(getComputedStyle(button, "::after").display).toBe("none"); // still under the pointer: still closed
      await userEvent.hover(host.querySelector("#away") as Element);
      await userEvent.hover(button);
      await wait(550);
      expect(tipOpacity(button)).toBe(1); // a new visit shows it again
      await userEvent.keyboard("a");
      expect(getComputedStyle(button, "::after").display).toBe("none");
    } finally {
      off();
    }
  });

  it("carry the floating shadow and a neutral edge, never the accent", async () => {
    const host = document.createElement("div");
    host.innerHTML = '<button aria-label="x" data-tip="x">x</button>';
    document.body.appendChild(host);
    mounted.push(host);
    const s = getComputedStyle(host.firstElementChild as Element, "::after");
    expect(s.boxShadow).not.toBe("none");
    const probe = document.createElement("span");
    probe.style.color = "var(--ac)";
    host.appendChild(probe);
    expect(s.borderTopColor).not.toBe(getComputedStyle(probe).color);
  });
});

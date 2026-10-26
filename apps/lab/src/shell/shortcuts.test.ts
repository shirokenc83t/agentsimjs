import { describe, expect, it } from "vitest";
import { shellKey } from "./shortcuts.ts";

const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
const el = (html: string): Element => {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host.firstElementChild as Element;
};

describe("shell keys", () => {
  it("1–5 pick a workspace (by position), only as many as there are", () => {
    expect(shellKey(key("1"), document.body, 5)).toEqual({ kind: "workspace", index: 0 });
    expect(shellKey(key("5"), document.body, 5)).toEqual({ kind: "workspace", index: 4 });
    expect(shellKey(key("6"), document.body, 5)).toBeUndefined();
    expect(shellKey(key("0"), document.body, 5)).toBeUndefined();
  });

  it("Space plays and pauses, `.` steps one tick", () => {
    expect(shellKey(key(" "), document.body, 5)).toEqual({ kind: "toggle-play" });
    expect(shellKey(key("."), document.body, 5)).toEqual({ kind: "step" });
  });

  it("none of them while typing, inside a dialog, or with a modifier", () => {
    for (const k of ["1", " ", "."]) {
      expect(shellKey(key(k), el("<input />"), 5), `${k} in an input`).toBeUndefined();
      expect(shellKey(key(k), el("<textarea></textarea>"), 5), `${k} in a textarea`).toBeUndefined();
      expect(shellKey(key(k), el("<select><option>a</option></select>"), 5), `${k} in a select`).toBeUndefined();
      expect(shellKey(key(k), el('<div role="dialog"><span id="x" tabindex="0"></span></div>').querySelector("#x"), 5), `${k} in a dialog`).toBeUndefined();
      expect(shellKey(key(k, { ctrlKey: true }), document.body, 5), `ctrl+${k}`).toBeUndefined();
      expect(shellKey(key(k, { metaKey: true }), document.body, 5), `meta+${k}`).toBeUndefined();
      expect(shellKey(key(k, { altKey: true }), document.body, 5), `alt+${k}`).toBeUndefined();
    }
  });

  it("Space on a control that Space activates (a button, a slider, an option) is that control's", () => {
    expect(shellKey(key(" "), el("<button>go</button>"), 5)).toBeUndefined();
    expect(shellKey(key(" "), el('<div role="slider" tabindex="0"></div>'), 5)).toBeUndefined();
    expect(shellKey(key(" "), el('<div role="option" tabindex="0"></div>'), 5)).toBeUndefined();
    // …but the digits and the dot still reach the shell from a button.
    expect(shellKey(key("2"), el("<button>go</button>"), 5)).toEqual({ kind: "workspace", index: 1 });
  });
});

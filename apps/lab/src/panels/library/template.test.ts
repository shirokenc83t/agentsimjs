import { foldable } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { DEFAULT_PROMPT_TEMPLATE, validatePromptTemplate } from "@agentsim/minds";
import { describe, expect, it } from "vitest";
import { slotEditAllowed, slotRanges, templateExtensions } from "./template-extensions.ts";
import { blocksOf, lintTemplateText, sectionTokens, templateToText, textToTemplate, withSlot, type TemplateDoc } from "./template-text.ts";

// The template as text and its editor rules (F4 M4, T-124): the text and the document are the same template, the slot lines cannot be partly edited or deleted except whole, the lint raises exactly what the
// schema's validator raises, each section folds, and the size of each block is told in tokens (characters / 4).

const DOC: TemplateDoc = { schemaVersion: 1, kind: "prompt-template", system: "You are the mind of one vehicle.", sections: ["role", "mission", "actions"], instructions: { mission: "Read this first.", actions: "Pick one." } };
const TEXT = "You are the mind of one vehicle.\n{{role}}\n{{mission}}\nRead this first.\n{{actions}}\nPick one.";

describe("the template as text", () => {
  it("turns a document into the editor's text and back: the same template", () => {
    expect(templateToText(DOC)).toBe(TEXT);
    expect(textToTemplate(TEXT)).toEqual(DOC);
    expect(textToTemplate(templateToText(DEFAULT_PROMPT_TEMPLATE))).toEqual(DEFAULT_PROMPT_TEMPLATE);
    expect(blocksOf(TEXT).map((b) => [b.slot, b.text])).toEqual([["system", "You are the mind of one vehicle."], ["role", ""], ["mission", "Read this first."], ["actions", "Pick one."]]);
  });

  it("tells the size of each block in tokens (characters / 4, rounded up) and adds a slot at the end only once", () => {
    expect(sectionTokens(TEXT)).toEqual([{ slot: "system", tokens: 8 }, { slot: "role", tokens: 0 }, { slot: "mission", tokens: 4 }, { slot: "actions", tokens: 3 }]);
    expect(withSlot(TEXT, "notebook")).toBe(`${TEXT}\n{{notebook}}\n`);
    expect(withSlot(TEXT, "role")).toBe(TEXT);
  });
});

describe("the lint is the validator's rule", () => {
  const FIXTURES: Record<string, string> = {
    valid: TEXT,
    "the default template": templateToText(DEFAULT_PROMPT_TEMPLATE),
    "an unknown slot": "System text.\n{{role}}\n{{weather}}\nx",
    "a slot twice": "System text.\n{{role}}\n{{role}}",
    "no slot": "System text only.",
    "an expression in the system text": "Hello ${name}.\n{{role}}",
    "an expression in an instruction": "System text.\n{{role}}\nDo {% if x %} this",
    "a slot with something after it": "System text.\n{{role}} and more",
    "an empty slot name": "System text.\n{{}}",
    "an empty system text": "\n{{role}}",
    "a system text that is too long": `${"x".repeat(8_001)}\n{{role}}`,
    "an instruction that is too long": `System.\n{{role}}\n${"y".repeat(1_001)}`,
    "braces as plain text": "Use { and } freely.\n{{role}}\nA {curly} word.",
  };
  for (const [name, text] of Object.entries(FIXTURES)) {
    it(`${name}: no issue exactly when the library would accept the document`, () => {
      const issues = lintTemplateText(text);
      const verdict = validatePromptTemplate(textToTemplate(text));
      expect(issues.length === 0, `${name}: ${JSON.stringify(issues)} vs ${verdict.ok ? "ok" : verdict.error.message}`).toBe(verdict.ok);
      for (const i of issues) {
        expect(i.from).toBeGreaterThanOrEqual(0);
        expect(i.to).toBeLessThanOrEqual(text.length);
      }
    });
  }

  it("marks the fault where it is: the unknown slot's line, the expression's characters, with the validator's code", () => {
    const text = "System text.\n{{role}}\n{{weather}}\nDo {% if x %} this";
    const issues = lintTemplateText(text);
    expect(issues.map((i) => [text.slice(i.from, i.to), i.code])).toEqual([["{{weather}}", "template_slot_unknown"], ["{%", "template_slot_unknown"]]);
    const v = validatePromptTemplate(textToTemplate(text));
    expect(!v.ok && v.error.code).toBe("template_slot_unknown");
  });
});

describe("the slot lines are fixed", () => {
  it("allows text around a slot and refuses an edit that starts or ends inside one", () => {
    const at = (s: string) => TEXT.indexOf(s);
    const role = slotRanges(TEXT)[0] as { from: number; to: number };
    expect(slotRanges(TEXT).map((r) => TEXT.slice(r.from, r.to))).toEqual(["{{role}}", "{{mission}}", "{{actions}}"]);
    // Text in the system block and in an instruction: free.
    expect(slotEditAllowed(TEXT, 3, 3, "xyz")).toBe(true);
    expect(slotEditAllowed(TEXT, at("Read this"), at("Read this") + 4, "Study")).toBe(true);
    // An insertion at the start or the end of a slot line is text around it: free.
    expect(slotEditAllowed(TEXT, role.from, role.from, "A line\n")).toBe(true);
    expect(slotEditAllowed(TEXT, role.to, role.to, "\nmore")).toBe(true);
    // Text glued to a slot would make it no longer one: refused. A line break alone is fine.
    expect(slotEditAllowed(TEXT, role.from, role.from, "x")).toBe(false);
    expect(slotEditAllowed(TEXT, role.to, role.to, "x")).toBe(false);
    expect(slotEditAllowed(TEXT, role.to, role.to, "\n")).toBe(true);
    // Inside a slot: one character typed, one deleted, a part replaced, a selection from the text into it: refused.
    expect(slotEditAllowed(TEXT, role.from + 3, role.from + 3, "x")).toBe(false);
    expect(slotEditAllowed(TEXT, role.from + 2, role.from + 3, "")).toBe(false);
    expect(slotEditAllowed(TEXT, role.from + 2, role.to - 2, "mission")).toBe(false);
    expect(slotEditAllowed(TEXT, 5, role.from + 4, "")).toBe(false);
    // Taking the whole slot away, line break and all, is allowed; replacing it by another slot-like text is not.
    expect(slotEditAllowed(TEXT, role.from, role.to + 1, "")).toBe(true);
    expect(slotEditAllowed(TEXT, role.from, role.to, "{{beliefs}}")).toBe(false);
    expect(slotEditAllowed(TEXT, role.from, role.to, "plain")).toBe(true);
  });

  it("holds in the editor's state: a partial edit of a slot changes nothing, deleting the whole line works, typing text works", () => {
    const state = EditorState.create({ doc: TEXT, extensions: templateExtensions({ readOnly: false }) });
    const role = slotRanges(TEXT)[0] as { from: number; to: number };
    expect(state.update({ changes: { from: role.from + 3, to: role.from + 4, insert: "" } }).state.doc.toString()).toBe(TEXT);
    expect(state.update({ changes: { from: role.from + 2, insert: "zz" } }).state.doc.toString()).toBe(TEXT);
    expect(state.update({ changes: { from: role.from, insert: "x" } }).state.doc.toString()).toBe(TEXT);
    expect(state.update({ changes: { from: role.from, to: role.to + 1, insert: "" } }).state.doc.toString()).toBe(TEXT.replace("{{role}}\n", ""));
    expect(state.update({ changes: { from: 0, insert: "Note. " } }).state.doc.toString()).toBe(`Note. ${TEXT}`);
  });

  it("a version that is used is read-only: nothing changes", () => {
    const state = EditorState.create({ doc: TEXT, extensions: templateExtensions({ readOnly: true }) });
    expect(state.readOnly).toBe(true);
  });

  it("each section folds from the end of its slot line to the end of its text; a slot with no text has nothing to fold", () => {
    const state = EditorState.create({ doc: TEXT, extensions: templateExtensions({ readOnly: false }) });
    const line = (s: string) => state.doc.lineAt(TEXT.indexOf(s));
    const mission = line("{{mission}}");
    const range = foldable(state, mission.from, mission.to);
    expect(range).toEqual({ from: mission.to, to: TEXT.indexOf("Read this first.") + "Read this first.".length });
    const role = line("{{role}}");
    expect(foldable(state, role.from, role.to)).toBeNull();
  });
});

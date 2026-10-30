import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { codeFolding, foldGutter, foldKeymap, foldService } from "@codemirror/language";
import { linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { EditorState, RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, drawSelection, EditorView, keymap, lineNumbers, type DecorationSet } from "@codemirror/view";
import { blocksOf, lintTemplateText, SLOT_LINE } from "./template-text.ts";

// The CodeMirror 6 extensions of the prompt-template editor (F4 M4, T-124, ADR-0045 point 3.1): the slot lines are atomic read-only ranges (a slot cannot be partly edited, only deleted whole or kept), an issue the
// schema's validator would raise is marked in the text, each section folds, the search is CodeMirror's, and the theme is made of the tokens (CSS variables), not of a palette of its own. Loaded with the editor,
// never in the initial chunk.

const NL = String.fromCharCode(10);

/** The ranges of the slot lines of a document: from the start of the line to its end. */
export function slotRanges(doc: string): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  let at = 0;
  for (const line of doc.split("\n")) {
    if (SLOT_LINE.test(line)) out.push({ from: at, to: at + line.length });
    at += line.length + 1;
  }
  return out;
}

/**
 * The rule that makes a slot line fixed: an edit that starts or ends inside a slot line is refused, unless it takes the whole line away (with the line break before or after it) and puts no slot-like text in
 * its place. An insertion at the start or the end of a slot line is text around the slot only if it is a line of its own (it ends with a line break at the start, begins with one at the end): text glued to the
 * slot would make it something that is no longer a slot. Between lines, anything goes.
 */
export function slotEditAllowed(doc: string, from: number, to: number, insert: string): boolean {
  for (const r of slotRanges(doc)) {
    const overlaps = from < r.to && to > r.from;
    const touchesInside = from > r.from && from < r.to; // an insertion in the middle of the line
    // An insertion right at an end of the line is free when it is a line of its own.
    if (from === to && !touchesInside && (from === r.from || from === r.to) && insert !== "") {
      if (from === r.from && insert.endsWith(NL)) continue;
      if (from === r.to && insert.startsWith(NL)) continue;
      return false;
    }
    if (!overlaps && !touchesInside) continue;
    const coversWhole = from <= r.from && to >= r.to;
    if (coversWhole && !SLOT_LINE.test(insert.trim()) && !/\{\{|\}\}/.test(insert)) continue;
    return false;
  }
  return true;
}

const slotFilter = EditorState.changeFilter.of((tr) => {
  const doc = tr.startState.doc.toString();
  let ok = true;
  tr.changes.iterChanges((from, to, _fa, _ta, inserted) => {
    if (!slotEditAllowed(doc, from, to, inserted.toString())) ok = false;
  });
  return ok;
});

/** The slot lines drawn as what they are: a fixed line, not text. */
function slotDecorations(state: EditorState): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  for (const r of slotRanges(state.doc.toString())) {
    b.add(r.from, r.from, Decoration.line({ class: "cm-slot-line" }));
    if (r.to > r.from) b.add(r.from, r.to, Decoration.mark({ class: "cm-slot", attributes: { "data-slot": state.doc.sliceString(r.from + 2, r.to - 2) } }));
  }
  return b.finish();
}

const slotLook = EditorView.decorations.compute(["doc"], slotDecorations);
const slotAtomic = EditorView.atomicRanges.of((view) => slotDecorations(view.state));

/** A section folds from the end of its slot line to the end of its text. */
const foldSections = foldService.of((state, lineStart) => {
  const text = state.doc.toString();
  const here = state.doc.lineAt(lineStart);
  const blocks = blocksOf(text);
  const i = blocks.findIndex((b) => b.marker !== undefined && b.marker.from === here.from);
  const b = blocks[i];
  if (b === undefined || b.to <= here.to + 1) return null;
  return { from: here.to, to: b.to };
});

/** The issues of the text as marks in it. */
function templateLint(view: EditorView): Diagnostic[] {
  return lintTemplateText(view.state.doc.toString()).map((i) => ({ from: i.from, to: Math.max(i.to, i.from + 1), severity: "error", message: `${i.code}: ${i.message}`, source: "template" }));
}

/** The theme, from the tokens of the app: the editor reads the same CSS variables as everything else. */
const theme = EditorView.theme({
  "&": { color: "var(--fg)", backgroundColor: "var(--bg0)", fontSize: "var(--type-mono-size)", border: "1px solid var(--ln2)" },
  "&.cm-focused": { outline: "var(--focus-ring) solid var(--ac)", outlineOffset: "1px" },
  ".cm-content": { fontFamily: "var(--font-mono)", caretColor: "var(--fg)", padding: "6px 0" },
  ".cm-gutters": { backgroundColor: "var(--bg1)", color: "var(--fg3)", border: "0", borderRight: "1px solid var(--ln)" },
  ".cm-activeLine": { backgroundColor: "transparent" },
  ".cm-cursor": { borderLeftColor: "var(--fg)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "var(--bg3)" },
  ".cm-slot-line": { backgroundColor: "var(--bg2)" },
  ".cm-slot": { color: "var(--ac)", fontWeight: "600", cursor: "default" },
  ".cm-lintRange-error": { backgroundImage: "none", textDecoration: "underline wavy var(--alm)" },
  ".cm-diagnostic": { fontFamily: "var(--font-mono)", color: "var(--fg)", borderLeft: "3px solid var(--alm)", backgroundColor: "var(--bg1)" },
  ".cm-tooltip": { backgroundColor: "var(--bg1)", border: "1px solid var(--ln2)", color: "var(--fg)" },
  ".cm-panels": { backgroundColor: "var(--bg1)", color: "var(--fg)", borderColor: "var(--ln2)" },
  ".cm-textfield": { backgroundColor: "var(--bg0)", color: "var(--fg)", border: "1px solid var(--ln2)" },
  ".cm-button": { backgroundImage: "none", backgroundColor: "var(--bg1)", color: "var(--fg)", border: "1px solid var(--ln2)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--bg3)", color: "var(--fg3)", border: "0" },
});

/** Everything the template editor is made of; `readOnly` shows a version that is used and cannot be changed. */
export function templateExtensions(opts: { readOnly: boolean }): Extension[] {
  return [
    lineNumbers(),
    history(),
    drawSelection(),
    highlightSelectionMatches(),
    codeFolding(),
    foldGutter(),
    foldSections,
    lintGutter(),
    linter(templateLint, { delay: 150 }),
    slotFilter,
    slotLook,
    slotAtomic,
    EditorView.lineWrapping,
    theme,
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...foldKeymap]),
    EditorState.readOnly.of(opts.readOnly),
    EditorView.contentAttributes.of({ "aria-label": "Prompt template text" }),
  ];
}

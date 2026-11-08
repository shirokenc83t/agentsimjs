// A prompt template as text, for the editor (F4 M4, T-124, ADR-0045 point 3.1): the system text, then each section as its slot on a line of its own, `{{role}}`, followed by the free text of that section (its
// instruction). The slot lines are fixed: the editor makes them atomic and read-only; only the text around them is edited. The text is turned back into the document the library stores, and the lint is the same
// rule as the schema's validator (`validatePromptTemplate`): an unknown slot, a slot twice, expression-like syntax in the text, a text that is too long. Pure; no editor here.

export const SLOT_NAMES = ["role", "mission", "notebook", "decisions", "self", "beliefs", "space", "events", "actions"] as const;

/** The template document as the library holds it (the part of it the editor works on). */
export interface TemplateDoc {
  readonly schemaVersion: 1;
  readonly kind: "prompt-template";
  readonly system: string;
  readonly sections: readonly string[];
  readonly instructions?: Readonly<Record<string, string>>;
}

/** A slot line: nothing but `{{name}}`. */
export const SLOT_LINE = /^\{\{([A-Za-z0-9_-]*)\}\}$/;
/** Text that looks like an expression, a placeholder or code (the validator's rule): refused in the system text and in every instruction. */
export const EXPRESSION_LIKE = /\{\{|\}\}|\$\{|\{%|%\}|<%|%>|\{#|#\}/;
export const LIMITS = { system: 8_000, instruction: 1_000 } as const;

/** The editor's text for a template: the system text, then `{{slot}}` and its instruction for each section, in order. */
export function templateToText(doc: TemplateDoc): string {
  const parts: string[] = [doc.system];
  for (const slot of doc.sections) {
    parts.push(`{{${slot}}}`);
    const instruction = doc.instructions?.[slot];
    if (instruction !== undefined && instruction !== "") parts.push(instruction);
  }
  return parts.join("\n");
}

export interface Block {
  /** `system`, or the name of the slot the block follows. */
  readonly slot: string;
  readonly text: string;
  /** Offsets of the block's own text in the editor text: from the first character of it to the end of its last line. */
  readonly from: number;
  readonly to: number;
  /** The slot line itself (absent for the system block). */
  readonly marker?: { readonly from: number; readonly to: number };
}

/** The blocks of an editor text: the system text before the first slot line, then each slot line with the text after it. */
export function blocksOf(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: { slot: string; lines: { text: string; at: number }[]; marker?: { from: number; to: number } }[] = [{ slot: "system", lines: [] }];
  let at = 0;
  for (const line of lines) {
    const m = SLOT_LINE.exec(line);
    if (m !== null) blocks.push({ slot: m[1] as string, lines: [], marker: { from: at, to: at + line.length } });
    else (blocks[blocks.length - 1] as (typeof blocks)[number]).lines.push({ text: line, at });
    at += line.length + 1;
  }
  return blocks.map((b) => {
    const first = b.lines[0];
    const last = b.lines[b.lines.length - 1];
    const from = first?.at ?? (b.marker === undefined ? 0 : b.marker.to + 1);
    const to = last === undefined ? from : last.at + last.text.length;
    return { slot: b.slot, text: b.lines.map((l) => l.text).join("\n").replace(/\s+$/, "").replace(/^\s+/, ""), from, to, ...(b.marker === undefined ? {} : { marker: b.marker }) };
  });
}

/** The document an editor text stands for (untrusted: validate it before it is stored). */
export function textToTemplate(text: string): TemplateDoc {
  const [system, ...rest] = blocksOf(text);
  const instructions: Record<string, string> = {};
  for (const b of rest) if (b.text !== "") instructions[b.slot] = b.text;
  return { schemaVersion: 1, kind: "prompt-template", system: system?.text ?? "", sections: rest.map((b) => b.slot), ...(Object.keys(instructions).length === 0 ? {} : { instructions }) };
}

export interface TemplateIssue {
  readonly from: number;
  readonly to: number;
  readonly message: string;
  /** The stable code of the validator for the same fault. */
  readonly code: "template_slot_unknown" | "invalid_document";
}

/** What is wrong with an editor text, as ranges of it: the same faults as `validatePromptTemplate` finds in the document the text stands for, so that a text with no issue is a template the library accepts. */
export function lintTemplateText(text: string): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  const blocks = blocksOf(text);
  const seen = new Set<string>();
  const known = new Set<string>(SLOT_NAMES);
  for (const b of blocks) {
    if (b.marker !== undefined) {
      if (!known.has(b.slot)) issues.push({ from: b.marker.from, to: b.marker.to, code: "template_slot_unknown", message: `"${b.slot}" is not a slot (the slots are ${SLOT_NAMES.join(", ")})` });
      else if (seen.has(b.slot)) issues.push({ from: b.marker.from, to: b.marker.to, code: "invalid_document", message: `the slot ${b.slot} is named twice` });
      seen.add(b.slot);
    }
    const limit = b.slot === "system" ? LIMITS.system : LIMITS.instruction;
    if (b.text.length > limit) issues.push({ from: b.from, to: b.to, code: "invalid_document", message: `${b.slot === "system" ? "the system text" : `the text of ${b.slot}`} is ${b.text.length} characters: at most ${limit}` });
    if (b.slot === "system" && b.text.trim() === "") issues.push({ from: 0, to: Math.max(0, blocks[0]?.to ?? 0), code: "invalid_document", message: "the system text is empty" });
    const e = EXPRESSION_LIKE.exec(text.slice(b.from, b.to));
    if (e !== null) issues.push({ from: b.from + e.index, to: b.from + e.index + e[0].length, code: "template_slot_unknown", message: "expression-like syntax: a template has fixed slots and no expressions" });
  }
  if (blocks.length === 1) issues.push({ from: 0, to: text.length, code: "invalid_document", message: "a template names at least one slot" });
  return issues;
}

/** The size of each block in tokens (characters / 4, rounded up): the editor says it is an estimate. */
export function sectionTokens(text: string): { readonly slot: string; readonly tokens: number }[] {
  return blocksOf(text).map((b) => ({ slot: b.slot, tokens: Math.ceil(b.text.length / 4) }));
}

/** The text with a slot added at the end (a slot not in it yet), or the text as it is when it has it. */
export function withSlot(text: string, slot: string): string {
  if (blocksOf(text).some((b) => b.slot === slot)) return text;
  return `${text.replace(/\n+$/, "")}\n{{${slot}}}\n`;
}

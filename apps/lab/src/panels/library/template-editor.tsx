import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { templateExtensions } from "./template-extensions.ts";
import { blocksOf } from "./template-text.ts";

// The prompt-template editor (F4 M4, T-124, the designer's LibCodeMirror board, ADR-0045 point 3.1): CodeMirror 6 with the slot lines fixed (atomic and read-only), the validator's issues marked in the text,
// sections that fold, CodeMirror's search and a theme from the tokens. It is the only module that imports CodeMirror and is loaded lazily with the Library: the initial chunk does not carry it. The text it holds is
// the editor text of `template-text.ts`; a different version is a different editor (the parent gives it a `key`).

export interface TemplateEditorHandle {
  /** Adds a slot at the end of the text (nothing when the text has it). */
  insertSlot(slot: string): void;
  /** The text as it is now. */
  text(): string;
}

export const TemplateEditor = forwardRef<TemplateEditorHandle, { value: string; readOnly: boolean; onChange?: (text: string) => void }>(function TemplateEditor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChange = useRef(props.onChange);
  onChange.current = props.onChange;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const v = new EditorView({
      parent: el,
      state: EditorState.create({
        doc: props.value,
        extensions: [templateExtensions({ readOnly: props.readOnly }), EditorView.updateListener.of((u) => u.docChanged && onChange.current?.(u.state.doc.toString()))],
      }),
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // A new version is a new editor (its key changes); the value is only the start.
  }, [props.readOnly]);

  useImperativeHandle(
    ref,
    () => ({
      insertSlot(slot) {
        const v = view.current;
        if (!v) return;
        const text = v.state.doc.toString();
        if (blocksOf(text).some((b) => b.slot === slot)) return;
        const at = v.state.doc.length;
        v.dispatch({ changes: { from: at, to: at, insert: `${text.endsWith("\n") ? "" : "\n"}{{${slot}}}\n` }, scrollIntoView: true });
      },
      text: () => view.current?.state.doc.toString() ?? props.value,
    }),
    [props.value],
  );

  return <div ref={host} className="tpl-editor" data-testid="template-editor" />;
});

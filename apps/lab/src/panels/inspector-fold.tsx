import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { loadInspectorFolds, storeInspectorFolds } from "../config/inspector-folds.ts";
import { useServices } from "../services.tsx";
import { WordClip } from "./word-clip.tsx";

/** Every section of the agent Inspector that can be folded, by name (the order they are shown in). */
export const FOLD_IDS = ["mindView", "beliefs", "state", "action", "plan", "queries", "config", "strategyTest", "researcher", "warnings"] as const;

interface Folds {
  readonly isOpen: (id: string) => boolean;
  readonly toggle: (id: string) => void;
  readonly setAll: (open: boolean) => void;
}

const FoldContext = createContext<Folds | undefined>(undefined);

/** The open set of the Inspector's sections, remembered per user: everything is folded to its one line until the researcher opens it. */
export function useFolds(): Folds {
  const { storage } = useServices();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const restored = useRef(false);
  useEffect(() => {
    let off = false;
    void loadInspectorFolds(storage.ports.userData).then(
      (saved) => {
        if (off) return;
        if (saved !== undefined) setOpen((cur) => (cur.size === 0 ? saved : cur));
        restored.current = true;
      },
      () => {
        restored.current = true;
      },
    );
    return () => {
      off = true;
    };
  }, [storage]);
  const save = useCallback(
    (next: ReadonlySet<string>) => {
      setOpen(next);
      if (restored.current) void storeInspectorFolds(storage.ports.userData, next).catch(() => undefined);
    },
    [storage],
  );
  return useMemo(
    () => ({
      isOpen: (id) => open.has(id),
      toggle: (id) => save(new Set(open.has(id) ? [...open].filter((x) => x !== id) : [...open, id])),
      setAll: (all) => save(all ? new Set(FOLD_IDS) : new Set()),
    }),
    [open, save],
  );
}

export const FoldProvider = FoldContext.Provider;

/** A section folded to one line (its name and a short summary) that a click opens. Without a provider (a panel that has none) it is open. */
export function Fold(props: { id: string; title: string; summary: string; testId?: string | undefined; bare?: boolean; children: ReactNode }) {
  const folds = useContext(FoldContext);
  const open = folds ? folds.isOpen(props.id) : true;
  return (
    <section className={`inspector-section fold${open ? " open" : ""}${props.bare ? " fold-bare" : ""}`} data-testid={props.testId ?? `fold-${props.id}`} data-fold={props.id} data-open={open}>
      <button type="button" className="fold-head" aria-expanded={open} onClick={() => folds?.toggle(props.id)} data-testid={`fold-head-${props.id}`}>
        <span className="fold-twist" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        <h4>{props.title}</h4>
        {!open && <WordClip className="fold-sum mono muted" text={props.summary} />}
      </button>
      {open && props.children}
    </section>
  );
}

/** Open all / fold all, for the head of the Inspector. */
export function FoldAll() {
  const folds = useContext(FoldContext);
  if (!folds) return null;
  return (
    <span className="fold-all">
      <button type="button" className="kt" onClick={() => folds.setAll(true)} aria-label="Open every section" data-testid="inspector-expand-all">
        ▾ all
      </button>
      <button type="button" className="kt" onClick={() => folds.setAll(false)} aria-label="Fold every section" data-testid="inspector-collapse-all">
        ▸ none
      </button>
    </span>
  );
}

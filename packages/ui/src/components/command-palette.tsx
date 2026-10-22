import { Fragment, useEffect, useMemo, useRef, useState } from "react";

export interface Command {
  readonly id: string;
  readonly title: string;
  readonly group: string;
  readonly run: () => void;
  readonly disabled?: boolean;
  /** The key that does the same, shown at the right of the row (`Space`, `.`, `1`). */
  readonly keys?: string;
}

/** The commands that match every term, with those of one group together (groups in the order they first appear, each group in its own order). */
export function filterCommands(commands: readonly Command[], query: string): Command[] {
  const q = query.trim().toLowerCase();
  const enabled = commands.filter((c) => !c.disabled);
  const terms = q ? q.split(/\s+/) : [];
  const found = terms.length === 0 ? enabled : enabled.filter((c) => {
    const hay = `${c.group} ${c.title}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
  const order = [...new Set(found.map((c) => c.group))];
  return found.map((c, i) => [c, i] as const).sort((a, b) => order.indexOf(a[0].group) - order.indexOf(b[0].group) || a[1] - b[1]).map(([c]) => c);
}

/** Which characters of `text` the terms matched (each term as a substring, case-insensitive). */
export function matchedChars(text: string, terms: readonly string[]): boolean[] {
  const out = text.split("").map(() => false);
  const low = text.toLowerCase();
  for (const t of terms) {
    if (t === "") continue;
    for (let at = low.indexOf(t); at >= 0; at = low.indexOf(t, at + t.length)) for (let k = at; k < at + t.length; k++) out[k] = true;
  }
  return out;
}

/** The title with the matched letters in `mark`s (the text itself when nothing matched, so it stays one text node). */
function Marked(props: { text: string; terms: readonly string[] }) {
  const hit = matchedChars(props.text, props.terms);
  if (!hit.some(Boolean)) return <>{props.text}</>;
  const parts: { text: string; on: boolean }[] = [];
  props.text.split("").forEach((ch, i) => {
    const last = parts[parts.length - 1];
    if (last && last.on === hit[i]) last.text += ch;
    else parts.push({ text: ch, on: hit[i] === true });
  });
  return (
    <>
      {parts.map((p, i) => (p.on ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
    </>
  );
}

/** Command palette skeleton (UI-SPEC §2): Ctrl/Cmd+K, type to filter, arrows + Enter, Esc to close. */
export function CommandPalette(props: { open: boolean; commands: readonly Command[]; onClose: () => void }) {
  const { open, commands, onClose } = props;
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  /** Where the focus was when the palette opened: Escape gives it back there. */
  const opener = useRef<Element | null>(null);
  const results = useMemo(() => filterCommands(commands, query), [commands, query]);
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);

  // Reset on close, not on open: an effect runs after paint, so a reset on open could wipe what the user
  // already typed after Ctrl+K (and Enter would then run the first command of the unfiltered list).
  useEffect(() => {
    if (open) {
      opener.current = document.activeElement;
      input.current?.focus();
    } else {
      setQuery("");
      setActive(0);
    }
  }, [open]);

  if (!open) return null;

  const run = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    c.run();
  };

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            onClose();
            if (opener.current instanceof HTMLElement && opener.current.isConnected) opener.current.focus();
          }
          else if (e.key === "ArrowDown") setActive((a) => Math.min(results.length - 1, a + 1));
          else if (e.key === "ArrowUp") setActive((a) => Math.max(0, a - 1));
          // Clamped: a hover may have set an index past the end of a newly filtered list.
          else if (e.key === "Enter") run(results[Math.min(active, results.length - 1)]);
          else return;
          e.preventDefault();
        }}
      >
        <input
          ref={input}
          className="mono"
          placeholder="Type a command…"
          aria-label="Command"
          aria-controls="palette-list"
          value={query}
          onChange={(e) => {
            // Reset in the same update as the filter: an effect would run after paint, and an Enter typed
            // before it could act on a stale index (e.g. one set by hovering the previous list).
            setQuery(e.target.value);
            setActive(0);
          }}
        />
        <ul id="palette-list" role="listbox" aria-label="Commands">
          {results.map((c, i) => (
            <Fragment key={c.id}>
              {results[i - 1]?.group !== c.group && (
                <li role="presentation" className="group-head">
                  {c.group}
                </li>
              )}
              <li className="selectable" role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onClick={() => run(c)}>
                <span>{terms.length > 0 ? <Marked text={c.title} terms={terms} /> : c.title}</span>
                {c.keys && <kbd>{c.keys}</kbd>}
              </li>
            </Fragment>
          ))}
          {results.length === 0 && <li className="muted">No matching commands</li>}
        </ul>
      </div>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";

export interface Command {
  readonly id: string;
  readonly title: string;
  readonly group: string;
  readonly run: () => void;
  readonly disabled?: boolean;
}

export function filterCommands(commands: readonly Command[], query: string): Command[] {
  const q = query.trim().toLowerCase();
  const enabled = commands.filter((c) => !c.disabled);
  if (!q) return enabled;
  const terms = q.split(/\s+/);
  return enabled.filter((c) => {
    const hay = `${c.group} ${c.title}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
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
            <li key={c.id} className="selectable" role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onClick={() => run(c)}>
              <span>{c.title}</span>
              <span className="group">{c.group}</span>
            </li>
          ))}
          {results.length === 0 && <li className="muted">No matching commands</li>}
        </ul>
      </div>
    </div>
  );
}

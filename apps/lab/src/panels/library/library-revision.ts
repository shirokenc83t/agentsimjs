import { useSyncExternalStore } from "react";

// A counter of the changes made to the Library in this tab (F4 M4, T-125): the Library panel bumps it after a save, an import or a duplicate, and what reads the Library (the minds table of the run
// configuration) reads it again when the counter moves.

let revision = 0;
const listeners = new Set<() => void>();

export function bumpLibraryRevision(): void {
  revision += 1;
  for (const l of listeners) l();
}

export function useLibraryRevision(): number {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => revision,
  );
}

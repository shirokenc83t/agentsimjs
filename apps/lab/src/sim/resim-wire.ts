import type { ResimError, ResimWindowRequest, ResimWindowResult } from "./resim-window.ts";

// What crosses to and from the re-simulation worker: the request without its functions (the snapshot's sections as a map by hash, the wall clock chosen by the worker),
// and the result or the typed error.

export type ResimWindowWire = Omit<ResimWindowRequest, "snapshot" | "nowWallMs"> & {
  readonly snapshot?: { readonly tick: number; readonly bytes: Uint8Array; readonly sections: ReadonlyMap<string, Uint8Array> };
};

export type ResimWorkerMessage = { readonly type: "resim"; readonly request: ResimWindowWire };
export type ResimWorkerReply = { readonly type: "result"; readonly result: ResimWindowResult } | { readonly type: "error"; readonly error: ResimError };

export function toWire(req: Omit<ResimWindowRequest, "nowWallMs">, sections: ReadonlyMap<string, Uint8Array>): ResimWindowWire {
  const { snapshot, ...rest } = req;
  return { ...rest, ...(snapshot ? { snapshot: { tick: snapshot.tick, bytes: snapshot.bytes, sections } } : {}) };
}

export function fromWire(w: ResimWindowWire, nowWallMs: () => number): ResimWindowRequest {
  const { snapshot, ...rest } = w;
  return { ...rest, nowWallMs, ...(snapshot ? { snapshot: { tick: snapshot.tick, bytes: snapshot.bytes, resolve: (h: string) => snapshot.sections.get(h) } } : {}) };
}

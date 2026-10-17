import type { SimToMain } from "@agentsim/core";
import { useEffect, useState } from "react";
import type { SimClient } from "../sim/sim-client.ts";

/**
 * The latest message of one panel stream (ADR-0019 addition of 2026-10-12): subscribes while the calling panel is
 * mounted, keeps only messages `accept` lets through (the run and agent being shown), and forgets the last one when
 * they change. The worker posts these at the panel cadence (≤ 10 Hz), so no polling is needed.
 */
export function useSimStream<T extends SimToMain["type"]>(sim: SimClient, type: T, accept: (m: Extract<SimToMain, { type: T }>) => boolean, deps: readonly unknown[]): Extract<SimToMain, { type: T }> | undefined {
  const [msg, setMsg] = useState<Extract<SimToMain, { type: T }> | undefined>(undefined);
  useEffect(() => {
    setMsg(undefined);
    return sim.subscribe(type, (m) => {
      if (accept(m)) setMsg(m);
    });
    // `accept` is rebuilt every render: `deps` says what it depends on.
  }, [sim, type, ...deps]);
  return msg;
}

/// <reference lib="webworker" />
import { initValidation, MainToSim, validate } from "@agentsim/core";
import { runSimHost } from "../sim/sim-host.ts";

initValidation();
runSimHost(
  self,
  {
    now: () => performance.now(),
    epochNow: () => performance.timeOrigin + performance.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as number),
  },
  // Internal peer: checked in dev only; production builds drop the checker (ADR-0018).
  import.meta.env.DEV ? (m) => validate(MainToSim, m) : undefined,
);

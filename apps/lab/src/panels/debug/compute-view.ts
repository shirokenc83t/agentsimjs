import type { TraceRecord } from "@agentsim/trace";
import type { BeliefMapBytes } from "../../shell/knowledge-union.ts";

// What the Compute inspector says of one compute call of a mind and how it draws it (F4 M4, T-123, the designer's LLMInspector board): the words of the result, and the path over the map the agent *believes*
// in (unknown cells hatched), never the ground truth: a path through hatched cells shows that the agent planned through what it does not know. Pure; the reads are the panel's.

const payload = (r: TraceRecord): Record<string, unknown> => (r.payload !== null && typeof r.payload === "object" ? (r.payload as Record<string, unknown>) : {});
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

export interface Waypoint {
  readonly xM: number;
  readonly yM: number;
}

export interface ComputeFacts {
  readonly tool: string;
  readonly ok: boolean;
  readonly status: string | undefined;
  readonly code: string | undefined;
  readonly expansions: number | undefined;
  readonly params: unknown;
  /** The result in words, one line per fact. */
  readonly lines: readonly string[];
  /** The route the call planned (planPath), start first; empty for the tools that draw none. */
  readonly waypoints: readonly Waypoint[];
  /** Where it was asked from and to, when the parameters say so (points, not `home`). */
  readonly to: Waypoint | undefined;
}

const point = (v: unknown): Waypoint | undefined => {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as { xM?: unknown; yM?: unknown };
  return typeof o.xM === "number" && typeof o.yM === "number" ? { xM: o.xM, yM: o.yM } : undefined;
};

/** The facts of a `compute` `tool` record, for the panel. */
export function computeFacts(r: TraceRecord): ComputeFacts {
  const p = payload(r);
  const result = (p["result"] ?? {}) as Record<string, unknown>;
  const tool = String(p["tool"] ?? "");
  const lines: string[] = [];
  if (p["ok"] === false) lines.push(`refused · ${String(p["code"] ?? "")}: ${String(p["message"] ?? "")}`);
  else if (tool === "planPath") {
    const wps = Array.isArray(result["waypoints"]) ? (result["waypoints"] as unknown[]).length : 0;
    lines.push(`${wps} waypoint${wps === 1 ? "" : "s"} · ${num(result["lengthM"])?.toFixed(1)} m · ${num(result["etaS"])?.toFixed(1)} s · ${num(result["energyPct"])?.toFixed(1)} % battery · ${String(result["status"])}`);
  } else if (tool === "estimateCost") {
    const legs = Array.isArray(result["legs"]) ? (result["legs"] as Record<string, unknown>[]) : [];
    lines.push(`total ${num(result["lengthM"])?.toFixed(1)} m · ${num(result["etaS"])?.toFixed(1)} s · ${num(result["energyPct"])?.toFixed(1)} % · ${String(result["status"])}`);
    legs.forEach((l, i) => lines.push(`leg ${i + 1}: ${num(l["lengthM"])?.toFixed(1)} m · ${num(l["etaS"])?.toFixed(1)} s · ${String(l["status"])}`));
  } else if (tool === "kShortestPaths") {
    const paths = Array.isArray(result["paths"]) ? (result["paths"] as Record<string, unknown>[]) : [];
    lines.push(`${paths.length} route${paths.length === 1 ? "" : "s"} · ${String(result["status"])}`);
    paths.forEach((x, i) => lines.push(`route ${i + 1}: ${num(x["lengthM"])?.toFixed(1)} m · ${num(x["etaS"])?.toFixed(1)} s · shares ${String(x["sharedPct"])} % with the best`));
  } else if (tool === "querySpace") {
    lines.push(result["region"] !== undefined ? `region ${String((result["region"] as { id?: unknown }).id ?? "")} and its frontiers` : "the summary of space, as the request carried it");
  }
  const wp = Array.isArray(result["waypoints"]) ? (result["waypoints"] as unknown[]).flatMap((w) => point(w) ?? []) : [];
  const params = p["params"] as { to?: unknown } | undefined;
  return { tool, ok: p["ok"] !== false, status: typeof p["status"] === "string" ? p["status"] : undefined, code: typeof p["code"] === "string" ? p["code"] : undefined, expansions: num(p["expansions"]), params: p["params"], lines, waypoints: wp, to: point(params?.to) };
}

/** What the agent believes of a cell: 0 unknown, 1 free, 2 occupied (the bytes of a replayed belief map), or 0 where the map has no chunk. */
export function beliefAt(map: BeliefMapBytes, i: number, j: number): number {
  if (i < 0 || j < 0 || i >= map.sizeX || j >= map.sizeY) return 0;
  const cs = map.chunkSize;
  const ci = Math.floor(i / cs);
  const cj = Math.floor(j / cs);
  const chunks = Math.floor(map.coords.length / 2);
  for (let k = 0; k < chunks; k++) {
    if (map.coords[2 * k] === ci && map.coords[2 * k + 1] === cj) return (map.data[k * cs * cs + (j - cj * cs) * cs + (i - ci * cs)] as number) ?? 0;
  }
  return 0;
}

/** How much of a route lies over cells the agent has not seen (state 0) or believes occupied (state 2), in metres, sampled every half cell. */
export function routeOverBelief(map: BeliefMapBytes, resolutionM: number, route: readonly Waypoint[]): { readonly unknownM: number; readonly occupiedM: number; readonly totalM: number } {
  let unknownM = 0;
  let occupiedM = 0;
  let totalM = 0;
  const step = resolutionM / 2;
  for (let k = 1; k < route.length; k++) {
    const a = route[k - 1] as Waypoint;
    const b = route[k] as Waypoint;
    const len = Math.hypot(b.xM - a.xM, b.yM - a.yM);
    totalM += len;
    const n = Math.max(1, Math.ceil(len / step));
    for (let s = 0; s < n; s++) {
      const t = (s + 0.5) / n;
      const st = beliefAt(map, Math.floor((a.xM + (b.xM - a.xM) * t) / resolutionM), Math.floor((a.yM + (b.yM - a.yM) * t) / resolutionM));
      if (st === 0) unknownM += len / n;
      else if (st === 2) occupiedM += len / n;
    }
  }
  return { unknownM, occupiedM, totalM };
}

/** The belief map as pixels, `stride` cells to a pixel: 0 unknown (hatched: every other diagonal), 1 free, 2 occupied; row 0 is the top (north up). */
export function beliefPixels(map: BeliefMapBytes, stride: number): { readonly width: number; readonly height: number; readonly cls: Uint8Array } {
  const width = Math.ceil(map.sizeX / stride);
  const height = Math.ceil(map.sizeY / stride);
  const cls = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const st = beliefAt(map, x * stride, (height - 1 - y) * stride);
      // Class 3 is an unknown pixel on the hatch line, so a hatched area reads as stripes.
      cls[y * width + x] = st === 0 ? ((x + y) % 4 < 2 ? 0 : 3) : st;
    }
  }
  return { width, height, cls };
}

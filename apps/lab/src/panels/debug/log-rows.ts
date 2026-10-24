import { GLYPH } from "@agentsim/ui";
import type { TraceRecord } from "@agentsim/trace";

/** How an action ended, for the result column: a glyph and the word (a failure is also what tints the row). */
export const resultOf = (r: TraceRecord): { text: string; failed: boolean } | undefined => {
  const p = r.payload !== null && typeof r.payload === "object" ? (r.payload as { op?: unknown; status?: unknown; failure?: { code?: unknown } }) : {};
  if (r.kind !== "action" || p.op !== "end" || typeof p.status !== "string") return undefined;
  if (p.status === "failed") return { text: `${GLYPH.fail} failed${typeof p.failure?.code === "string" ? ` · ${p.failure.code}` : ""}`, failed: true };
  return { text: p.status === "succeeded" ? `${GLYPH.ok} succeeded` : `${GLYPH.idle} ${p.status}`, failed: false };
};

export const summary = (r: TraceRecord): string => {
  const p = r.payload !== null && typeof r.payload === "object" ? (r.payload as Record<string, unknown>) : {};
  const op = typeof p["op"] === "string" ? p["op"] : "";
  const name = typeof p["name"] === "string" ? p["name"] : "";
  return [op, name, r.detail ?? ""].filter((x) => x !== "").join(" · ");
};

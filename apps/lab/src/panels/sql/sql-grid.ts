import type { SqlResult } from "@agentsim/storage";

const SAMPLE_ROWS = 200;
const MIN_CH = 4;
const MAX_CH = 56;

/** The text a cell shows. */
export const cellText = (v: unknown): string => (v === null ? "NULL" : String(v));

/**
 * The width of each column of a result in characters: what its header and its first rows need, at least a few and at most a screenful, so a narrow result (a kind and a
 * count) is two narrow columns and not two columns stretched over the whole width.
 */
export function columnWidths(result: Pick<SqlResult, "columns" | "rows">): number[] {
  const widths = result.columns.map((c) => c.length + 2);
  for (const row of result.rows.slice(0, SAMPLE_ROWS)) {
    row.forEach((v, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cellText(v).length);
    });
  }
  return widths.map((w) => Math.min(MAX_CH, Math.max(MIN_CH, w + 1)));
}

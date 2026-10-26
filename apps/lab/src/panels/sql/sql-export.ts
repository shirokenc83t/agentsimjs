import type { SqlResult } from "@agentsim/storage";

/** A result as CSV (RFC 4180): a header, every cell quoted when it has a comma, a quote or a line break; null is an empty cell. */
export function toCsv(r: Pick<SqlResult, "columns" | "rows">): string {
  const cell = (v: string | number | null): string => {
    if (v === null) return "";
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [r.columns.map((c) => cell(c)).join(","), ...r.rows.map((row) => row.map(cell).join(","))];
  return `${lines.join("\r\n")}\r\n`;
}

/** A result as JSON lines: one object a row, keyed by column (a column that appears twice keeps the later value). */
export function toJsonl(r: Pick<SqlResult, "columns" | "rows">): string {
  if (r.rows.length === 0) return "";
  return `${r.rows.map((row) => JSON.stringify(Object.fromEntries(r.columns.map((c, i) => [c, row[i] ?? null])))).join("\n")}\n`;
}

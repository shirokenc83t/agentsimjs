// Syntax colouring of the SQL console's editor: the statement cut into tokens by kind, nothing more. The editor is a plain text area with this drawn behind its (transparent)
// text, so the caret, the selection and the keys are the browser's own; the tokens never change the text, only how it is coloured.

export type SqlTokenKind = "keyword" | "string" | "number" | "comment" | "function" | "plain";

export interface SqlToken {
  readonly kind: SqlTokenKind;
  readonly text: string;
}

const KEYWORDS = new Set([
  "select", "from", "where", "group", "by", "order", "limit", "offset", "join", "left", "right", "inner", "outer", "cross", "on", "as", "and", "or", "not", "in", "is", "null", "like", "glob",
  "between", "distinct", "having", "union", "all", "with", "recursive", "case", "when", "then", "else", "end", "asc", "desc", "values", "explain", "query", "plan", "exists", "using", "natural",
  "except", "intersect", "over", "partition", "window", "filter", "true", "false", "cast",
]);

/** The statement as tokens: concatenating their texts gives the statement back, character for character. */
export function highlightSql(sql: string): SqlToken[] {
  const out: SqlToken[] = [];
  const push = (kind: SqlTokenKind, text: string) => {
    if (text === "") return;
    const last = out[out.length - 1];
    if (last && last.kind === kind && kind === "plain") out[out.length - 1] = { kind, text: last.text + text };
    else out.push({ kind, text });
  };
  let i = 0;
  while (i < sql.length) {
    const c = sql[i] as string;
    const rest = sql.slice(i);
    if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end < 0 ? sql.length : end;
      push("comment", sql.slice(i, stop));
      i = stop;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end < 0 ? sql.length : end + 2;
      push("comment", sql.slice(i, stop));
      i = stop;
    } else if (c === "'" || c === '"') {
      // A quote is doubled to put one in the text (`'it''s'`); an unclosed string runs to the end.
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) j += 2;
          else break;
        } else j++;
      }
      const stop = Math.min(sql.length, j + 1);
      push(c === "'" ? "string" : "plain", sql.slice(i, stop));
      i = stop;
    } else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(sql[i + 1] ?? ""))) {
      const m = /^(?:0x[0-9a-f]+|[0-9]*\.?[0-9]+(?:e[+-]?[0-9]+)?)/i.exec(rest);
      const text = m?.[0] ?? c;
      push("number", text);
      i += text.length;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
      const word = m?.[0] ?? c;
      const after = sql.slice(i + word.length).match(/^\s*\(/);
      push(KEYWORDS.has(word.toLowerCase()) ? "keyword" : after ? "function" : "plain", word);
      i += word.length;
    } else {
      push("plain", c);
      i++;
    }
  }
  return out;
}

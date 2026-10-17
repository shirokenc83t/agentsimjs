import { err, ok, type CodedError, type Result } from "../result.ts";

/**
 * Whitelisted expression grammar v1 (ADR-0026, refining ADR-0008/0011). Untrusted input from agents,
 * LLMs and scenario files: tokenized and parsed by hand (no eval, no code generation), bounded, statically
 * typed against a context whitelist, then interpreted over numeric slots (allocation-free evaluation).
 *
 *   expr = or ; or = and {"or" and} ; and = not {"and" not} ; not = "not" not | cmp ;
 *   cmp  = sum [("<"|"<="|">"|">="|"=="|"!=") sum] ; sum = prod {("+"|"-") prod} ;
 *   prod = unary {("*"|"/") unary} ; unary = "-" unary | atom ;
 *   atom = number | "true" | "false" | string | name | "(" expr ")" ; name = ident {"." ident}
 */

export const EXPR_LIMITS = {
  maxSourceLength: 512,
  maxNodes: 64,
  maxDepth: 16,
  maxIdentifierLength: 64,
  maxStringLength: 64,
  maxAbsNumber: 1e12,
} as const;

export type ExprErrorCode =
  | "expr_too_long"
  | "expr_bad_char"
  | "expr_syntax"
  | "expr_too_many_nodes"
  | "expr_too_deep"
  | "expr_unknown_name"
  | "expr_type"
  | "expr_number_out_of_range"
  | "expr_identifier_too_long"
  | "expr_string_too_long"
  | "expr_unknown_enum_value";

export type ExprError = CodedError<ExprErrorCode> & { readonly position: number };

/** Variable types a context can expose. Enum values are compared by equality only. */
export type ExprVarType = { readonly type: "number" } | { readonly type: "boolean" } | { readonly type: "enum"; readonly values: readonly string[] };

/** A context: the only names an expression may reference (ADR-0026). */
export type ExprContext = Readonly<Record<string, ExprVarType>>;

type BinOp = "or" | "and" | "<" | "<=" | ">" | ">=" | "==" | "!=" | "+" | "-" | "*" | "/";

/** Compiled node over numeric slots. */
type Node =
  | { readonly k: "const"; readonly v: number }
  | { readonly k: "slot"; readonly i: number }
  | { readonly k: "neg"; readonly e: Node }
  | { readonly k: "not"; readonly e: Node }
  | { readonly k: "bin"; readonly op: BinOp; readonly l: Node; readonly r: Node };

export interface CompiledExpr {
  readonly source: string;
  /** Variable names in slot order (sorted, deterministic). */
  readonly variables: readonly string[];
  readonly resultType: "number" | "boolean";
  readonly root: Node;
}

// ---- tokenizer ---------------------------------------------------------------------------------

type Tok =
  | { t: "num"; v: number; pos: number }
  | { t: "str"; v: string; pos: number }
  | { t: "id"; v: string; pos: number }
  | { t: "op"; v: string; pos: number }
  | { t: "end"; pos: number };

const KEYWORDS = new Set(["and", "or", "not", "true", "false"]);

function fail(code: ExprErrorCode, message: string, position: number): { ok: false; error: ExprError } {
  return err({ code, message, position });
}

function tokenize(src: string): Result<Tok[], ExprError> {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) {
      i++;
      continue;
    }
    if (c > 126 || c < 32) return fail("expr_bad_char", `character not allowed at ${i}`, i);
    const ch = src[i] ?? "";
    if (ch >= "0" && ch <= "9") {
      const m = /^\d+(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i));
      const text = m?.[0] ?? "";
      const v = Number(text);
      if (!Number.isFinite(v) || Math.abs(v) > EXPR_LIMITS.maxAbsNumber) return fail("expr_number_out_of_range", `number out of range at ${i}`, i);
      out.push({ t: "num", v, pos: i });
      i += text.length;
      continue;
    }
    if (ch === '"') {
      const end = src.indexOf('"', i + 1);
      if (end < 0) return fail("expr_syntax", `unterminated string at ${i}`, i);
      const v = src.slice(i + 1, end);
      if (v.length > EXPR_LIMITS.maxStringLength) return fail("expr_string_too_long", `string too long at ${i}`, i);
      if (/[\\`$]/.test(v)) return fail("expr_bad_char", `escapes are not allowed in strings (at ${i})`, i);
      out.push({ t: "str", v, pos: i });
      i = end + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(src.slice(i));
      const text = m?.[0] ?? ch;
      if (text.length > EXPR_LIMITS.maxIdentifierLength) return fail("expr_identifier_too_long", `identifier too long at ${i}`, i);
      out.push({ t: "id", v: text, pos: i });
      i += text.length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "<=" || two === ">=" || two === "==" || two === "!=") {
      out.push({ t: "op", v: two, pos: i });
      i += 2;
      continue;
    }
    if ("<>+-*/()".includes(ch)) {
      out.push({ t: "op", v: ch, pos: i });
      i++;
      continue;
    }
    return fail("expr_bad_char", `unexpected '${ch}' at ${i}`, i);
  }
  out.push({ t: "end", pos: src.length });
  return ok(out);
}

// ---- parser + type checker ---------------------------------------------------------------------

type Typed = { node: Node; type: "number" | "boolean" | "enum"; enumValues?: readonly string[]; strLiteral?: string; pos: number };

class Parser {
  private p = 0;
  private nodes = 0;
  private readonly slots = new Map<string, number>();

  constructor(
    private readonly toks: Tok[],
    private readonly ctx: ExprContext,
    sortedNames: readonly string[],
  ) {
    sortedNames.forEach((n, i) => this.slots.set(n, i));
  }

  private peek(): Tok {
    return this.toks[this.p] ?? { t: "end", pos: 0 };
  }

  private isOp(v: string): boolean {
    const t = this.peek();
    return (t.t === "op" && t.v === v) || (t.t === "id" && t.v === v && KEYWORDS.has(v));
  }

  private count(pos: number): void {
    if (++this.nodes > EXPR_LIMITS.maxNodes) throw new ParseFailure("expr_too_many_nodes", `more than ${EXPR_LIMITS.maxNodes} nodes`, pos);
  }

  parse(): Typed {
    const e = this.or();
    const t = this.peek();
    if (t.t !== "end") throw new ParseFailure("expr_syntax", `unexpected token at ${t.pos}`, t.pos);
    return e;
  }

  private bool(e: Typed, what: string): void {
    if (e.type !== "boolean") throw new ParseFailure("expr_type", `${what} needs a boolean`, e.pos);
  }

  private num(e: Typed, what: string): void {
    if (e.type !== "number") throw new ParseFailure("expr_type", `${what} needs a number`, e.pos);
  }

  private or(): Typed {
    let l = this.and();
    while (this.isOp("or")) {
      const pos = this.peek().pos;
      this.p++;
      const r = this.and();
      this.bool(l, "'or'");
      this.bool(r, "'or'");
      this.count(pos);
      l = { node: { k: "bin", op: "or", l: l.node, r: r.node }, type: "boolean", pos };
    }
    return l;
  }

  private and(): Typed {
    let l = this.not();
    while (this.isOp("and")) {
      const pos = this.peek().pos;
      this.p++;
      const r = this.not();
      this.bool(l, "'and'");
      this.bool(r, "'and'");
      this.count(pos);
      l = { node: { k: "bin", op: "and", l: l.node, r: r.node }, type: "boolean", pos };
    }
    return l;
  }

  private not(): Typed {
    if (this.isOp("not")) {
      const pos = this.peek().pos;
      this.p++;
      const e = this.not();
      this.bool(e, "'not'");
      this.count(pos);
      return { node: { k: "not", e: e.node }, type: "boolean", pos };
    }
    return this.cmp();
  }

  private cmp(): Typed {
    const l = this.sum();
    const t = this.peek();
    if (t.t === "op" && ["<", "<=", ">", ">=", "==", "!="].includes(t.v)) {
      this.p++;
      const r = this.sum();
      const op = t.v as BinOp;
      this.count(t.pos);
      if (op === "==" || op === "!=") return { node: this.equality(op, l, r, t.pos), type: "boolean", pos: t.pos };
      this.num(l, `'${op}'`);
      this.num(r, `'${op}'`);
      return { node: { k: "bin", op, l: l.node, r: r.node }, type: "boolean", pos: t.pos };
    }
    return l;
  }

  private equality(op: "==" | "!=", l: Typed, r: Typed, pos: number): Node {
    const enumSide = l.type === "enum" ? l : r.type === "enum" ? r : undefined;
    if (enumSide) {
      const other = enumSide === l ? r : l;
      if (other.strLiteral === undefined) throw new ParseFailure("expr_type", "an enum can only be compared with a string literal", pos);
      const idx = enumSide.enumValues?.indexOf(other.strLiteral) ?? -1;
      if (idx < 0) throw new ParseFailure("expr_unknown_enum_value", `"${other.strLiteral}" is not a valid value`, other.pos);
      return { k: "bin", op, l: enumSide.node, r: { k: "const", v: idx } };
    }
    if (l.strLiteral !== undefined || r.strLiteral !== undefined) throw new ParseFailure("expr_type", "strings can only be compared with enum variables", pos);
    if (l.type !== r.type) throw new ParseFailure("expr_type", `cannot compare ${l.type} with ${r.type}`, pos);
    return { k: "bin", op, l: l.node, r: r.node };
  }

  private sum(): Typed {
    let l = this.prod();
    for (;;) {
      const t = this.peek();
      if (t.t !== "op" || (t.v !== "+" && t.v !== "-")) return l;
      this.p++;
      const r = this.prod();
      this.num(l, `'${t.v}'`);
      this.num(r, `'${t.v}'`);
      this.count(t.pos);
      l = { node: { k: "bin", op: t.v as BinOp, l: l.node, r: r.node }, type: "number", pos: t.pos };
    }
  }

  private prod(): Typed {
    let l = this.unary();
    for (;;) {
      const t = this.peek();
      if (t.t !== "op" || (t.v !== "*" && t.v !== "/")) return l;
      this.p++;
      const r = this.unary();
      this.num(l, `'${t.v}'`);
      this.num(r, `'${t.v}'`);
      this.count(t.pos);
      l = { node: { k: "bin", op: t.v as BinOp, l: l.node, r: r.node }, type: "number", pos: t.pos };
    }
  }

  private unary(): Typed {
    const t = this.peek();
    if (t.t === "op" && t.v === "-") {
      this.p++;
      const e = this.unary();
      this.num(e, "unary '-'");
      this.count(t.pos);
      return { node: { k: "neg", e: e.node }, type: "number", pos: t.pos };
    }
    return this.atom();
  }

  private atom(): Typed {
    const t = this.peek();
    this.count(t.pos);
    if (t.t === "num") {
      this.p++;
      return { node: { k: "const", v: t.v }, type: "number", pos: t.pos };
    }
    if (t.t === "str") {
      this.p++;
      return { node: { k: "const", v: Number.NaN }, type: "number", strLiteral: t.v, pos: t.pos };
    }
    if (t.t === "op" && t.v === "(") {
      this.p++;
      const e = this.or();
      const c = this.peek();
      if (c.t !== "op" || c.v !== ")") throw new ParseFailure("expr_syntax", `expected ')' at ${c.pos}`, c.pos);
      this.p++;
      return e;
    }
    if (t.t === "id") {
      this.p++;
      if (t.v === "true" || t.v === "false") return { node: { k: "const", v: t.v === "true" ? 1 : 0 }, type: "boolean", pos: t.pos };
      if (KEYWORDS.has(t.v)) throw new ParseFailure("expr_syntax", `unexpected '${t.v}' at ${t.pos}`, t.pos);
      if (!Object.prototype.hasOwnProperty.call(this.ctx, t.v)) throw new ParseFailure("expr_unknown_name", `unknown name '${t.v}'`, t.pos);
      const vt = this.ctx[t.v];
      const slot = this.slots.get(t.v);
      if (!vt || slot === undefined) throw new ParseFailure("expr_unknown_name", `unknown name '${t.v}'`, t.pos);
      if (vt.type === "enum") return { node: { k: "slot", i: slot }, type: "enum", enumValues: vt.values, pos: t.pos };
      return { node: { k: "slot", i: slot }, type: vt.type, pos: t.pos };
    }
    throw new ParseFailure("expr_syntax", `unexpected token at ${t.pos}`, t.pos);
  }
}

class ParseFailure extends Error {
  constructor(
    readonly code: ExprErrorCode,
    message: string,
    readonly position: number,
  ) {
    super(message);
  }
}

/** Depth of the compiled tree (a leaf has depth 1). Recursion is bounded by the source-length limit. */
function astDepth(n: Node): number {
  switch (n.k) {
    case "const":
    case "slot":
      return 1;
    case "neg":
    case "not":
      return 1 + astDepth(n.e);
    case "bin":
      return 1 + Math.max(astDepth(n.l), astDepth(n.r));
  }
}

function collectNames(toks: Tok[], ctx: ExprContext): string[] {
  const names = new Set<string>();
  for (const t of toks) if (t.t === "id" && !KEYWORDS.has(t.v) && Object.prototype.hasOwnProperty.call(ctx, t.v)) names.add(t.v);
  return [...names].sort();
}

/** Compiles `source` against `ctx`. `expect` is the required result type (default boolean). */
export function compileExpr(source: string, ctx: ExprContext, expect: "boolean" | "number" = "boolean"): Result<CompiledExpr, ExprError> {
  if (typeof source !== "string") return fail("expr_syntax", "expression must be a string", 0);
  if (source.length > EXPR_LIMITS.maxSourceLength) return fail("expr_too_long", `longer than ${EXPR_LIMITS.maxSourceLength} characters`, EXPR_LIMITS.maxSourceLength);
  const toks = tokenize(source);
  if (!toks.ok) return toks;
  const variables = collectNames(toks.value, ctx);
  try {
    const typed = new Parser(toks.value, ctx, variables).parse();
    if (astDepth(typed.node) > EXPR_LIMITS.maxDepth) return fail("expr_too_deep", `nesting deeper than ${EXPR_LIMITS.maxDepth}`, 0);
    if (typed.strLiteral !== undefined || typed.type === "enum") return fail("expr_type", "a string or enum cannot be a result", typed.pos);
    if (typed.type !== expect) return fail("expr_type", `expected a ${expect} expression`, typed.pos);
    return ok({ source, variables, resultType: typed.type, root: typed.node });
  } catch (e) {
    if (e instanceof ParseFailure) return fail(e.code, e.message, e.position);
    throw e;
  }
}

/**
 * Evaluates over numeric slots (index = position in `compiled.variables`; booleans 0/1, enums as value
 * index). Returns NaN if any intermediate value is non-finite; callers treat that as failing closed.
 */
export function evaluateExpr(compiled: CompiledExpr, slots: ArrayLike<number>): number {
  return evalNode(compiled.root, slots);
}

/** Boolean evaluation that fails closed: non-finite intermediates yield `false` (ADR-0026). */
export function evaluateCondition(compiled: CompiledExpr, slots: ArrayLike<number>): boolean {
  const v = evalNode(compiled.root, slots);
  return v === 1;
}

function evalNode(n: Node, s: ArrayLike<number>): number {
  switch (n.k) {
    case "const":
      return n.v;
    case "slot":
      return s[n.i] ?? Number.NaN;
    case "neg":
      return -evalNode(n.e, s);
    case "not": {
      const v = evalNode(n.e, s);
      return Number.isNaN(v) ? Number.NaN : v === 1 ? 0 : 1;
    }
    case "bin": {
      if (n.op === "and" || n.op === "or") {
        const l = evalNode(n.l, s);
        if (Number.isNaN(l)) return Number.NaN;
        if (n.op === "and" && l === 0) return 0;
        if (n.op === "or" && l === 1) return 1;
        const r = evalNode(n.r, s);
        return Number.isNaN(r) ? Number.NaN : r === 1 ? 1 : 0;
      }
      const l = evalNode(n.l, s);
      const r = evalNode(n.r, s);
      if (!Number.isFinite(l) || !Number.isFinite(r)) return Number.NaN;
      switch (n.op) {
        case "+":
          return finite(l + r);
        case "-":
          return finite(l - r);
        case "*":
          return finite(l * r);
        case "/":
          return finite(l / r);
        case "<":
          return l < r ? 1 : 0;
        case "<=":
          return l <= r ? 1 : 0;
        case ">":
          return l > r ? 1 : 0;
        case ">=":
          return l >= r ? 1 : 0;
        case "==":
          return l === r ? 1 : 0;
        default:
          return l !== r ? 1 : 0;
      }
    }
  }
}

const finite = (v: number): number => (Number.isFinite(v) ? v : Number.NaN);

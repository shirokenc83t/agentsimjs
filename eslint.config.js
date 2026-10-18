// ESLint flat config. Hard rules from CLAUDE.md / ADR-0002, 0008, 0010, 0013, 0018, 0021.
// Flat config does not merge options of the same rule across blocks (the last match wins),
// so restriction rules are generated per scope from shared building blocks.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const DETERMINISTIC = ["core", "spatial", "algorithms", "plans", "policies", "protocols"].map(
  (p) => `packages/${p}/src/**/*.{ts,tsx}`,
);
const STORAGE = ["packages/storage/src/**/*.{ts,tsx}"];
const NODE_SQLITE_DRIVER = ["packages/storage/src/drivers/node-sql-driver.ts"];
// The only modules allowed to use dynamic import(): app-level lazy loading of workspaces/panels.
const LAZY_LOADERS = ["apps/*/src/workspaces/registry.tsx", "apps/*/src/workers/replay-registry.ts", "packages/storage/src/worker/load-sqlite.ts"];

const msg = {
  sqlite: "SQLite is accessed only inside packages/storage, through the storage ports (ADR-0010).",
  nodeSqlite: "node:sqlite is used only by NodeSqlDriver (ADR-0020).",
  codegen: "Code-generating validators are forbidden; validate with validate()/isValid() from @agentsim/core (ADR-0018).",
  three: "Deterministic packages must not depend on rendering libraries.",
  react: "Deterministic packages must not depend on UI libraries.",
  validator:
    "Validate only through validate()/isValid() from @agentsim/core: they configure TypeBox first (ADR-0018), so nothing can validate before initValidation() — the lab main thread initializes lazily.",
};
// The TypeBox checker and its settings are reached only through the core validation wrapper (ADR-0018 addition 2026-10-08).
const VALIDATION_WRAPPER = ["packages/core/src/contracts/**/*.ts"];
const validatorPatterns = [{ group: ["typebox/value", "typebox/value/*", "typebox/schema", "typebox/schema/*", "typebox/system", "typebox/system/*"], message: msg.validator }];

// MUI is imported by path only (ADR-0032 §3): root imports pull every module into dev transforms.
const muiRootImports = [
  { name: "@mui/material", message: "Import MUI components by path (@mui/material/Button), not from the root (ADR-0032 §3)." },
  { name: "@mui/icons-material", message: "Import icons by path (@mui/icons-material/Close), not from the root (ADR-0032 §3)." },
];

const codegenPatterns = [
  { group: ["typebox/compile", "typebox/compile/*"], message: msg.codegen },
  { group: ["@sinclair/typebox", "@sinclair/typebox/*"], message: "Use the `typebox` 1.x line (ADR-0018)." },
  { group: ["ajv", "ajv/*", "ajv-*"], message: msg.codegen },
];
function restrictedImports({ allowSqlite = false, allowNodeSqlite = false, deterministic = false, allowValidator = false } = {}) {
  const paths = [...muiRootImports];
  const patterns = [...codegenPatterns];
  if (!allowValidator) patterns.push(...validatorPatterns);
  if (!allowSqlite) patterns.push({ group: ["@sqlite.org/sqlite-wasm", "@sqlite.org/sqlite-wasm/*"], message: msg.sqlite });
  if (!allowNodeSqlite) paths.push({ name: "node:sqlite", message: msg.nodeSqlite });
  if (deterministic) {
    patterns.push({ group: ["three", "three/*"], message: msg.three });
    patterns.push({ group: ["react", "react/*", "react-dom", "react-dom/*"], message: msg.react });
  }
  return ["error", { paths, patterns }];
}

const evalSyntax = [
  { selector: "NewExpression[callee.name='Function']", message: "new Function() — agents never ship code (ADR-0008)." },
  { selector: "CallExpression[callee.name='Function']", message: "Function() — agents never ship code (ADR-0008)." },
];
const dynamicImport = { selector: "ImportExpression", message: "Dynamic import() is only allowed in lazy-loading registries (ADR-0021)." };
const newDate = { selector: "NewExpression[callee.name='Date']", message: "new Date() — use the sim Clock (ADR-0002)." };
const powOperator = [
  { selector: "BinaryExpression[operator='**']", message: "** is engine-approximated — use detmath.pow (ADR-0023)." },
  { selector: "AssignmentExpression[operator='**=']", message: "**= is engine-approximated — use detmath.pow (ADR-0023)." },
];
// No literal colours outside packages/ui/src/theme (ADR-0032 §1): every surface takes colours from the tokens.
const colourMsg = "Literal colour — use a design token from packages/ui/src/theme (ADR-0032 §1).";
const literalColours = [
  { selector: "Literal[value=/^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/]", message: colourMsg },
  { selector: "Literal[value=/(?:^|[^a-zA-Z])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\\(/]", message: colourMsg },
  { selector: "TemplateElement[value.raw=/(?:^|[^a-zA-Z])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\\(|#[0-9a-fA-F]{6}\\b/]", message: colourMsg },
  {
    selector:
      "Property[key.name=/^(?:color|background|backgroundColor|borderColor|outlineColor|fill|stroke)$/] > Literal[value=/^(?:black|white|red|green|blue|yellow|orange|purple|pink|cyan|magenta|gray|grey|silver|maroon|navy|teal|olive|lime|aqua|fuchsia)$/i]",
    message: colourMsg,
  },
];
// Numeric hex colours (e.g. 0x58a6ff for Three.js) are checked in UI code only: elsewhere 6-digit hex
// numbers are hash and bit constants.
const numericColours = { selector: "Literal[raw=/^0x[0-9a-fA-F]{6}$/]", message: `${colourMsg} Numeric hex colours too (e.g. Three.js).` };
const UI_CODE = ["apps/**/*.{ts,tsx}", "packages/ui/**/*.{ts,tsx}"];
const COLOUR_EXEMPT = ["packages/ui/src/theme/**", "**/*.test.{ts,tsx}", "**/*.bench.ts", "**/*.spec.ts", "bench/**", "tools/**", "docs/**", "fixtures/**"];

function restrictedSyntax({ allowDynamicImport = false, deterministic = false, allowColours = false, ui = false } = {}) {
  const s = [...evalSyntax];
  if (!allowColours) s.push(...literalColours);
  if (!allowColours && ui) s.push(numericColours);
  if (!allowDynamicImport) s.push(dynamicImport);
  if (deterministic) s.push(newDate, ...powOperator);
  return ["error", ...s];
}

const sabGlobal = { name: "SharedArrayBuffer", message: "SharedArrayBuffer is not allowed (ADR-0013)." };
const deterministicGlobals = ["setTimeout", "setInterval", "setImmediate", "requestAnimationFrame", "performance", "document", "window"].map(
  (name) => ({ name, message: `${name} — the core is tick-driven and runtime-agnostic (ADR-0002).` }),
);
function restrictedGlobals({ deterministic = false } = {}) {
  return ["error", sabGlobal, ...(deterministic ? deterministicGlobals : [])];
}

const deterministicProperties = [
  ["Math", "random", "use the run Rng (ADR-0002)"],
  ["Date", "now", "use the sim Clock (ADR-0002)"],
  ["performance", "now", "use the sim Clock (ADR-0002)"],
  ["crypto", "randomUUID", "IDs are per-run counters (ADR-0015)"],
  ["globalThis", "setTimeout", "the core is tick-driven (ADR-0002)"],
  ["globalThis", "setInterval", "the core is tick-driven (ADR-0002)"],
  // Engine-approximated transcendental functions (ADR-0023): use detmath instead.
  ...["sin", "cos", "tan", "asin", "acos", "atan", "atan2", "sinh", "cosh", "tanh", "asinh", "acosh", "atanh", "exp", "expm1", "log", "log1p", "log2", "log10", "pow", "cbrt", "hypot"].map(
    (fn) => ["Math", fn, "engine-approximated, use detmath (ADR-0023)"],
  ),
].map(([object, property, why]) => ({ object, property, message: `${object}.${property} — ${why}.` }));

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/coverage/**", "**/node_modules/**", "playwright-report/**", "test-results/**", "bench/results/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.es2023 } },
    rules: {
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-restricted-imports": restrictedImports(),
      "no-restricted-syntax": restrictedSyntax(),
      "no-restricted-globals": restrictedGlobals(),
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["**/*.{js,mjs,cjs}", "**/*.config.{ts,js}", "tools/**/*.{ts,mjs}"],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ["apps/**/*.{ts,tsx}", "packages/ui/**/*.{ts,tsx}", "packages/storage/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser, ...globals.worker } },
  },
  {
    files: ["packages/**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}", "**/*.bench.ts"],
    rules: { "@typescript-eslint/no-non-null-assertion": "error" },
  },
  // Scopes (order matters: later blocks override earlier ones for the same rule).
  { files: STORAGE, rules: { "no-restricted-imports": restrictedImports({ allowSqlite: true }) } },
  { files: NODE_SQLITE_DRIVER, rules: { "no-restricted-imports": restrictedImports({ allowSqlite: true, allowNodeSqlite: true }) } },
  { files: UI_CODE, rules: { "no-restricted-syntax": restrictedSyntax({ ui: true }) } },
  { files: LAZY_LOADERS, rules: { "no-restricted-syntax": restrictedSyntax({ allowDynamicImport: true, ui: true }) } },
  { files: COLOUR_EXEMPT, rules: { "no-restricted-syntax": restrictedSyntax({ allowColours: true }) } },
  {
    files: DETERMINISTIC,
    // Tests may use wall clocks and native Math (e.g. to compare detmath against it); they are not part of a run.
    ignores: ["**/*.test.ts", "**/*.bench.ts"],
    rules: {
      "no-restricted-imports": restrictedImports({ deterministic: true }),
      "no-restricted-syntax": restrictedSyntax({ deterministic: true }),
      "no-restricted-globals": restrictedGlobals({ deterministic: true }),
      "no-restricted-properties": ["error", ...deterministicProperties],
    },
  },
  {
    files: VALIDATION_WRAPPER,
    ignores: ["**/*.test.ts"],
    rules: { "no-restricted-imports": restrictedImports({ deterministic: true, allowValidator: true }) },
  },
);

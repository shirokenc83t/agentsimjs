import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

// Lints snippets under virtual paths so the scoped rules of eslint.config.js apply (ADR-0021).
const eslint = new ESLint({ cwd: process.cwd() });

async function ruleIds(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map((m) => m.ruleId ?? `fatal:${m.message}`);
}

const CORE = "packages/core/src/probe.ts";
const APP = "apps/lab/src/probe.ts";
const STORAGE = "packages/storage/src/probe.ts";

describe("restricted APIs (lint)", () => {
  // The first lint loads the config and the TypeScript parser (several seconds under full-suite load);
  // pay it here, not inside the first case's 5 s timeout.
  beforeAll(async () => {
    await ruleIds("export {};\n", CORE);
  }, 60_000);

  it.each([
    ["export const x = () => Math.random();", "no-restricted-properties"],
    ["export const x = () => Date.now();", "no-restricted-properties"],
    ["export const x = () => performance.now();", "no-restricted-globals"],
    ["export const x = () => crypto.randomUUID();", "no-restricted-properties"],
    ["export const x = () => new Date();", "no-restricted-syntax"],
    ["export const x = () => setTimeout(() => {}, 1);", "no-restricted-globals"],
    ["export const x = () => document.title;", "no-restricted-globals"],
    ["import { REVISION } from 'three';\nexport { REVISION };", "no-restricted-imports"],
  ])("deterministic packages reject: %s", async (code, rule) => {
    expect(await ruleIds(`${code}\n`, CORE)).toContain(rule);
  });

  it.each([
    ["export const x = (a: number) => Math.sin(a);", "no-restricted-properties"],
    ["export const x = (a: number) => Math.atan2(a, 1);", "no-restricted-properties"],
    ["export const x = (a: number) => Math.exp(a) + Math.log(a);", "no-restricted-properties"],
    ["export const x = (a: number) => Math.pow(a, 2);", "no-restricted-properties"],
    ["export const x = (a: number) => a ** 2;", "no-restricted-syntax"],
    ["export const x = (a: number) => { a **= 2; return a; };", "no-restricted-syntax"],
  ])("deterministic packages reject engine-approximated math: %s (ADR-0023)", async (code, rule) => {
    expect(await ruleIds(`${code}\n`, "packages/spatial/src/probe.ts")).toContain(rule);
  });

  it("allows exact Math functions and detmath in deterministic packages, and native Math in their tests", async () => {
    expect(await ruleIds("export const x = (a: number) => Math.sqrt(Math.abs(a)) + Math.floor(a) + Math.imul(a, 3);\n", CORE)).toEqual([]);
    expect(await ruleIds("export const x = (a: number) => Math.sin(a);\n", "packages/core/src/probe.test.ts")).toEqual([]);
  });

  // ADR-0018 addition (2026-10-08): the lab main thread initializes TypeBox lazily inside validate(), so the
  // checker must not be reachable any other way, or something could validate before initValidation().
  it.each([
    ["import { Check } from 'typebox/value';\nexport const x = Check;", APP],
    ["import { Value } from 'typebox/value';\nexport const x = Value;", "packages/ui/src/probe.tsx"],
    ["import { Settings } from 'typebox/system';\nexport const x = Settings;", APP],
    ["import { Schema } from 'typebox/schema';\nexport const x = Schema;", "packages/scenarios/src/probe.ts"],
    ["import { Check } from 'typebox/value';\nexport const x = Check;", "packages/core/src/probe.ts"],
    ["import { Compile } from 'typebox/compile';\nexport const x = Compile;", "packages/core/src/contracts/probe.ts"],
  ])("TypeBox validation is reachable only through the core wrapper: %s in %s", async (code, file) => {
    expect(await ruleIds(`${code}\n`, file)).toContain("no-restricted-imports");
  });

  it("the core validation wrapper may use the checker; schemas may be built anywhere", async () => {
    expect(await ruleIds("import { Check } from 'typebox/value';\nexport const x = Check;\n", "packages/core/src/contracts/probe.ts")).toEqual([]);
    expect(await ruleIds("import Type from 'typebox';\nexport const S = Type.Object({});\n", APP)).toEqual([]);
  });

  it.each([
    ["eval('1')", "no-eval"],
    ["new Function('return 1')", "no-new-func"],
    ["new SharedArrayBuffer(8)", "no-restricted-globals"],
    ["import('./x')", "no-restricted-syntax"],
  ])("everywhere rejects %s", async (code, rule) => {
    expect(await ruleIds(`export const x = () => ${code};\n`, APP)).toContain(rule);
  });

  it.each([
    "import Compile from 'typebox/compile';",
    "import { Type } from '@sinclair/typebox';",
    "import Ajv from 'ajv';",
    "import init from '@sqlite.org/sqlite-wasm';",
    "import { DatabaseSync } from 'node:sqlite';",
  ])("apps reject %s", async (code) => {
    expect(await ruleIds(`${code}\n`, APP)).toContain("no-restricted-imports");
  });

  it("storage may import sqlite-wasm but not node:sqlite outside its driver", async () => {
    expect(await ruleIds("import init from '@sqlite.org/sqlite-wasm';\nexport { init };\n", STORAGE)).not.toContain("no-restricted-imports");
    expect(await ruleIds("import { DatabaseSync } from 'node:sqlite';\nexport { DatabaseSync };\n", STORAGE)).toContain("no-restricted-imports");
    expect(
      await ruleIds("import { DatabaseSync } from 'node:sqlite';\nexport { DatabaseSync };\n", "packages/storage/src/drivers/node-sql-driver.ts"),
    ).not.toContain("no-restricted-imports");
  });

  it("allows wall-clock APIs outside deterministic packages", async () => {
    expect(await ruleIds("export const t = () => performance.now() + Date.now();\n", APP)).toEqual([]);
  });

  it("allows dynamic import only in the lazy-loading registry", async () => {
    expect(await ruleIds("export const x = () => import('./x');\n", "apps/lab/src/workspaces/registry.tsx")).toEqual([]);
  });
});

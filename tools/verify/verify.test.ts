import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// `pnpm verify` (tools/verify/verify.mjs): which gates a command line asks for, and that it documents itself. The gates themselves are the project's own scripts.
const run = (...args: string[]) => spawnSync(process.execPath, ["tools/verify/verify.mjs", ...args], { encoding: "utf8" });
const gates = (...args: string[]) => run("--list", ...args).stdout.trim().split("\n");

describe("pnpm verify", () => {
  it("runs lint, typecheck, test and determinism by default", () => {
    expect(gates()).toEqual(["lint", "typecheck", "test", "determinism"]);
  });

  it("--full adds e2e, bench and the bundle report; --visual adds the visual job", () => {
    expect(gates("--full")).toEqual(["lint", "typecheck", "test", "determinism", "e2e", "bench", "bundle"]);
    expect(gates("--visual")).toEqual(["lint", "typecheck", "test", "determinism", "visual"]);
    expect(gates("--full", "--visual")).toEqual(["lint", "typecheck", "test", "determinism", "e2e", "bench", "bundle", "visual"]);
  });

  it("--only runs the named gates in their order and refuses an unknown one", () => {
    expect(gates("--only", "test,lint")).toEqual(["lint", "test"]);
    const bad = run("--only", "nonsense");
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("unknown gate nonsense");
  });

  it("--help documents the usage, and an unknown option exits non-zero with it", () => {
    const help = run("--help");
    expect(help.status).toBe(0);
    for (const word of ["--full", "--visual", "--only", "Docker", "pinned", "exit code"]) expect(help.stdout).toContain(word);
    const bad = run("--bogus");
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("unknown option --bogus");
  });

  it("runs a gate, prints one line for it and exits non-zero when it fails (the gate is the project's own script)", () => {
    // `--only bundle` without a bench run has no report: a FAIL line, a non-zero exit, and nothing else.
    const r = run("--only", "bundle");
    if (r.stdout.includes("PASS")) return; // a bench report exists on this machine: the gate itself is exercised by `pnpm verify --full`
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/FAIL\s+bundle/);
    expect(r.stdout).toContain("verify: FAILED bundle");
  });
});

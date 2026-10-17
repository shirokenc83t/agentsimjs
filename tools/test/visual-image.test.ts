import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Workflow guards (ADR-0032 §9, 2026-10-08): the visual baselines are generated and checked on the Playwright
// image matching @playwright/test, and every third-party action is pinned to a full commit SHA.
const WORKFLOWS = ".github/workflows";
const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));
const text = (f: string) => readFileSync(join(WORKFLOWS, f), "utf8");
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { devDependencies?: Record<string, string> };
const playwrightVersion = pkg.devDependencies?.["@playwright/test"];

/** `uses:` references, with their line, skipping commented-out lines. */
function usesOf(src: string): { ref: string; line: string }[] {
  return src
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))
    .flatMap((line) => {
      const m = /^\s*(?:-\s+)?uses:\s*(\S+)/.exec(line);
      return m?.[1] ? [{ ref: m[1], line: line.trim() }] : [];
    });
}

/** `image: <name>@sha256:<64 hex> # <tag>`: the digest is what runs, the comment says which tag it was. */
const IMAGE_PIN = /^\s*image:\s*[\w./-]+@sha256:([0-9a-f]{64})\s+#\s*(\S+)\s*$/;

function imagesOf(src: string): { digest: string; tag: string }[] {
  return src.split(/\r?\n/).flatMap((l) => {
    const m = IMAGE_PIN.exec(l);
    return m?.[1] && m[2] ? [{ digest: m[1], tag: m[2] }] : [];
  });
}

describe("GitHub workflows", () => {
  it("pin @playwright/test exactly; both visual jobs use one digest-pinned image whose tag comment matches it", () => {
    expect(playwrightVersion).toMatch(/^\d+\.\d+\.\d+$/);
    const digests = ["update-visual-baselines.yml", "ci.yml"].map((f) => {
      const images = imagesOf(text(f));
      expect(images.length, f).toBe(1);
      const img = images[0];
      expect(img?.tag, `${f}: tag comment`).toBe(`v${playwrightVersion}-noble`);
      return img?.digest;
    });
    expect(new Set(digests).size).toBe(1);
  });

  it.each(files)("%s: every container image is pinned by sha256 digest with its tag in a comment", (f) => {
    for (const line of text(f).split(/\r?\n/).filter((l) => /^\s*image:/.test(l))) expect(line, `${f}: ${line}`).toMatch(IMAGE_PIN);
  });

  it("the image check rejects tags and short or missing digests", () => {
    for (const bad of [
      "      image: mcr.microsoft.com/playwright:v1.63.0-noble",
      "      image: mcr.microsoft.com/playwright@sha256:eff16c30 # v1.63.0-noble",
      "      image: mcr.microsoft.com/playwright@sha256:" + "a".repeat(64),
    ])
      expect(bad).not.toMatch(IMAGE_PIN);
  });

  it.each(files)("%s: every third-party action is pinned to a full commit SHA with its version in a comment", (f) => {
    const uses = usesOf(text(f));
    expect(uses.length).toBeGreaterThan(0);
    for (const { ref, line } of uses) {
      if (ref.startsWith("./") || ref.startsWith("docker://")) continue;
      expect(line, `${f}: ${line}`).toMatch(/^(?:-\s+)?uses:\s*[\w.-]+\/[\w./-]+@[0-9a-f]{40}\s+#\s*v\d+(?:\.\d+){0,2}\s*$/);
    }
  });

  it("the pin check rejects tags, short SHAs and missing version comments", () => {
    const bad = ["uses: actions/checkout@v5", "uses: actions/checkout@fbc6f39", "uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09"];
    for (const l of bad) expect(l).not.toMatch(/^(?:-\s+)?uses:\s*[\w.-]+\/[\w./-]+@[0-9a-f]{40}\s+#\s*v\d+(?:\.\d+){0,2}\s*$/);
    expect(usesOf("      # - uses: actions/checkout@v5\n      - uses: a/b@" + "0".repeat(40) + " # v1")).toHaveLength(1);
  });
});

// Public-repository guards (the repository is public: workflows run code from pull requests, so what they may do is pinned).
const code = (src: string) => src.split(/\r?\n/).filter((l) => !/^\s*#/.test(l));

describe("GitHub workflows in a public repository", () => {
  it.each(files)("%s: no pull_request_target, no workflow_run, no self-hosted runner", (f) => {
    for (const line of code(text(f))) {
      expect(line, `${f}: ${line}`).not.toMatch(/^\s*pull_request_target\s*:/);
      expect(line, `${f}: ${line}`).not.toMatch(/^\s*workflow_run\s*:/);
      expect(line, `${f}: ${line}`).not.toMatch(/self-hosted/);
      if (/^\s*runs-on\s*:/.test(line)) expect(line, `${f}: ${line}`).toMatch(/runs-on:\s*ubuntu-[\w.-]+\s*$/);
    }
  });

  it.each(files)("%s: a top-level permissions block that grants nothing beyond reading", (f) => {
    const lines = code(text(f));
    const at = lines.findIndex((l) => /^permissions\s*:/.test(l));
    expect(at, `${f}: no top-level permissions`).toBeGreaterThanOrEqual(0);
    const top = lines[at] ?? "";
    // Either `permissions: {}` or an indented block of `read` entries.
    if (/^permissions\s*:\s*\{\s*\}\s*$/.test(top)) return;
    for (const l of lines.slice(at + 1)) {
      if (/^\S/.test(l)) break;
      if (l.trim() !== "") expect(l, `${f}: top-level permission`).toMatch(/^\s+[\w-]+:\s*read\s*$/);
    }
  });

  it("write permissions exist only at job level in update-visual-baselines.yml, and its job is owner-only", () => {
    for (const f of files) {
      const writes = code(text(f)).filter((l) => /:\s*write\s*$/.test(l));
      if (f === "update-visual-baselines.yml") {
        expect(writes.map((l) => l.trim()).sort(), f).toEqual(["contents: write", "pull-requests: write"]);
        for (const l of writes) expect(l, `${f}: write permission must be job-level`).toMatch(/^ {6}\S/);
        expect(text(f)).toMatch(/\n {4}if: github\.actor == github\.repository_owner\n/);
      } else expect(writes, f).toEqual([]);
    }
  });

  it("the guards reject what they are meant to reject", () => {
    expect("  pull_request_target:").toMatch(/^\s*pull_request_target\s*:/);
    expect("    runs-on: [self-hosted, linux]").toMatch(/self-hosted/);
    expect("      contents: write").toMatch(/:\s*write\s*$/);
    expect("      contents: read").not.toMatch(/:\s*write\s*$/);
  });
});

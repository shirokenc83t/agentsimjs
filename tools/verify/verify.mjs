// `pnpm verify`: the gates of CI, run locally, one summary line per gate. Usage: see HELP below (`pnpm verify --help`).
// No dependency: Node's own child_process. The output of each gate goes to node_modules/.cache/verify/<gate>.log; the tail of a failing gate is printed.
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const HELP = `pnpm verify [--full] [--visual] [--only gate,gate] [--list] [--help]

Runs the gates CI runs, locally, and prints one line per gate with PASS, FAIL or SKIP and the time it took. The exit code is non-zero if any gate failed.

  (default)   lint, typecheck, test (pnpm test), determinism (pnpm test:determinism)
  --full      also e2e (pnpm test:e2e), bench (pnpm bench: every threshold, with the bundle build) and bundle (the initial chunk against its threshold)
  --visual    also the visual job, only if Docker is available and the pinned Playwright image of .github/workflows/ci.yml is already pulled;
              otherwise it says it is skipped and why (baselines come from the workflow update-visual-baselines, never from a dev machine)
  --only      run only the named gates, in their order (lint, typecheck, test, determinism, e2e, bench, bundle, visual)
  --list      print the gates that would run and exit
  --help      this text

Each gate writes its output to node_modules/.cache/verify/<gate>.log; the last lines of a failing gate are printed. Every gate runs even if an earlier one failed.
Run it before every push, with --full when the change touches the UI, the e2e specs or a hot path.`;

const GATES = [
  { name: "lint", full: false, cmd: ["pnpm", "lint"] },
  { name: "typecheck", full: false, cmd: ["pnpm", "typecheck"] },
  { name: "test", full: false, cmd: ["pnpm", "test"] },
  { name: "determinism", full: false, cmd: ["pnpm", "test:determinism"] },
  { name: "e2e", full: true, cmd: ["pnpm", "test:e2e"] },
  { name: "bench", full: true, cmd: ["pnpm", "bench"] },
  { name: "bundle", full: true, run: bundleGate },
  { name: "visual", visual: true, run: visualGate },
];

/** The gates a command line asks for, in order. Throws on an unknown option or gate. */
export function plan(argv) {
  const known = new Set(["--full", "--visual", "--only", "--list", "--help"]);
  const args = [...argv];
  let only;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--only") {
      const v = args[i + 1];
      if (!v) throw new Error("--only needs a list of gates");
      only = v.split(",");
      args.splice(i + 1, 1);
    } else if (a?.startsWith("--only=")) only = a.slice(7).split(",");
    else if (!known.has(a ?? "")) throw new Error(`unknown option ${a}`);
  }
  if (only) {
    for (const g of only) if (!GATES.some((x) => x.name === g)) throw new Error(`unknown gate ${g}`);
    return GATES.filter((g) => only.includes(g.name));
  }
  const full = args.includes("--full");
  const visual = args.includes("--visual");
  return GATES.filter((g) => (g.visual ? visual : g.full ? full : true));
}

/** The pinned Playwright image of the visual job, from ci.yml (`image: mcr.microsoft.com/playwright@sha256:... # vX`). */
function pinnedImage() {
  const m = /image:\s*(mcr\.microsoft\.com\/playwright@sha256:[0-9a-f]+)/.exec(readFileSync(".github/workflows/ci.yml", "utf8"));
  return m?.[1];
}

async function bundleGate(log) {
  const f = join("bench", "results", "bundle.json");
  if (!existsSync(f)) return { ok: false, note: "no bench/results/bundle.json: run the bench gate first" };
  const bundle = JSON.parse(readFileSync(f, "utf8"));
  const p95 = bundle["bundle.initial.gzip"]?.p95;
  const limit = JSON.parse(readFileSync(join("bench", "thresholds.json"), "utf8")).metrics?.["bundle.initial.gzip"]?.max;
  const line = `initial chunk ${p95 === undefined ? "?" : `${p95} B gzip`}${limit === undefined ? "" : ` (threshold ${limit})`}`;
  log.write(line + "\n");
  return { ok: p95 !== undefined && (limit === undefined || p95 <= limit), note: line };
}

async function visualGate(log) {
  const docker = spawnSync("docker", ["--version"], { encoding: "utf8", shell: true });
  if (docker.status !== 0) return { skip: true, note: "Docker is not available" };
  const image = pinnedImage();
  if (!image) return { skip: true, note: "no pinned image found in .github/workflows/ci.yml" };
  const have = spawnSync("docker", ["image", "inspect", image], { encoding: "utf8", shell: true });
  if (have.status !== 0) return { skip: true, note: `the pinned image is not pulled (docker pull ${image})` };
  const cwd = process.cwd();
  const r = await runCommand("docker", ["run", "--rm", "-e", "AGENTSIM_VISUAL_IMAGE=1", "-v", `${cwd}:/work`, "-w", "/work", image, "sh", "-c", "corepack enable && pnpm install --frozen-lockfile && pnpm test:visual"], log);
  return { ok: r === 0 };
}

function runCommand(cmd, args, log) {
  return new Promise((resolve) => {
    // One command string for the shell (pnpm is a .cmd on Windows): arguments are our own constants and the working directory, never user input.
    const child = spawn([cmd, ...args.map((x) => (/\s/.test(x) ? `"${x}"` : x))].join(" "), { shell: true, env: process.env });
    child.stdout.on("data", (d) => log.write(d));
    child.stderr.on("data", (d) => log.write(d));
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) {
    console.log(HELP);
    return 0;
  }
  let gates;
  try {
    gates = plan(argv);
  } catch (e) {
    console.error(`${e.message}\n\n${HELP}`);
    return 2;
  }
  if (argv.includes("--list")) {
    console.log(gates.map((g) => g.name).join("\n"));
    return 0;
  }
  const dir = join("node_modules", ".cache", "verify");
  mkdirSync(dir, { recursive: true });
  const results = [];
  for (const g of gates) {
    const file = join(dir, `${g.name}.log`);
    const log = createWriteStream(file);
    const t0 = Date.now();
    process.stdout.write(`… ${g.name}\r`);
    let r;
    if (g.run) r = await g.run(log);
    else r = { ok: (await runCommand(g.cmd[0], g.cmd.slice(1), log)) === 0 };
    await new Promise((resolve) => log.end(resolve));
    const ms = Date.now() - t0;
    const status = r.skip ? "SKIP" : r.ok ? "PASS" : "FAIL";
    results.push({ name: g.name, status });
    console.log(`${status.padEnd(4)}  ${g.name.padEnd(12)} ${seconds(ms).padStart(8)}${r.note ? `  ${r.note}` : ""}${status === "FAIL" ? `  (log: ${file})` : ""}`);
    if (status === "FAIL") {
      const tail = readFileSync(file, "utf8").trimEnd().split("\n").slice(-15).join("\n");
      console.log(tail.split("\n").map((l) => `      ${l}`).join("\n"));
    }
  }
  const failed = results.filter((r) => r.status === "FAIL");
  console.log(failed.length === 0 ? `verify: ${results.filter((r) => r.status === "PASS").length} gates passed${results.some((r) => r.status === "SKIP") ? ", some skipped" : ""}` : `verify: FAILED ${failed.map((r) => r.name).join(", ")}`);
  return failed.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await main());

// Compares bench/results/*.json with bench/thresholds.json (ADR-0013, ADR-0021, ADR-0022, ADR-0030).
// Fails (exit 1) when a metric exceeds its threshold; "report" metrics are printed only.
// With CI set (1/true), entries' ciStat/ciMax replace stat/max (ADR-0030: shared-runner CPU budgets).
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { cpus, platform, release, totalmem } from "node:os";
import { resolve } from "node:path";
import { evaluate, limitsOf } from "./gates.mjs";

const gpu = process.argv.includes("--gpu");
const ci = ["1", "true"].includes((process.env.CI ?? "").toLowerCase());
const thresholds = JSON.parse(readFileSync(resolve("bench/thresholds.json"), "utf8"));
if (gpu) Object.assign(thresholds.metrics, JSON.parse(readFileSync(resolve("bench/thresholds.gpu.json"), "utf8")).metrics);
const results = {};
let renderer;
const dir = resolve("bench/results");
if (existsSync(dir)) {
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    for (const [k, v] of Object.entries(JSON.parse(readFileSync(resolve(dir, f), "utf8")))) {
      if (k === "_renderer") renderer = v;
      else if (!k.startsWith("_")) results[k] = v;
    }
  }
}

const fmt = (v, unit) =>
  v === undefined ? "—" : unit === "bytes" ? `${(v / 1024).toFixed(1)} KB` : unit === "count" ? `${Math.round(v)}` : `${v.toFixed(2)} ms`;
/** The limits of a row in this mode, as the table says them (`median ≤ 8.00 ms · p95 ≤ 12.00 ms`). */
const words = (t, unit) => limitsOf(t, ci).map((l) => `${l.stat} ≤ ${fmt(l.max, unit)}`).join(" · ");
const rows = [];
let failed = false;
for (const [name, t] of Object.entries(thresholds.metrics)) {
  const m = results[name];
  if (!m) {
    rows.push([name, "—", "—", "—", t.report ? "report" : limitsOf(t, ci).map((l) => `${l.stat} ≤ ${l.max}`).join(" · "), t.required === false ? "skipped" : "MISSING"]);
    if (t.required !== false) failed = true;
    continue;
  }
  const { ok, failures } = evaluate(t, m, ci);
  if (!ok) failed = true;
  const result = ok ? "ok" : failures.every((l) => typeof m[l.stat] === "number") ? `FAIL ${failures.map((l) => l.stat).join(", ")}` : `MISSING ${failures.map((l) => l.stat).join(", ")}`;
  rows.push([name, fmt(m.mean, m.unit), fmt(m.median, m.unit), fmt(m.p95, m.unit), t.report ? "report only" : words(t, m.unit), result]);
}

const header = ["metric", "mean", "median", "p95", "threshold", "result"];
const table = [header, header.map(() => "---"), ...rows].map((r) => `| ${r.join(" | ")} |`).join("\n");
console.log(table);
const gl = gpu ? "hardware GPU" : "software GL";
const cpuMode = ci ? "CI: ciStat/ciMax where set (ADR-0030)" : "local: real budgets (ADR-0030)";
const mode = `${gl} (ADR-0022) · CPU ${cpuMode}`;
const machine = `${cpus()[0]?.model.trim() ?? "unknown CPU"} (${cpus().length} threads), ${(totalmem() / 2 ** 30).toFixed(0)} GB RAM, ${platform()} ${release()}, Node ${process.version}`;
console.log(`\nmode: ${mode} · WebGL: ${renderer ?? "n/a"}`);
console.log(`machine: ${machine}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Benchmarks — ${mode}\n\n${table}\n\nWebGL renderer: ${renderer ?? "n/a"}\n\nMachine: ${machine}\n`);
}
if (failed) {
  console.error("\nBenchmark thresholds exceeded or results missing.");
  process.exit(1);
}

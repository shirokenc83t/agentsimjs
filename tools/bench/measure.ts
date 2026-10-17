import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** One benchmark metric as stored in bench/results/*.json (ADR-0021). */
export interface Metric {
  readonly mean: number;
  readonly median: number;
  readonly p95: number;
  readonly unit: "ms" | "bytes" | "count";
  readonly samples: number;
}

export const RESULTS_DIR = resolve(process.cwd(), "bench/results");

export function summarize(samples: readonly number[], unit: Metric["unit"] = "ms"): Metric {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length);
  const p95 = sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.95 * sorted.length) - 1))] ?? 0;
  const mid = sorted.length >> 1;
  const median = sorted.length === 0 ? 0 : sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  return { mean, median, p95, unit, samples: sorted.length };
}

/** Times `fn` (after warmup) and returns mean/p95 in ms. `setup` runs untimed before each iteration. */
export function measure<S>(opts: { iterations: number; warmup?: number; setup: () => S; run: (s: S) => void; teardown?: (s: S) => void }): Metric {
  const samples: number[] = [];
  for (let i = 0; i < (opts.warmup ?? 2) + opts.iterations; i++) {
    const s = opts.setup();
    const t0 = performance.now();
    opts.run(s);
    const dt = performance.now() - t0;
    opts.teardown?.(s);
    if (i >= (opts.warmup ?? 2)) samples.push(dt);
  }
  return summarize(samples);
}

/** Merges metrics into a results file (several bench files may write to the same one). */
export function recordResults(file: string, metrics: Record<string, Metric>): void {
  const path = resolve(RESULTS_DIR, file);
  mkdirSync(dirname(path), { recursive: true });
  const prev = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, Metric>) : {};
  writeFileSync(path, JSON.stringify({ ...prev, ...metrics }, null, 2) + "\n");
}

/** Records the WebGL renderer the browser benches ran on (ADR-0022). */
export function recordRenderer(renderer: string): void {
  const path = resolve(RESULTS_DIR, "browser.json");
  mkdirSync(RESULTS_DIR, { recursive: true });
  const prev = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : {};
  writeFileSync(path, JSON.stringify({ ...prev, _renderer: renderer }, null, 2) + "\n");
}

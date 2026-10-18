// Measures the lab app bundle from the production build (ADR-0021, ADR-0032 §3–§4). Writes bench/results/bundle.json:
// - bundle.initial.*: entry script, statically preloaded modules, CSS and preloaded fonts (what first paint needs);
// - bundle.fonts.gzip: every self-hosted font file (report only; counted in the initial chunk only if preloaded);
// - bundle.lazy.<group>.gzip: lazy chunks per workspace group, so deferred weight stays visible (report only).
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const dist = resolve("apps/lab/dist");
const html = readFileSync(join(dist, "index.html"), "utf8");
const refs = [...html.matchAll(/(?:src|href)="\/?(assets\/[^"]+\.(?:js|css|woff2))"/g)].map((m) => m[1]);
if (refs.length === 0) throw new Error("no initial assets found in dist/index.html");

const gzipOf = (rel) => {
  const buf = readFileSync(join(dist, rel));
  return { raw: buf.length, gzip: gzipSync(buf, { level: 9 }).length };
};
const sum = (list) => list.reduce((a, s) => ({ raw: a.raw + s.raw, gzip: a.gzip + s.gzip }), { raw: 0, gzip: 0 });
/** Chunk name without its content hash: `scene-panel-1HpJdbKI.js` → `scene-panel`. */
const baseName = (f) => f.replace(/^assets\//, "").replace(/-[A-Za-z0-9_-]{8}\.(js|css|woff2?)$/, "");

const initialFiles = {};
for (const ref of [...new Set(refs)]) initialFiles[ref] = gzipOf(ref);
const initial = sum(Object.values(initialFiles));

// Contract schemas (TypeBox objects) never belong in the initial chunk (ADR-0018 addition of 2026-10-12): the shell takes the
// protocol's constants and types only, so each worker-message schema added in later phases costs nothing at first paint.
// A schema in an initial file shows as its JSON Schema keywords; fail the build report rather than let it creep in.
for (const ref of Object.keys(initialFiles)) {
  if (/\.js$/.test(ref) && readFileSync(join(dist, ref), "utf8").includes("additionalProperties")) {
    throw new Error(`${ref} (initial) contains contract schemas: import message schemas only from lazily loaded code (ADR-0018 addition of 2026-10-12)`);
  }
}

const assets = readdirSync(join(dist, "assets")).map((f) => `assets/${f}`);
const fonts = sum(assets.filter((f) => /\.(woff2?|ttf|otf)$/.test(f)).map(gzipOf));

// Lazy workspace groups: the deferred dockview workspace and each lazy panel. Workers are not counted.
const LAZY_GROUPS = {
  workspace: (n) => n === "workspace-host" || n.startsWith("vendor-dockview"),
  // three.js sits in its own chunk since the scenario editor shares it with the Scene (F1 e7).
  scene: (n) => n === "scene-panel" || n.startsWith("vendor-three"),
  storage: (n) => n === "storage-panel",
  settings: (n) => n === "settings-panel",
  // F1 phase close: the Author workspace panels and the run controller (presets are built in the sim worker).
  editor: (n) => n === "scenario-editor-panel",
  runConfig: (n) => n === "run-config-panel",
  runController: (n) => n === "run-controller",
  // F2 M2e: the Inspector and Explorer panels with their streams, the palette's agent commands, the run popover, and the
  // chunks the lazy panels share (MUI controls; the contracts and the scenario code behind the editor and run configuration).
  inspector: (n) => n === "inspector-panel" || n === "use-agent-views" || n === "use-sim-stream",
  explorer: (n) => n === "explorer-panel",
  commands: (n) => n === "commands",
  runInfo: (n) => n === "run-info",
  // F3a M2: the recording status in the status line and the recording choice in the run popover (report only).
  recording: (n) => n === "recording-status" || n === "recording-controls" || n === "recording-choice",
  sharedMui: (n) => ["TextField", "ToggleButtonGroup", "Popover", "FormControlLabel"].includes(n),
  sharedContracts: (n) => n === "dist" || n === "model",
};
const lazy = {};
for (const [group, match] of Object.entries(LAZY_GROUPS)) {
  const files = assets.filter((f) => /\.(js|css)$/.test(f) && !initialFiles[f] && match(baseName(f)));
  lazy[group] = { ...sum(files.map(gzipOf)), files };
}

// Workers are separate bundles, reported on their own (never part of first paint).
const workers = Object.fromEntries(assets.filter((f) => /^assets\/(sim|storage)\.worker-.*\.js$/.test(f)).map((f) => [baseName(f), gzipOf(f)]));

const out = resolve("bench/results/bundle.json");
mkdirSync(resolve("bench/results"), { recursive: true });
const prev = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : {};
const metric = (bytes) => ({ mean: bytes, p95: bytes, unit: "bytes", samples: 1 });
writeFileSync(
  out,
  JSON.stringify(
    {
      ...prev,
      "bundle.initial.raw": metric(initial.raw),
      "bundle.initial.gzip": metric(initial.gzip),
      "bundle.fonts.gzip": metric(fonts.gzip),
      ...Object.fromEntries(Object.entries(lazy).map(([g, s]) => [`bundle.lazy.${g}.gzip`, metric(s.gzip)])),
      ...Object.fromEntries(Object.entries(workers).map(([w, s]) => [`bundle.worker.${w.replace(".worker", "")}.gzip`, metric(s.gzip)])),
      _files: initialFiles,
      _lazy: lazy,
    },
    null,
    2,
  ) + "\n",
);
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log(`initial chunk: ${kb(initial.raw)} raw, ${kb(initial.gzip)} gzip (${Object.keys(initialFiles).length} files)`);
console.log(`fonts: ${kb(fonts.gzip)} gzip · lazy: ${Object.entries(lazy).map(([g, s]) => `${g} ${kb(s.gzip)}`).join(", ")}`);
console.log(`workers: ${Object.entries(workers).map(([w, s]) => `${w} ${kb(s.gzip)}`).join(", ")}`);

if (process.env.GITHUB_STEP_SUMMARY) {
  const lines = [
    "## Bundle report — initial chunk",
    "",
    "| file | raw | gzip |",
    "| --- | --- | --- |",
    ...Object.entries(initialFiles).map(([f, s]) => `| ${f} | ${kb(s.raw)} | ${kb(s.gzip)} |`),
    `| **total** | **${kb(initial.raw)}** | **${kb(initial.gzip)}** |`,
    "",
    "| lazy group | gzip |",
    "| --- | --- |",
    ...Object.entries(lazy).map(([g, s]) => `| ${g} | ${kb(s.gzip)} |`),
    ...Object.entries(workers).map(([w, s]) => `| worker ${w} | ${kb(s.gzip)} |`),
    `| fonts (all files) | ${kb(fonts.gzip)} |`,
    "",
  ];
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
}

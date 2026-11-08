import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { simulatorVersion } from "./simulator-version.ts";

// Strict CSP (ADR-0018, ADR-0021): never 'unsafe-eval'; 'wasm-unsafe-eval' is required by sqlite-wasm.
// The dev server injects a few inline module scripts (React refresh), allowed via a dev-only nonce.
const DEV_NONCE = "agentsim-dev";
/** Origins the server adds to `connect-src`: http(s) origins only, nothing that could carry another directive. */
function extraConnect(): string {
  const origins = (process.env["AGENTSIM_CONNECT_SRC"] ?? "").split(/\s+/).filter((o) => /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(o));
  return origins.length === 0 ? "" : ` ${origins.join(" ")}`;
}
const csp = (dev: boolean) =>
  [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval'${dev ? ` 'nonce-${DEV_NONCE}'` : ""}`,
    "worker-src 'self'",
    // The addresses the page may call (ADR-0044 section 4): itself, localhost and 127.0.0.1 on any port, and the addresses the person who serves it lists in AGENTSIM_CONNECT_SRC (origins, space separated). A page
    // cannot widen the policy it is served with, so Settings reads this one and says what it allows.
    `connect-src 'self' http://localhost:* http://127.0.0.1:*${dev ? " ws:" : ""}${extraConnect()}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");

/**
 * Preloads the UI regular face (ADR-0042 §2: JetBrains Mono regular): the only preloaded font, counted in the initial-chunk metric.
 * The hashed file name is known only after bundling, so the link is injected into index.html at build time.
 */
function preloadUiFont(): Plugin {
  return {
    name: "agentsim-preload-ui-font",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(_html, ctx) {
        const font = Object.values(ctx.bundle ?? {}).find((a) => /jetbrains-mono-latin-400-normal-[^/]*\.woff2$/.test(a.fileName));
        if (!font) throw new Error("UI regular font not found in the bundle");
        return [{ tag: "link", attrs: { rel: "preload", href: `/${font.fileName}`, as: "font", type: "font/woff2", crossorigin: "" }, injectTo: "head" }];
      },
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [react(), preloadUiFont()],
  // Recorded in every run header and export (ADR-0028).
  define: { __SIMULATOR_VERSION__: JSON.stringify(simulatorVersion()) },
  html: command === "serve" ? { cspNonce: DEV_NONCE } : {},
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
  worker: { format: "es" },
  build: {
    target: "es2022",
    sourcemap: true,
    reportCompressedSize: true,
    // The largest chunk is the Scene workspace (three.js, ~560 KB raw), lazy-loaded per workspace, never in
    // the initial chunk. Its gzip size is reported by `pnpm bench` (bundle.lazy.*) so growth stays visible.
    chunkSizeWarningLimit: 600,
    rolldownOptions: {
      output: {
        // Vendor chunks (issue #4): stable caching across app releases; sizes reported per chunk. MUI has no
        // group on purpose: a group would pull every MUI module into one chunk, the initial one, including
        // components used only by lazy panels. Left to the default splitting, shell components stay in the
        // initial chunk and panel-only ones travel with their panels (ADR-0032 §3 bundle gate).
        codeSplitting: {
          groups: [
            { name: "vendor-react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: "vendor-dockview", test: /node_modules[\\/]dockview/ },
            // three.js is shared by the Scene and the scenario editor (both lazy): a stable chunk name for the report.
            { name: "vendor-three", test: /node_modules[\\/]three[\\/]/ },
          ],
        },
      },
    },
  },
  server: { headers: { "Content-Security-Policy": csp(true) } },
  preview: { headers: { "Content-Security-Policy": csp(false) } },
}));

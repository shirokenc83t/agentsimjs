# AgentSimJS-NG

A browser-based lab for studying how teams of physical and virtual agents (aerial and ground vehicles, software agents) coordinate, and why they fail. The simulator provides bodies, sensors, a discretized world, safe base actions, reflexes, path planning and tracing, with deliberately simple kinematics: the agents' decision-making is what is studied, and it is meant to be plugged in from outside the simulator.

Everything runs in the browser (a Web Worker simulates, the main thread renders); there is no backend in this repository.

## Requirements

- Node.js 24 (see `.nvmrc`) and pnpm 12 (`corepack enable`)
- A Chromium-based browser to run the lab
- For the full test suite: Playwright browsers (`pnpm exec playwright install chromium firefox`) and Python 3.12 (one export check)
- Docker, optionally, for a local MQTT broker (`docker compose up -d`)

## Install, run, test

```
pnpm install
pnpm dev                # the lab app (Vite)
pnpm build
pnpm lint
pnpm typecheck
pnpm test               # unit, contract and browser tests (Vitest)
pnpm test:determinism   # long determinism runs
pnpm test:e2e           # end-to-end tests (Playwright, headless Chromium)
pnpm bench              # benchmarks, checked against bench/thresholds.json
```

## Status

- **F0, project foundations:** monorepo, simulation loop in a worker, local storage (SQLite WASM), UI shell and design system.
- **F1, spatial model, body, base actions and path planning:** chunked grids, vehicle kinematics, A\* and HPA\* planning with cost profiles, one agent without a mind.
- **F2, sensors, belief maps, discovery and events:** lidar and proximity sensing, per-agent belief maps, exploration, decision requests, researcher views.
- **F2b, planning strategies:** composable planners (selection, fallback, coarse-to-fine refinement, anytime), traced per query, with a sandbox to try them.
- **F3a, trace recorder and replay:** recording profiles, snapshots and belief frames written by a recorder channel between the workers, replay of a stored run in the panels, a storage browser.
- **F3b, observation and analysis:** a metrics channel, a filter language for the trace (log console with a live tail, trace tree, multi-log inspector, read-only SQL console), re-simulation of a window of a recorded run, headless runs with a monitor (as fast as lockstep allows, always recorded), and an Analysis workspace (trajectories, events, per-agent series, exports) next to a top-down 2D view of the Scene. The UI has a new chrome: numbered dockable panels, named layouts, light and dark themes.

## License

No license is granted at this time: all rights reserved. The source is published for reading only.

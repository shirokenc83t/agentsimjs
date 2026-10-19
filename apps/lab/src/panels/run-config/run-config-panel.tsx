import "../panels.css";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import FormControlLabel from "@mui/material/FormControlLabel";
import NativeSelect from "@mui/material/NativeSelect";
import TextField from "@mui/material/TextField";
import type { RunConfigSummary } from "@agentsim/storage";
import {
  parseRunConfig,
  parseRunConfigValue,
  type AlgorithmSpec,
  type BeliefsEntry,
  type DriveEntry,
  type EffectiveAgentConfig,
  type PlanningEntry,
  type RunConfigDocument,
  type RunConfigWarning,
  type ScenarioAgentsView,
} from "@agentsim/scenarios";
import { useCallback, useEffect, useMemo, useState, type InputHTMLAttributes } from "react";
import { useCurrentRun, useServices, useStorageStatus } from "../../services.tsx";
import type { LabRun } from "../../sim/run-controller.ts";
import { CostProfileForm } from "./cost-profile-form.tsx";
import { Issue, NumberField, OptionField } from "./fields.tsx";
import {
  driveScopes,
  getEntry,
  plannerKind,
  planningScopes,
  presetIdOf,
  rebasePreset,
  scopeFromId,
  scopeId,
  setEntry,
  validateDraft,
  withField,
  withPlanner,
  type Scope,
} from "./model.ts";
import { StrategyPicker } from "./strategy-picker.tsx";

const ALGORITHMS = ["dijkstra", "astar", "hpa", "weighted-astar"] as const;
type AlgorithmName = (typeof ALGORITHMS)[number];
const DRIVES = ["differential", "ackermann", "forward-only"] as const;
const YES_NO = ["yes", "no"] as const;

/** A belief initialization as the select's value: `unknown`, `ideal` or `prior:<id>`. */
const initValue = (i: BeliefsEntry["init"]): string | undefined => (i === undefined ? undefined : typeof i === "string" ? i : `prior:${i.prior}`);
const initFrom = (v: string | undefined): BeliefsEntry["init"] => (v === undefined ? undefined : v === "unknown" || v === "ideal" ? v : { prior: v.slice(6) });
/** Rows of the effective-configuration table; the Inspector shows every agent. */
const MAX_EFFECTIVE_ROWS = 64;

const algorithmName = (a: AlgorithmSpec | undefined): AlgorithmName | undefined => (a === undefined ? undefined : typeof a === "string" ? a : "weighted-astar");
const PLANNERS = ["algorithm", "strategy"] as const;
/** Warnings listed in the planning section; the rest are counted. */
const MAX_WARNINGS_SHOWN = 8;

/** What the table shows as an agent's planner: the algorithm, or `strategy:<id>@<version>` with its short content hash. */
function plannerLabel(p: EffectiveAgentConfig["planning"]): string {
  return p.strategy ? `strategy:${p.strategy.id}@${p.strategy.version}` : (algorithmName(p.algorithm) ?? "");
}

const scopeLabel = (s: Scope): string => (s.level === "default" ? "default (all agents)" : s.level === "byKind" ? `all ${s.kind.toUpperCase()}s` : `agent "${s.key}"`);

function profileSummary(p: EffectiveAgentConfig["planning"]["costProfile"]): string {
  const w = Object.entries(p.weights ?? {})
    .filter(([, v]) => v !== 0)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  const c = p.constraints?.length ?? 0;
  return c > 0 ? `${w}; ${c} constraint${c === 1 ? "" : "s"}` : w;
}

interface Loaded {
  readonly run: LabRun;
  readonly view: ScenarioAgentsView;
  readonly version: number;
  readonly initial: RunConfigDocument;
}

/**
 * The current run's agents (as the worker loaded them, with their authored bodies) and its run configuration.
 * The scenario document is never parsed here: the 1 km² world's 290 KiB stay off the main thread (F1 f1).
 */
function useLoaded(run: LabRun | undefined): Loaded | { error: string } | undefined {
  return useMemo(() => {
    if (!run) return undefined;
    const c = parseRunConfigValue(run.runConfig);
    if (!c.ok) return { error: `${c.error.code}: ${c.error.message}` };
    const l = run.loaded;
    const view: ScenarioAgentsView = {
      document: { id: l.scenarioId, defaultSeed: l.defaultSeed },
      agents: l.agents.map((a) => ({ id: a.id, ...(a.key === undefined ? {} : { key: a.key }), kind: a.kind, body: (a.body ?? {}) as ScenarioAgentsView["agents"][number]["body"] })),
      // The prior maps an agent may start from, with their content hashes: without them a run that starts an agent from a prior
      // (the 1 km² demo's rover) is reported `prior_not_found` and cannot be edited.
      ...(l.priorHashes === undefined ? {} : { priorHashes: l.priorHashes }),
    };
    return { run, view, version: l.scenarioVersion, initial: c.value };
  }, [run]);
}

/**
 * Run configuration panel (ADR-0028, UI-SPEC §4): seed, time mode, planning and drive entries per precedence
 * level, cost profiles, presets and a JSON view, all over one canonical document. Validation is the
 * simulator's own (schema + resolver), so what is accepted here is what the run will accept; both hashes are
 * shown live. "Run with this configuration" starts a new run of the current scenario version.
 */
export function RunConfigPanel() {
  const current = useCurrentRun();
  const loaded = useLoaded(current.run);
  if (!current.run || !loaded) {
    return (
      <div className="panel" data-testid="run-config-panel">
        <p className="muted">No scenario loaded. The run configuration applies to a loaded scenario version.</p>
        <Button variant="contained" onClick={() => !current.busy && current.loadDemo()} aria-disabled={current.busy}>
          Load F1 demo
        </Button>
      </div>
    );
  }
  if ("error" in loaded) {
    return (
      <div className="panel" data-testid="run-config-panel">
        <Issue code="invalid_document" message={loaded.error} testId="rc-load-error" />
      </div>
    );
  }
  return <RunConfigEditor key={loaded.run.header.runId} loaded={loaded} />;
}

function RunConfigEditor(props: { loaded: Loaded }) {
  const { view, version, run } = props.loaded;
  const current = useCurrentRun();
  const [draft, setDraft] = useState<RunConfigDocument>(props.loaded.initial);
  const [planningScope, setPlanningScope] = useState("default");
  const [driveScope, setDriveScope] = useState("default");
  const [beliefsScope, setBeliefsScope] = useState("default");
  const validation = useMemo(() => validateDraft(draft, view, version), [draft, view, version]);
  const sameAsRun = validation.ok && validation.resolved.runConfigHash === run.header.runConfigHash;

  const pScope = scopeFromId(planningScope);
  const pEntry = getEntry(draft, "planning", pScope);
  const setP = (e: PlanningEntry | undefined) => setDraft((d) => setEntry(d, "planning", pScope, e));
  const dScope = scopeFromId(driveScope);
  const dEntry = getEntry(draft, "drive", dScope);
  const setD = (e: DriveEntry | undefined) => setDraft((d) => setEntry(d, "drive", dScope, e));

  const bScope = scopeFromId(beliefsScope);
  const bEntry = getEntry(draft, "beliefs", bScope);
  const setB = (e: BeliefsEntry | undefined) => setDraft((d) => setEntry(d, "beliefs", bScope, e));
  const priorIds = props.loaded.run.loaded.priors ?? [];

  const kind = plannerKind(pEntry);
  // The resolver's error belongs next to the strategy editor when it points into a strategy of the document.
  const strategyIssue = !validation.ok && validation.error.path?.includes("/strategy") ? validation.error : undefined;
  const setPlanner = (k: (typeof PLANNERS)[number] | undefined) =>
    setP(k === "strategy" ? withPlanner(pEntry, { strategy: { ref: "astar-only", version: 1 } }) : withPlanner(pEntry, undefined));
  const alg = pEntry?.algorithm;
  const weighted = alg !== undefined && typeof alg !== "string" ? alg["weighted-astar"].weight : undefined;
  const setAlgorithm = (name: AlgorithmName | undefined) =>
    setP(withField(pEntry, "algorithm", name === undefined ? undefined : name === "weighted-astar" ? { "weighted-astar": { weight: weighted ?? 1.5 } } : name));

  return (
    <div className="panel run-config" data-testid="run-config-panel">
      <h3>
        Run configuration <span className="muted mono">{draft.scenario.id} v{draft.scenario.version}</span>
      </h3>

      <section>
        <h4>Run</h4>
        <div className="row">
          <NumberField
            label="seed"
            value={draft.seed}
            integer
            placeholder={`scenario default ${view.document.defaultSeed}`}
            onChange={(v) => setDraft((d) => withField(d, "seed", v))}
            testId="rc-seed"
          />
          <OptionField
            label="time mode"
            value={draft.timeMode}
            options={["lockstep", "realtime"] as const}
            inheritLabel="lockstep (default)"
            onChange={(v) => setDraft((d) => withField(d, "timeMode", v))}
            testId="rc-time-mode"
          />
        </div>
      </section>

      <section data-testid="rc-planning">
        <h4>Planning</h4>
        <ScopeSelect label="Planning level" value={planningScope} scopes={planningScopes(view)} onChange={setPlanningScope} testId="rc-planning-scope" entries={(s) => getEntry(draft, "planning", s) !== undefined} />
        <div className="row">
          <OptionField label="planner" value={kind === "inherit" ? undefined : kind} options={PLANNERS} inheritLabel="(inherit)" onChange={setPlanner} testId="rc-planner" />
          {kind !== "strategy" && <OptionField label="algorithm" value={algorithmName(alg)} options={ALGORITHMS} onChange={setAlgorithm} testId="rc-algorithm" />}
          {kind !== "strategy" && weighted !== undefined && (
            <NumberField label="weight (≥ 1)" value={weighted} step={0.1} onChange={(w) => setP(withField(pEntry, "algorithm", { "weighted-astar": { weight: w ?? 1 } }))} testId="rc-weight" />
          )}
          <NumberField
            label="onboard expansions / tick"
            value={pEntry?.onboardComputeExpansionsPerTick}
            integer
            onChange={(v) => setP(withField(pEntry, "onboardComputeExpansionsPerTick", v))}
            testId="rc-per-tick"
          />
          <NumberField label="total budget (expansions)" value={pEntry?.totalBudget} integer onChange={(v) => setP(withField(pEntry, "totalBudget", v))} testId="rc-total-budget" />
        </div>
        <div className="row">
          <NumberField label="explore radius (m)" value={pEntry?.radiusM} placeholder="ugv 20 · uav 40" onChange={(v) => setP(withField(pEntry, "radiusM", v))} testId="rc-explore-radius" />
          <NumberField label="explore window margin (m)" value={pEntry?.windowMarginM} placeholder="10" onChange={(v) => setP(withField(pEntry, "windowMarginM", v))} testId="rc-window-margin" />
        </div>
        {pEntry?.strategy !== undefined && <StrategyPicker key={planningScope} value={pEntry.strategy} onChange={(strategy) => setP(withPlanner(pEntry, { strategy }))} issue={strategyIssue} />}
        {validation.ok && <Warnings warnings={validation.resolved.warnings} />}
        <FormControlLabel
          control={
            <Checkbox
              size="small"
              checked={pEntry?.costProfile !== undefined}
              onChange={(e) => setP(withField(pEntry, "costProfile", e.target.checked ? { weights: { distance: 1 } } : undefined))}
              slotProps={{ input: { "data-testid": "rc-override-profile" } as InputHTMLAttributes<HTMLInputElement> }}
            />
          }
          label={`Set the cost profile for ${scopeLabel(pScope)}`}
        />
        {pEntry?.costProfile !== undefined && <CostProfileForm value={pEntry.costProfile} onChange={(c) => setP(withField(pEntry, "costProfile", c))} testId="rc-profile" />}
      </section>

      <section data-testid="rc-drive">
        <h4>Ground drive (UGV)</h4>
        <ScopeSelect label="Drive level" value={driveScope} scopes={driveScopes(view)} onChange={setDriveScope} testId="rc-drive-scope" entries={(s) => getEntry(draft, "drive", s) !== undefined} />
        <div className="row wrap">
          <OptionField label="drive" value={dEntry?.drive} options={DRIVES} onChange={(v) => setD(withField(dEntry, "drive", v))} testId="rc-drive" />
          <OptionField
            label="reverse allowed"
            value={dEntry?.reverseAllowed === undefined ? undefined : dEntry.reverseAllowed ? "yes" : "no"}
            options={YES_NO}
            onChange={(v) => setD(withField(dEntry, "reverseAllowed", v === undefined ? undefined : v === "yes"))}
            testId="rc-reverse"
          />
          <NumberField label="max reverse speed (m/s)" value={dEntry?.maxReverseSpeedMps} onChange={(v) => setD(withField(dEntry, "maxReverseSpeedMps", v))} testId="rc-max-reverse" />
          <NumberField label="max yaw rate (rad/s)" value={dEntry?.maxYawRateRadps} onChange={(v) => setD(withField(dEntry, "maxYawRateRadps", v))} testId="rc-yaw-rate" />
          <NumberField label="wheelbase (m)" value={dEntry?.wheelbaseM} onChange={(v) => setD(withField(dEntry, "wheelbaseM", v))} testId="rc-wheelbase" />
          <NumberField label="max steering (rad)" value={dEntry?.maxSteeringAngleRad} onChange={(v) => setD(withField(dEntry, "maxSteeringAngleRad", v))} testId="rc-steering" />
          <NumberField label="max steering rate (rad/s)" value={dEntry?.maxSteeringRateRadps} onChange={(v) => setD(withField(dEntry, "maxSteeringRateRadps", v))} testId="rc-steering-rate" />
        </div>
      </section>

      <section data-testid="rc-beliefs">
        <h4>Beliefs (initial map)</h4>
        <ScopeSelect label="Beliefs level" value={beliefsScope} scopes={planningScopes(view)} onChange={setBeliefsScope} testId="rc-beliefs-scope" entries={(s) => getEntry(draft, "beliefs", s) !== undefined} />
        <div className="row wrap">
          <OptionField
            label="initial map"
            value={initValue(bEntry?.init)}
            options={["unknown", "ideal", ...priorIds.map((p) => `prior:${p}`)]}
            inheritLabel="unknown (default)"
            onChange={(v) => setB(withField(bEntry, "init", initFrom(v)))}
            testId="rc-beliefs-init"
          />
        </div>
        <p className="muted">
          unknown: the agent learns the map by sensing. prior: it starts from a scenario map, which may be wrong. ideal: it plans on the ground truth, for baselines only — labelled “ideal” in the Explorer and the Inspector.
        </p>
      </section>

      <section data-testid="rc-validation">
        <h4>Validation</h4>
        {validation.ok ? (
          <p data-testid="rc-valid">✓ valid for {validation.resolved.agents.length} agents</p>
        ) : (
          <Issue code={validation.error.code} message={validation.error.message} testId="rc-error">
            {validation.error.path && <span className="muted mono"> at {validation.error.path}</span>}
          </Issue>
        )}
        <dl className="kv">
          <dt>run config hash</dt>
          <dd className="mono" data-testid="rc-run-config-hash">
            {validation.ok ? validation.resolved.runConfigHash : "—"} {sameAsRun ? <span className="muted">(= current run)</span> : <span className="muted">(current run {run.header.runConfigHash})</span>}
          </dd>
          <dt>effective config hash</dt>
          <dd className="mono" data-testid="rc-effective-config-hash">
            {validation.ok ? validation.resolved.effectiveConfigHash : "—"}
          </dd>
        </dl>
        <div className="row">
          <Button
            variant="contained"
            onClick={() => validation.ok && !current.busy && current.runWithConfig(validation.resolved.document)}
            aria-disabled={!validation.ok || current.busy}
            data-testid="rc-run"
          >
            Run with this configuration
          </Button>
          <Button variant="outlined" color="inherit" onClick={() => setDraft(props.loaded.initial)} data-testid="rc-revert">
            Revert to the current run's
          </Button>
        </div>
        {current.error && <Issue code="run_failed" message={current.error} testId="rc-run-error" />}
      </section>

      {validation.ok && <EffectiveTable agents={validation.resolved.agents} />}
      <Presets draft={draft} scenario={draft.scenario} onLoad={setDraft} />
      <JsonView draft={draft} onApply={setDraft} />
    </div>
  );
}

function ScopeSelect(props: { label: string; value: string; scopes: Scope[]; onChange: (id: string) => void; testId: string; entries: (s: Scope) => boolean }) {
  return (
    <label className="field">
      <span className="field-label">{props.label}</span>
      <NativeSelect value={props.value} onChange={(e) => props.onChange(e.target.value)} inputProps={{ "aria-label": props.label, "data-testid": props.testId } as object}>
        {props.scopes.map((s) => (
          <option key={scopeId(s)} value={scopeId(s)}>
            {scopeLabel(s)}
            {props.entries(s) ? " ●" : ""}
          </option>
        ))}
      </NativeSelect>
    </label>
  );
}

/** Non-blocking remarks of the resolver (ADR-0037 seventh addition): a glyph and the stable code, never colour alone. */
function Warnings(props: { warnings: readonly RunConfigWarning[] }) {
  const shown = props.warnings.slice(0, MAX_WARNINGS_SHOWN);
  return (
    <>
      {shown.map((w) => (
        <p key={`${w.code}-${w.agentId}`} className="warning" role="note" data-testid={`rc-warning-${w.agentId}`}>
          ▲ <span className="mono">{w.code}</span> {w.message}
        </p>
      ))}
      {props.warnings.length > shown.length && <p className="muted">… {props.warnings.length - shown.length} more warnings</p>}
    </>
  );
}

/** Resolved per-agent planning configuration with the level that supplied each field (ADR-0028). */
function EffectiveTable(props: { agents: readonly EffectiveAgentConfig[] }) {
  const rows = props.agents.slice(0, MAX_EFFECTIVE_ROWS);
  return (
    <section data-testid="rc-effective">
      <h4>Effective configuration</h4>
      <table className="effective-table">
        <thead>
          <tr>
            <th>agent</th>
            <th>algorithm</th>
            <th>per tick</th>
            <th>total</th>
            <th>explore (radius / margin)</th>
            <th>cost profile</th>
            <th>initial map</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.agentId} data-testid={`rc-effective-${a.agentId}`}>
              <td className="mono">
                {a.agentId} <span className="muted">{a.key ?? ""}</span>
              </td>
              <td>
                <span className="mono">{plannerLabel(a.planning)}</span> <span className="source-tag">{a.planningSources.algorithm}</span>
                {a.planning.strategy && <span className="muted mono"> #{a.planning.strategy.hash}</span>}
              </td>
              <td>
                <span className="mono">{a.planning.onboardComputeExpansionsPerTick}</span> <span className="source-tag">{a.planningSources.onboardComputeExpansionsPerTick}</span>
              </td>
              <td>
                <span className="mono">{a.planning.totalBudget}</span> <span className="source-tag">{a.planningSources.totalBudget}</span>
              </td>
              <td data-testid={`rc-effective-explore-${a.agentId}`}>
                <span className="mono">{a.planning.radiusM} m</span> <span className="source-tag">{a.planningSources.radiusM}</span> <span className="mono">/ {a.planning.windowMarginM} m</span>{" "}
                <span className="source-tag">{a.planningSources.windowMarginM}</span>
              </td>
              <td>
                <span className="mono">{profileSummary(a.planning.costProfile)}</span> <span className="source-tag">{a.planningSources.costProfile}</span>
              </td>
              <td data-testid={`rc-effective-init-${a.agentId}`}>
                <span className="mono">{a.beliefs.idealized ? "◆ ideal" : typeof a.beliefs.init === "string" ? a.beliefs.init : `prior ${a.beliefs.init.prior}`}</span> <span className="source-tag">{a.beliefsSource}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {props.agents.length > rows.length && <p className="muted">… {props.agents.length - rows.length} more agents (see the Inspector).</p>}
    </section>
  );
}

/** Named presets in the run-configuration library (ADR-0028), versioned like scenarios. */
function Presets(props: { draft: RunConfigDocument; scenario: RunConfigDocument["scenario"]; onLoad: (d: RunConfigDocument) => void }) {
  const { storage } = useServices();
  const status = useStorageStatus(storage);
  const [list, setList] = useState<RunConfigSummary[]>([]);
  const [selected, setSelected] = useState("");
  const [name, setName] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const ready = status.state === "ready";
  const refresh = useCallback(() => {
    if (ready) void storage.ports.runConfigs.list().then(setList, () => setList([]));
  }, [ready, storage]);
  useEffect(refresh, [refresh]);

  const save = async () => {
    const id = presetIdOf(name);
    if (!id) return setMsg({ ok: false, text: "invalid_document: a preset name needs at least one letter" });
    const r = await storage.ports.runConfigs.saveVersion({ id, name: name.trim(), document: props.draft });
    if (!r.ok) return setMsg({ ok: false, text: `${r.error.code}: ${r.error.message}` });
    setMsg({ ok: true, text: `saved ${r.value.id} v${r.value.version}` });
    setSelected(r.value.id);
    refresh();
  };
  const load = async () => {
    const stored = await storage.ports.runConfigs.get(selected);
    if (!stored) return setMsg({ ok: false, text: `unknown_run_config: ${selected}` });
    // A database may come from an imported file: validate before use (ADR-0028).
    const p = parseRunConfigValue(stored.document);
    if (!p.ok) return setMsg({ ok: false, text: `${p.error.code}: ${p.error.message}` });
    const { doc, rebased } = rebasePreset(p.value, props.scenario);
    props.onLoad(doc);
    setMsg({ ok: true, text: `loaded ${stored.id} v${stored.version}${rebased ? ` (saved for ${p.value.scenario.id} v${p.value.scenario.version}; applied to v${props.scenario.version})` : ""}` });
  };
  return (
    <section data-testid="rc-presets">
      <h4>Presets</h4>
      <div className="row wrap">
        <NativeSelect value={selected} onChange={(e) => setSelected(e.target.value)} inputProps={{ "aria-label": "Preset", "data-testid": "rc-preset-select" } as object}>
          <option value="">{list.length === 0 ? "(no presets)" : "(choose a preset)"}</option>
          {list.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} · v{s.latestVersion}
            </option>
          ))}
        </NativeSelect>
        <Button variant="outlined" color="inherit" disabled={!ready || selected === ""} onClick={() => void load()} data-testid="rc-preset-load">
          Load
        </Button>
        <TextField size="small" label="preset name" value={name} onChange={(e) => setName(e.target.value.slice(0, 200))} slotProps={{ htmlInput: { "data-testid": "rc-preset-name" } as InputHTMLAttributes<HTMLInputElement> }} />
        <Button variant="outlined" color="inherit" disabled={!ready || name.trim() === ""} onClick={() => void save()} data-testid="rc-preset-save">
          Save as new version
        </Button>
      </div>
      {msg && (
        <p className={msg.ok ? "" : "danger"} role="status" data-testid="rc-preset-msg">
          {msg.ok ? "✓" : "✗"} {msg.text}
        </p>
      )}
    </section>
  );
}

/** The canonical document as JSON; edits are applied only through the same parser, never merged by hand. */
function JsonView(props: { draft: RunConfigDocument; onApply: (d: RunConfigDocument) => void }) {
  const shown = useMemo(() => JSON.stringify(props.draft, null, 2), [props.draft]);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const apply = () => {
    if (text === null) return;
    const r = parseRunConfig(text);
    if (!r.ok) return setError(r.error);
    setError(null);
    setText(null);
    props.onApply(r.value);
  };
  return (
    <section data-testid="rc-json">
      <h4>JSON</h4>
      <TextField
        multiline
        fullWidth
        minRows={6}
        maxRows={24}
        value={text ?? shown}
        onChange={(e) => setText(e.target.value)}
        slotProps={{ htmlInput: { "data-testid": "rc-json-text", className: "mono", spellCheck: false, "aria-label": "Run configuration JSON" } as InputHTMLAttributes<HTMLTextAreaElement> }}
      />
      <div className="row">
        <Button variant="outlined" color="inherit" disabled={text === null} onClick={apply} data-testid="rc-json-apply">
          Apply JSON
        </Button>
        <Button
          variant="text"
          disabled={text === null}
          onClick={() => {
            setText(null);
            setError(null);
          }}
        >
          Discard edits
        </Button>
      </div>
      {error && <Issue code={error.code} message={error.message} testId="rc-json-error" />}
    </section>
  );
}

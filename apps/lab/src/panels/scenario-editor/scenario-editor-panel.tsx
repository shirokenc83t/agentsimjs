import "../panels.css";
import {
  parseRunConfigValue,
  parseScenario,
  parseScenarioValue,
  SCENARIO_LIMITS,
  scenarioAgents,
  serializeScenario,
  type ScenarioDocument,
  type ZoneSpec,
} from "@agentsim/scenarios";
import type { RunConfigSummary, ScenarioSummary } from "@agentsim/storage";
import { downloadBytes, SceneView, type BeliefViewMode, type EditPointerPhase, type GridViewMode, type SceneRenderer } from "@agentsim/ui";
import { useCallback, useEffect, useMemo, useRef, useState, type InputHTMLAttributes, type KeyboardEvent } from "react";
import { attachRendererProbe } from "../../probe.ts";
import { Button, NativeSelect, TextField } from "../controls.tsx";
import { useAppActions, useCurrentRun, useServices, useStorageStatus } from "../../services.tsx";
import { Issue, NumberField, OptionField } from "../run-config/fields.tsx";
import { rebasePreset, validateDraft } from "../run-config/model.ts";
import { AgentForm, NewScenarioForm, ZoneList } from "./editor-forms.tsx";
import { ExtrasValidation, ObjectForm, PriorList } from "./extras-forms.tsx";
import { EditorView } from "./editor-view.ts";
import { agentIdsOf, ScenarioDraft, type Brush, type PaintLayer, type PriorBrush, type PriorBrushValue } from "./model.ts";
import { editorSession, type Tool } from "./session.ts";
import { CollapseIcon, ExpandIcon } from "../../workspaces/window-icons.tsx";

const TOOLS: readonly { id: Tool; label: string; key: string; glyph: string; hint: string }[] = [
  { id: "navigate", label: "navigate", key: "V", glyph: "✥", hint: "drag to rotate, right-drag to pan, wheel to zoom" },
  { id: "paint", label: "paint", key: "B", glyph: "▦", hint: "drag to paint the selected layer; Ctrl+Z undoes a stroke" },
  { id: "zone", label: "zone", key: "Z", glyph: "▭", hint: "drag a rectangle" },
  { id: "agent", label: "agent", key: "A", glyph: "▲", hint: "click to place, drag an agent to move it" },
  { id: "object", label: "object", key: "O", glyph: "◆", hint: "click to place an object (a thing sensors can see), drag to move it" },
];
const PRIOR_BRUSH_VALUES: readonly PriorBrushValue[] = ["unknown", "free", "occupied", "flip"];
const LAYERS: readonly { id: PaintLayer; label: string; view: GridViewMode; glyph: string }[] = [
  { id: "occupancy", label: "occupancy", view: "occupancy", glyph: "■" },
  { id: "terrainCost", label: "terrain cost", view: "terrain", glyph: "▤" },
  { id: "heightDm", label: "height", view: "height", glyph: "▲" },
];
const ZONE_KINDS = ["geofence", "base", "noFly"] as const;
const AGENT_KINDS = ["ugv", "uav"] as const;
type Msg = { ok: boolean; text: string; code?: string };

/**
 * Scenario editor v0 (F1 e7, UI-SPEC §4, ADR-0025). Edits a draft of a scenario document: grid layers painted
 * with a brush on the atlas view, base/geofence/no-fly rectangles, agents (placement, pose, base, body). It never
 * edits the running world. Drafts are saved as new versions through the ScenarioStore (never overwriting), can
 * be exported and imported as JSON (validated like any external input), and "Run" starts a run of the saved
 * version with a chosen run configuration.
 */
export function ScenarioEditorPanel() {
  const { storage } = useServices();
  const status = useStorageStatus(storage);
  const current = useCurrentRun();
  const actions = useAppActions();
  const view = useMemo(() => {
    const v = new EditorView();
    if (editorSession.draft) v.show(editorSession.draft);
    return v;
  }, []);
  // State starts from the session and is written back to it (the panel is unmounted on tab and workspace switches).
  const [draft, setDraft] = useState<ScenarioDraft | undefined>(editorSession.draft);
  const [, setRev] = useState(0);
  const bump = useCallback(() => setRev((r) => r + 1), []);
  /** The stored version this draft was opened from or saved as, with the draft revision at that time. */
  const [saved, setSaved] = useState(editorSession.saved);
  const [tool, setTool] = useState<Tool>(editorSession.tool);
  const [brush, setBrush] = useState<Brush>(editorSession.brush);
  const [zoneKind, setZoneKind] = useState<(typeof ZONE_KINDS)[number]>("geofence");
  const [agentKind, setAgentKind] = useState<(typeof AGENT_KINDS)[number]>("ugv");
  const [selected, setSelected] = useState<number | undefined>(undefined);
  const [selectedObject, setSelectedObject] = useState<number | undefined>(undefined);
  /** A prior drawn over the world, the prior the paint tool edits (`undefined`: the world), and how it is drawn. */
  const [priorShown, setPriorShown] = useState<string | undefined>(undefined);
  const [priorEditing, setPriorEditing] = useState<string | undefined>(undefined);
  // The brush window: folded to its title bar until opened (it starts at a corner and never over what is being painted), movable inside the map's area; the prior's brush opens it.
  const [brushOpen, setBrushOpen] = useState(false);
  const [brushAt, setBrushAt] = useState<{ x: number; y: number } | undefined>(undefined);
  useEffect(() => {
    if (priorEditing !== undefined) setBrushOpen(true);
  }, [priorEditing]);
  const [priorMode, setPriorMode] = useState<BeliefViewMode>("belief");
  const [priorBrush, setPriorBrush] = useState<PriorBrush>({ value: "unknown", radiusCells: 3 });
  const [msg, setMsg] = useState<Msg | null>(null);
  const [newForm, setNewForm] = useState(false);
  const [renderer, setRenderer] = useState<SceneRenderer | undefined>(undefined);

  // Pointer handlers read the latest tool state through a ref (the renderer keeps one callback).
  const live = useRef({ draft, tool, brush, zoneKind, agentKind, priorEditing, priorBrush });
  live.current = { draft, tool, brush, zoneKind, agentKind, priorEditing, priorBrush };
  const gesture = useRef<{ zoneFrom: { x: number; y: number } | undefined; agent: number | undefined; object: number | undefined }>({ zoneFrom: undefined, agent: undefined, object: undefined });

  const show = useCallback(
    (d: ScenarioDraft, savedAs?: { version: number; document: ScenarioDocument }) => {
      setDraft(d);
      setSaved(savedAs ? { ...savedAs, revision: d.revision } : undefined);
      setSelected(undefined);
      setSelectedObject(undefined);
      setPriorShown(undefined);
      setPriorEditing(undefined);
      view.showPrior(undefined);
      view.show(d);
    },
    [view],
  );

  const onEditPointer = useCallback(
    (phase: EditPointerPhase, x: number, y: number) => {
      const { draft: d, tool: t, brush: b, zoneKind: zk, agentKind: ak, priorEditing: pe, priorBrush: pb } = live.current;
      if (!d || !renderer) return;
      const res = d.resolutionM;
      if (t === "paint" && pe !== undefined) {
        // Editing a prior: the stroke goes into its knowledge layer only; the world is not touched.
        renderer.setBrushCursor({ xM: x, yM: y, radiusM: (pb.radiusCells + 0.5) * res });
        if (phase === "down") d.beginPriorStroke(pe, x, y, pb);
        else if (phase === "drag") d.extendPriorStroke(pe, x, y, pb);
        else if (phase === "up") {
          d.endPriorStroke(pe);
          bump();
        }
      } else if (t === "paint") {
        renderer.setBrushCursor({ xM: x, yM: y, radiusM: (b.radiusCells + 0.5) * res });
        if (phase === "down") d.beginStroke(x, y, b);
        else if (phase === "drag") d.extendStroke(x, y, b);
        else if (phase === "up") {
          d.endStroke();
          bump();
        }
      } else if (t === "object") {
        const g = gesture.current;
        if (phase === "down") {
          let k = d.objectNear(x, y, Math.max(1, 2 * res));
          if (k < 0) k = d.addObject(x, y);
          g.object = k;
          setSelectedObject(k);
          bump();
        } else if (phase === "drag" && g.object !== undefined) d.moveObject(g.object, x, y);
        else if (phase === "up") {
          g.object = undefined;
          bump();
        }
      } else if (t === "zone") {
        const g = gesture.current;
        if (phase === "down") g.zoneFrom = { x, y };
        else if (g.zoneFrom && (phase === "drag" || phase === "up")) {
          const from = g.zoneFrom;
          if (phase === "drag") view.setPreviewZone({ id: "drawing", kind: zk, rect: { x0: Math.min(from.x, x), y0: Math.min(from.y, y), x1: Math.max(from.x, x), y1: Math.max(from.y, y) } });
          else {
            g.zoneFrom = undefined;
            view.setPreviewZone(undefined);
            if (Math.abs(x - from.x) >= res && Math.abs(y - from.y) >= res) d.addRectZone(zk, snap(from.x, res), snap(from.y, res), snap(x, res), snap(y, res));
            bump();
          }
        }
      } else if (t === "agent") {
        const g = gesture.current;
        if (phase === "down") {
          let k = d.agentNear(x, y, Math.max(1, 2 * res));
          if (k < 0) k = d.addAgent(ak, x, y);
          g.agent = k;
          setSelected(k);
          bump();
        } else if (phase === "drag" && g.agent !== undefined) d.moveAgent(g.agent, x, y);
        else if (phase === "up") {
          g.agent = undefined;
          bump();
        }
      }
      view.sync();
    },
    [renderer, view, bump],
  );

  const onRenderer = useCallback(
    (r: SceneRenderer | undefined) => {
      setRenderer(r);
      attachRendererProbe(r);
      view.attach(r);
    },
    [view],
  );
  useEffect(() => {
    if (!renderer) return;
    renderer.onEditPointer = onEditPointer;
    renderer.setEditMode(tool !== "navigate");
    if (tool !== "paint") renderer.setBrushCursor(undefined);
  }, [renderer, onEditPointer, tool]);
  // Painting a layer shows that layer's view.
  const [viewMode, setViewMode] = useState<GridViewMode>(editorSession.viewMode);
  useEffect(() => {
    Object.assign(editorSession, { draft, saved, tool, brush, viewMode });
  }, [draft, saved, tool, brush, viewMode]);
  useEffect(() => renderer?.setViewMode(viewMode), [renderer, viewMode, draft]);

  // Stored scenarios and run-configuration presets (refreshed after saves and deletes).
  const [stored, setStored] = useState<ScenarioSummary[]>([]);
  const [presets, setPresets] = useState<RunConfigSummary[]>([]);
  const [listEpoch, setListEpoch] = useState(0);
  const ready = status.state === "ready";
  useEffect(() => {
    if (!ready) return;
    void storage.ports.scenarios.list().then(setStored, () => setStored([]));
    void storage.ports.runConfigs.list().then(setPresets, () => setPresets([]));
  }, [ready, storage, listEpoch]);

  const [openId, setOpenId] = useState("");
  const open = async (id: string) => {
    const s = await storage.ports.scenarios.get(id);
    if (!s) return setMsg({ ok: false, code: "unknown_scenario", text: id });
    // A database may come from an imported file: the stored document is untrusted until parsed (ADR-0025).
    const p = parseScenarioValue(s.document);
    if (!p.ok) return setMsg({ ok: false, code: p.error.code, text: p.error.message });
    const d = ScenarioDraft.fromDocument(p.value);
    if (!d.ok) return setMsg({ ok: false, code: d.error.code, text: d.error.message });
    show(d.value, { version: s.version, document: p.value });
    setMsg({ ok: true, text: `opened ${s.id} v${s.version}` });
  };

  const fileInput = useRef<HTMLInputElement>(null);
  const importFile = async (file: File) => {
    if (file.size > SCENARIO_LIMITS.maxDocumentBytes) return setMsg({ ok: false, code: "too_large", text: `${file.name} exceeds ${SCENARIO_LIMITS.maxDocumentBytes} bytes` });
    const p = parseScenario(await file.text());
    if (!p.ok) return setMsg({ ok: false, code: p.error.code, text: `${file.name}: ${p.error.message}` });
    const d = ScenarioDraft.fromDocument(p.value);
    if (!d.ok) return setMsg({ ok: false, code: d.error.code, text: d.error.message });
    show(d.value);
    setMsg({ ok: true, text: `imported ${file.name} (not saved yet)` });
  };

  const validated = (): ScenarioDocument | undefined => {
    if (!draft) return undefined;
    const v = draft.validate();
    if (!v.ok) {
      setMsg({ ok: false, code: v.error.code, text: `${v.error.message}${v.error.path ? ` at ${v.error.path}` : ""}` });
      return undefined;
    }
    return v.document;
  };

  const save = async () => {
    const doc = validated();
    if (!doc || !draft) return;
    const r = await storage.ports.scenarios.saveVersion(doc);
    if (!r.ok) return setMsg({ ok: false, code: r.error.code, text: r.error.message });
    setSaved({ version: r.value.version, revision: draft.revision, document: doc });
    setMsg({ ok: true, text: `saved ${r.value.id} v${r.value.version}` });
    setListEpoch((n) => n + 1);
  };

  const exportJson = () => {
    const doc = validated();
    if (doc) downloadBytes(new TextEncoder().encode(serializeScenario(doc)), `${doc.id}.json`, "application/json");
  };

  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleteScenario = async () => {
    if (!draft) return;
    setConfirmDelete(false);
    const r = await storage.ports.scenarios.delete(draft.meta.id);
    if (!r.ok) return setMsg({ ok: false, code: r.error.code, text: r.error.message });
    setSaved(undefined);
    setMsg({ ok: true, text: `deleted every version of ${draft.meta.id} (version numbers are not reused)` });
    setListEpoch((n) => n + 1);
  };

  const [presetId, setPresetId] = useState("");
  const run = async () => {
    if (!draft || !saved || dirty) return;
    const doc = saved.document;
    let runConfig: unknown = { schemaVersion: 0, scenario: { id: doc.id, version: saved.version } };
    if (presetId !== "") {
      const p = await storage.ports.runConfigs.get(presetId);
      const parsed = p ? parseRunConfigValue(p.document) : undefined;
      if (!parsed?.ok) return setMsg({ ok: false, code: parsed ? parsed.error.code : "unknown_run_config", text: presetId });
      runConfig = rebasePreset(parsed.value, { id: doc.id, version: saved.version }).doc;
    }
    // Same validation as the run-configuration panel: a preset naming unknown agent keys is refused with its code.
    const v = validateDraft(runConfig, scenarioAgents(doc), saved.version);
    if (!v.ok) return setMsg({ ok: false, code: v.error.code, text: v.error.message });
    current.startScenarioRun(doc, saved.version, v.resolved.document, doc.name);
    actions.openWorkspace("scene");
  };

  // The prior drawn over the world: the one being edited, else the one chosen for display.
  const drawnPrior = priorEditing ?? priorShown;
  useEffect(() => {
    view.showPrior(drawnPrior, priorMode);
  }, [view, drawnPrior, priorMode, draft]);
  // Validation of ids, limits and priors on every change, with the loader's codes; prior summaries likewise.
  const rev = draft?.revision;
  const extras = useMemo(() => draft?.validateExtras(), [draft, rev]);
  const priorSummaries = useMemo(() => draft?.priorSummaries() ?? [], [draft, rev]);
  const dirty = draft !== undefined && (saved === undefined || saved.revision !== draft.revision);
  const ids = draft ? agentIdsOf(draft.agents) : [];
  const sel = draft && selected !== undefined ? draft.agents[selected] : undefined;

  const onKeyDown = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT") return;
    const byKey = !e.ctrlKey && !e.metaKey && !e.altKey ? TOOLS.find((x) => x.key.toLowerCase() === e.key.toLowerCase()) : undefined;
    if (byKey && draft) {
      e.preventDefault();
      setTool(byKey.id);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && draft && (priorEditing !== undefined ? draft.undoPrior(priorEditing) : draft.undo())) {
      e.preventDefault();
      view.sync();
      bump();
    }
  };

  return (
    <div className="panel scenario-editor se" data-testid="scenario-editor" tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="editor-main">
        {draft && (
          <div className="se-sub" role="toolbar" aria-label="Paint target and view">
            {tool === "paint" ? (
              <p className={priorEditing !== undefined ? "edit-target prior" : "edit-target"} role="status" data-testid="ed-edit-target">
                {priorEditing !== undefined ? `◆ Painting PRIOR “${priorEditing}” — the world is not changed` : `■ Painting the WORLD (${brush.layer})`}
              </p>
            ) : (
              <span className="muted">{TOOLS.find((t) => t.id === tool)?.hint}</span>
            )}
            <span className="sp" />
            {drawnPrior !== undefined && (
              <span className="se-chips" role="group" aria-label="Prior overlay">
                <button type="button" className={`chip tip-right${priorMode === "belief" ? " on" : ""}`} aria-pressed={priorMode === "belief"} onClick={() => setPriorMode("belief")} data-testid="ed-prior-mode-belief" data-tip="What the prior knows (unknown is dark)">
                  prior
                </button>
                <button type="button" className={`chip tip-right${priorMode === "difference" ? " on" : ""}`} aria-pressed={priorMode === "difference"} onClick={() => setPriorMode("difference")} data-testid="ed-prior-mode-difference" data-tip="Where the prior disagrees with the world">
                  ◆ against the world
                </button>
              </span>
            )}
            {drawnPrior !== undefined && priorMode === "difference" && (
              <p className="researcher-banner" role="note" data-testid="ed-researcher-marker">
                ◆ Researcher view — not visible to the mind
              </p>
            )}
            <button type="button" className="chip" onClick={() => renderer?.viewTopDown()} data-testid="ed-fit">
              ⤢ fit
            </button>
          </div>
        )}
        <div className="se-stage">
          {draft && (
            <nav className="se-tools" data-testid="ed-tools" aria-orientation="vertical" aria-label="Editor tools">
              {TOOLS.map((t) => (
                <button key={t.id} type="button" className={`tool${tool === t.id ? " on" : ""}`} aria-pressed={tool === t.id} onClick={() => setTool(t.id)} data-testid={`ed-tool-${t.id}`} data-tip={t.hint}>
                  <span className="g">{t.glyph}</span>
                  {t.label}
                  <span className="kb">{t.key}</span>
                </button>
              ))}
              <hr />
              {LAYERS.map((l) => (
                <button key={l.view} type="button" className={`tool${viewMode === l.view ? " on" : ""}`} aria-pressed={viewMode === l.view} onClick={() => setViewMode(l.view)} data-testid={`ed-view-${l.view}`}>
                  <span className="g">{l.glyph}</span>
                  {l.label}
                </button>
              ))}
              <hr />
              <button
                type="button"
                className="tool"
                disabled={!draft.canUndo}
                onClick={() => {
                  draft.undo();
                  view.sync();
                  bump();
                }}
                data-testid="ed-undo"
              >
                <span className="g">↶</span>undo stroke<span className="kb">^Z</span>
              </button>
            </nav>
          )}
          <div className="editor-view">
            <SceneView interpolator={view.interpolator} onRenderer={onRenderer}>
              {!draft && <p className="editor-empty muted">Open a stored scenario, import a file, or create a new one.</p>}
            </SceneView>
            {draft && tool === "paint" && (
              <div
                className={`se-brush${brushOpen ? "" : " folded"}`}
                role="dialog"
                aria-label={priorEditing !== undefined ? "Prior brush" : "Brush"}
                data-testid="ed-brush-window"
                style={brushAt ? { left: brushAt.x, top: brushAt.y, right: "auto" } : undefined}
              >
                <div
                  className="se-brush-bar"
                  onPointerDown={(e) => {
                    if ((e.target as HTMLElement).closest("button")) return;
                    e.currentTarget.setPointerCapture(e.pointerId);
                  }}
                  onPointerMove={(e) => {
                    if (e.buttons !== 1) return;
                    const win = e.currentTarget.parentElement;
                    const area = win?.parentElement?.getBoundingClientRect();
                    if (!win || !area) return;
                    // Inside the map's area, whatever the pointer does.
                    const x = Math.max(0, Math.min(area.width - win.offsetWidth, e.clientX - area.left - win.offsetWidth / 2));
                    const y = Math.max(0, Math.min(area.height - 24, e.clientY - area.top - 12));
                    setBrushAt({ x, y });
                  }}
                >
                  <span>{priorEditing !== undefined ? "PRIOR BRUSH" : "BRUSH"}</span>
                  <span className="sp" />
                  <button type="button" className="wb" onClick={() => setBrushOpen((o) => !o)} aria-label={brushOpen ? "Collapse the brush" : "Open the brush"} aria-expanded={brushOpen} data-testid="ed-brush-toggle">
                    {brushOpen ? <CollapseIcon /> : <ExpandIcon />}
                  </button>
                </div>
                <div className="se-brush-body" hidden={!brushOpen}>
                  {draft && tool === "paint" && priorEditing !== undefined && (
          <div data-testid="ed-prior-brush">
            
            <div className="row wrap">
              <OptionField label="paint" value={priorBrush.value} options={PRIOR_BRUSH_VALUES} inheritLabel="—" onChange={(v) => v && setPriorBrush({ ...priorBrush, value: v })} testId="ed-prior-brush-value" />
              <NumberField label="radius (cells)" value={priorBrush.radiusCells} integer onChange={(v) => setPriorBrush({ ...priorBrush, radiusCells: Math.max(0, Math.min(64, v ?? 0)) })} testId="ed-prior-brush-radius" />
              <Button
                size="small"
                variant="outlined"
                color="inherit"
                disabled={!draft.canUndoPrior(priorEditing)}
                onClick={() => {
                  draft.undoPrior(priorEditing);
                  view.sync();
                  bump();
                }}
                data-testid="ed-prior-undo"
              >
                Undo prior stroke
              </Button>
            </div>
            <p className="muted hint">unknown hides cells from the prior; free / occupied set them; flip swaps free and occupied (a wrong map).</p>
          </div>
                  )}
                  {draft && tool === "paint" && priorEditing === undefined && (
          <div data-testid="ed-brush">
            
            <div className="row wrap">
              <OptionField
                label="layer"
                value={brush.layer}
                options={LAYERS.map((l) => l.id)}
                inheritLabel="—"
                onChange={(v) => {
                  if (!v) return;
                  setBrush({ ...brush, layer: v, value: v === "occupancy" ? 1 : v === "terrainCost" ? 30 : 50 });
                  setViewMode(LAYERS.find((l) => l.id === v)?.view ?? "occupancy");
                }}
                testId="ed-brush-layer"
              />
              {brush.layer === "occupancy" ? (
                <OptionField
                  label="value"
                  value={brush.value === 1 ? "blocked" : "free"}
                  options={["blocked", "free"] as const}
                  inheritLabel="—"
                  onChange={(v) => v && setBrush({ ...brush, value: v === "blocked" ? 1 : 0 })}
                  testId="ed-brush-occupancy"
                />
              ) : brush.layer === "terrainCost" ? (
                <NumberField label="terrain cost (10 = nominal, 0 = impassable)" value={brush.value} integer onChange={(v) => setBrush({ ...brush, value: v ?? 10 })} testId="ed-brush-terrain" />
              ) : (
                <NumberField label="height (m)" value={brush.value / 10} step={0.1} onChange={(v) => setBrush({ ...brush, value: Math.round((v ?? 0) * 10) })} testId="ed-brush-height" />
              )}
              <NumberField label="radius (cells)" value={brush.radiusCells} integer onChange={(v) => setBrush({ ...brush, radiusCells: Math.max(0, Math.min(64, v ?? 0)) })} testId="ed-brush-radius" />
            </div>
            {brush.layer === "heightDm" && <p className="muted hint">On a blocked cell, height 0 means unknown height (hatched in the height view).</p>}
          </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <aside className="editor-side se-side" data-testid="ed-side">
        {draft && (
          <div className="rc-acts se-acts" role="group" aria-label="Actions">
            <Button variant="contained" disabled={!ready} onClick={() => void save()} data-testid="ed-save">
              Save as new version
            </Button>
            <Button variant="outlined" color="inherit" onClick={exportJson} data-testid="ed-export">
              Export JSON
            </Button>
            <Button variant="outlined" color="inherit" aria-disabled={!saved || dirty || current.busy} onClick={() => !current.busy && void run()} data-testid="ed-run-button">
              ▶ Run saved version
            </Button>
          </div>
        )}
        <div className="se-props">
        <section data-testid="ed-document">
          <h4>Scenario</h4>
          <div className="row wrap">
            <NativeSelect value={openId} onChange={(e) => setOpenId(e.target.value)} inputProps={{ "aria-label": "Stored scenario", "data-testid": "ed-open-select" } as object}>
              <option value="">{stored.length === 0 ? "(none stored)" : "(choose a scenario)"}</option>
              {stored.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} · {s.id} v{s.latestVersion}
                </option>
              ))}
            </NativeSelect>
            <Button variant="outlined" color="inherit" disabled={!ready || openId === ""} onClick={() => void open(openId)} data-testid="ed-open">
              Open
            </Button>
            <Button variant="outlined" color="inherit" onClick={() => setNewForm(true)} data-testid="ed-new">
              New…
            </Button>
            <Button variant="outlined" color="inherit" onClick={() => fileInput.current?.click()} data-testid="ed-import">
              Import…
            </Button>
            <input
              ref={fileInput}
              type="file"
              accept=".json,application/json"
              hidden
              data-testid="ed-import-file"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void importFile(f);
              }}
            />
          </div>
          {newForm && (
            <NewScenarioForm
              onCancel={() => setNewForm(false)}
              onCreate={(spec) => {
                setNewForm(false);
                show(ScenarioDraft.blank(spec));
                setTool("paint");
                setMsg({ ok: true, text: `new scenario ${spec.id} (not saved yet)` });
              }}
            />
          )}
          {draft && (
            <>
              <div className="row wrap">
                <TextField
                  size="small"
                  label="id"
                  value={draft.meta.id}
                  onChange={(e) => {
                    draft.setMeta({ id: e.target.value.trim().slice(0, 64) });
                    bump();
                  }}
                  slotProps={{ htmlInput: { "data-testid": "ed-meta-id", className: "mono" } as InputHTMLAttributes<HTMLInputElement> }}
                />
                <TextField
                  size="small"
                  label="name"
                  value={draft.meta.name}
                  onChange={(e) => {
                    draft.setMeta({ name: e.target.value.slice(0, 200) });
                    bump();
                  }}
                  slotProps={{ htmlInput: { "data-testid": "ed-meta-name" } as InputHTMLAttributes<HTMLInputElement> }}
                />
                <NumberField
                  label="default seed"
                  value={draft.meta.defaultSeed}
                  integer
                  onChange={(v) => {
                    draft.setMeta({ defaultSeed: v ?? 0 });
                    bump();
                  }}
                  testId="ed-meta-seed"
                />
              </div>
              <p className="mono" data-testid="ed-status">
                {draft.grid.sizeX} × {draft.grid.sizeY} cells at {draft.resolutionM} m · {saved ? `v${saved.version}` : "not saved"}
                {dirty ? " · unsaved changes" : ""}
              </p>
              <div className="row wrap">
                {confirmDelete ? (
                  <Button variant="outlined" color="error" onClick={() => void deleteScenario()} data-testid="ed-delete-confirm">
                    Delete every version of {draft.meta.id}
                  </Button>
                ) : (
                  <Button variant="text" disabled={!ready || !stored.some((s) => s.id === draft.meta.id)} onClick={() => setConfirmDelete(true)} data-testid="ed-delete">
                    Delete…
                  </Button>
                )}
              </div>
            </>
          )}
          {msg &&
            (msg.ok ? (
              <p role="status" data-testid="ed-msg">
                ✓ {msg.text}
              </p>
            ) : (
              <Issue code={msg.code ?? "error"} message={msg.text} testId="ed-error" />
            ))}
        </section>

        {draft && tool === "zone" && (
          <section>
            <h4>Zone tool</h4>
            <OptionField label="kind" value={zoneKind} options={ZONE_KINDS} inheritLabel="—" onChange={(v) => v && setZoneKind(v)} testId="ed-zone-kind" />
          </section>
        )}
        {draft && tool === "agent" && (
          <section>
            <h4>Agent tool</h4>
            <OptionField label="kind to place" value={agentKind} options={AGENT_KINDS} inheritLabel="—" onChange={(v) => v && setAgentKind(v)} testId="ed-agent-kind" />
          </section>
        )}

        {draft && (
          <section data-testid="ed-agents">
            <h4>Agents ({draft.agents.length})</h4>
            <ul className="agent-list">
              {draft.agents.map((a, k) => {
                const blocked = a.kind === "ugv" && !draft.grid.isFreeForGround(a.start.xM, a.start.yM);
                return (
                  <li key={k}>
                    <button type="button" className={k === selected ? "agent-row selected" : "agent-row"} onClick={() => setSelected(k)} data-testid={`ed-agent-${ids[k] ?? k}`}>
                      <span className="mono">{ids[k]}</span> <span className="muted">{a.key ?? ""}</span>{" "}
                      <span className="mono muted">
                        ({a.start.xM}, {a.start.yM})
                      </span>
                      {blocked && <span className="danger"> ✕ start not free</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
            {sel && selected !== undefined && (
              <AgentForm
                key={selected}
                agent={sel}
                index={selected}
                id={ids[selected] ?? ""}
                onChange={(a) => {
                  draft.updateAgent(selected, () => a);
                  view.sync();
                  bump();
                }}
                onDelete={() => {
                  draft.deleteAgent(selected);
                  setSelected(undefined);
                  view.sync();
                  bump();
                }}
              />
            )}
          </section>
        )}

        {draft && (
          <section data-testid="ed-objects">
            <h4>Objects ({draft.objects.length})</h4>
            <ul className="agent-list">
              {draft.objects.map((o, k) => (
                <li key={k}>
                  <button type="button" className={k === selectedObject ? "agent-row selected" : "agent-row"} onClick={() => setSelectedObject(k)} data-testid={`ed-object-${o.id}`}>
                    <span className="mono">{o.id}</span> <span className="muted">{o.kind}</span>{" "}
                    <span className="mono muted">
                      ({o.position.xM}, {o.position.yM})
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {selectedObject !== undefined && draft.objects[selectedObject] && (
              <ObjectForm
                key={selectedObject}
                object={draft.objects[selectedObject] as NonNullable<(typeof draft.objects)[number]>}
                onChange={(o) => {
                  draft.updateObject(selectedObject, () => o);
                  view.sync();
                  bump();
                }}
                onDelete={() => {
                  draft.deleteObject(selectedObject);
                  setSelectedObject(undefined);
                  view.sync();
                  bump();
                }}
              />
            )}
          </section>
        )}

        {draft && (
          <section data-testid="ed-priors">
            <h4>Prior maps ({draft.priors.length})</h4>
            <PriorList
              priors={priorSummaries}
              shown={priorShown}
              editing={priorEditing}
              onShow={setPriorShown}
              onEdit={(id) => {
                setPriorEditing(id);
                if (id !== undefined) {
                  setTool("paint");
                  setPriorMode("belief");
                }
              }}
              onUpdate={(id, patch) => {
                draft.updatePrior(id, patch);
                bump();
              }}
              onDelete={(id) => {
                draft.deletePrior(id);
                if (priorEditing === id) setPriorEditing(undefined);
                if (priorShown === id) setPriorShown(undefined);
                view.showPrior(undefined);
                view.sync();
                bump();
              }}
              onCreate={(id, confidence, description) => {
                const r = draft.createPriorFromWorld(id, confidence, description === "" ? undefined : description);
                if (r.ok) {
                  setPriorShown(id);
                  view.sync();
                  bump();
                }
                return r;
              }}
            />
          </section>
        )}

        {draft && extras && (
          <section data-testid="ed-validation-section">
            <h4>Validation</h4>
            <ExtrasValidation result={extras} />
          </section>
        )}

        {draft && (
          <section data-testid="ed-zones-section">
            <h4>Zones ({draft.zones.length})</h4>
            <ZoneList
              zones={draft.zones}
              onChange={(k, z: ZoneSpec) => {
                draft.updateZone(k, z);
                view.sync();
                bump();
              }}
              onDelete={(k) => {
                draft.deleteZone(k);
                view.sync();
                bump();
              }}
            />
          </section>
        )}

        {draft && (
          <section data-testid="ed-run">
            <h4>Run</h4>
            <div className="row wrap">
              <NativeSelect value={presetId} onChange={(e) => setPresetId(e.target.value)} inputProps={{ "aria-label": "Run configuration", "data-testid": "ed-run-config" } as object}>
                <option value="">default run configuration</option>
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    preset: {p.name} · v{p.latestVersion}
                  </option>
                ))}
              </NativeSelect>
            </div>
            {(!saved || dirty) && <p className="muted hint">Save first: runs start from a stored version, so they can be re-simulated.</p>}
          </section>
        )}
        </div>
      </aside>
    </div>
  );
}

/** Zone corners snap to cell boundaries. */
function snap(v: number, res: number): number {
  return Math.round(v / res) * res;
}

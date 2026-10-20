import {
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  DirectionalLight,
  GridHelper,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineLoop,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  MOUSE,
  Object3D,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  Raycaster,
  RingGeometry,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import { POSE_STRIDE } from "@agentsim/core";
import { RollingStats } from "../perf/rolling-stats.ts";
import { agentColorIndex, type SceneTokens } from "../theme/tokens.ts";
import { CHUNK_UPLOADS_PER_FRAME, type ChunkQueue, type GridDims } from "./atlas-layout.ts";
import { BeliefAtlas, type BeliefViewMode } from "./belief-atlas.ts";
import { SensorOverlay, type ExplorationView } from "./overlay-layers.ts";
import { StagesOverlay, type StageLine } from "./stages-overlay.ts";
import { GridAtlas, type GridViewMode } from "./grid-atlas.ts";
import type { PoseSource } from "./interpolator.ts";
import { PathLayer, type ExecutedPathView } from "./paths.ts";

const MAX_INSTANCES = 1024;
/** Click vs drag: a pointer that moved less than this (px) between down and up is a click. */
const CLICK_SLOP_PX = 4;

export interface GridSpec {
  readonly dims: GridDims;
  readonly zones: readonly { readonly id: string; readonly kind: string; readonly polygon: readonly number[] }[];
  readonly queue: ChunkQueue;
}

/** Edit-mode pointer phases: `hover` without a button, `down`/`drag`/`up` with the left button. */
export type EditPointerPhase = "hover" | "down" | "drag" | "up";

/** What a click in the scene picked (the panel turns it into a UI-context selection, ADR-0016). */
export type ScenePick = { readonly kind: "agent"; readonly id: string } | { readonly kind: "cell"; readonly i: number; readonly j: number; readonly xM: number; readonly yM: number };

/**
 * Imperative Three.js scene (ADR-0016): no React reconciliation on the render path. Runs at display
 * rate and samples the interpolator; never waits for the sim worker (ADR-0013). Allocation-free per frame.
 * Draws the grid atlas (ADR-0027), agents with ID labels, zones, and planned vs executed paths.
 */
export class SceneRenderer {
  /** CPU time spent per frame in sampling + matrix updates + uploads + render submission (ms). */
  readonly frameWorkMs = new RollingStats(240);
  /** Wall time between consecutive frames (ms). Reported only (noisy in headless CI). */
  readonly frameIntervalMs = new RollingStats(240);
  /** Optional per-frame observer (used by the e2e probe); must not allocate. */
  onFrame: ((poses: Float32Array, nowMs: number, workMs: number) => void) | undefined;
  /** Called on a click (not a drag) in the scene. */
  onPick: ((p: ScenePick) => void) | undefined;
  /** Edit mode only: left-button pointer events with the ground point under the pointer (sim metres). */
  onEditPointer: ((phase: EditPointerPhase, xM: number, yM: number, e: PointerEvent) => void) | undefined;
  private editMode = false;
  private editing = false;
  private readonly brushRing: Mesh<RingGeometry, MeshBasicMaterial>;

  private readonly renderer: WebGLRenderer;
  private readonly labels: CSS2DRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(55, 1, 0.1, 10_000);
  private readonly controls: OrbitControls;
  private readonly agents: InstancedMesh;
  private readonly groundMesh: Mesh;
  private readonly ground: MeshStandardMaterial;
  private readonly ambient: AmbientLight;
  private readonly sun: DirectionalLight;
  private readonly paths = new PathLayer();
  private readonly zones = new Group();
  private readonly labelGroup = new Group();
  private labelObjects: CSS2DObject[] = [];
  private readonly stalks: LineSegments<BufferGeometry, LineBasicMaterial>;
  private readonly stalkPos = new Float32Array(MAX_INSTANCES * 6);
  private readonly selectionRing: Mesh<RingGeometry, MeshBasicMaterial>;
  private selectedIndex = -1;
  private helperGrid: GridHelper | undefined;
  private atlas: GridAtlas | undefined;
  /** The viewed agent's belief overlay (F2): at most one at a time. */
  private beliefAtlas: BeliefAtlas | undefined;
  private beliefMode: "truth" | BeliefViewMode = "truth";
  /** Sensor rays, regions and frontier groups of the viewed agent (created on first use). */
  private sensorOverlay: SensorOverlay | undefined;
  /** The stages of the selected planning query, and of the researcher's Strategy test: created on first use. */
  private stagesOverlay: StagesOverlay | undefined;
  private sandboxOverlay: StagesOverlay | undefined;
  private gridSpec: GridSpec | undefined;
  private tokens: SceneTokens;
  private entityIds: readonly string[] = [];
  private airborne: readonly boolean[] = [];
  private readonly dummy = new Object3D();
  private readonly tmpColor = new Color();
  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();
  private readonly groundPlane = new Plane(new Vector3(0, 1, 0), 0);
  private readonly hit = new Vector3();
  private readonly projected = new Vector3();
  private readonly resize: ResizeObserver;
  private downAt: { x: number; y: number } | undefined;
  private raf = 0;
  private lastFrameAt = Number.NaN;

  constructor(
    private readonly container: HTMLElement,
    private readonly source: PoseSource,
    tokens: SceneTokens,
  ) {
    this.tokens = tokens;
    this.renderer = new WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1));
    this.renderer.domElement.dataset["testid"] = "scene-canvas";
    container.appendChild(this.renderer.domElement);
    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = "scene-labels";
    container.appendChild(this.labels.domElement);

    this.scene.background = new Color();
    this.camera.position.set(30, 35, 45);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(0, 0, 0);

    this.ambient = new AmbientLight(undefined, 0.8);
    this.scene.add(this.ambient);
    this.sun = new DirectionalLight(undefined, 1.4);
    this.sun.position.set(40, 80, 20);
    this.scene.add(this.sun);

    // F0 placeholder ground, shown until a scenario grid arrives.
    this.ground = new MeshStandardMaterial({ roughness: 1 });
    this.groundMesh = new Mesh(new PlaneGeometry(200, 200), this.ground);
    this.groundMesh.rotation.x = -Math.PI / 2;
    this.scene.add(this.groundMesh);

    // Agents: instanced cones pointing along +X (yaw rotates around Y); per-instance agent colours.
    const cone = new ConeGeometry(0.5, 1.5, 12);
    cone.rotateZ(-Math.PI / 2);
    this.agents = new InstancedMesh(cone, new MeshStandardMaterial({ roughness: 0.5 }), MAX_INSTANCES);
    this.agents.count = 0;
    // Instances move every frame: a cached bounding sphere would be stale (culling and picking would miss).
    this.agents.frustumCulled = false;
    this.scene.add(this.agents);

    // UAV altitude stalks (ground mark → body), preallocated.
    const stalkGeom = new BufferGeometry();
    stalkGeom.setAttribute("position", new BufferAttribute(this.stalkPos, 3));
    stalkGeom.setDrawRange(0, 0);
    this.stalks = new LineSegments(stalkGeom, new LineBasicMaterial());
    this.stalks.frustumCulled = false;
    this.scene.add(this.stalks);

    this.selectionRing = new Mesh(new RingGeometry(1.0, 1.25, 32), new MeshBasicMaterial({ transparent: true, opacity: 0.9 }));
    this.selectionRing.rotation.x = -Math.PI / 2;
    this.selectionRing.visible = false;
    this.brushRing = new Mesh(new RingGeometry(0.92, 1, 48), new MeshBasicMaterial({ transparent: true, opacity: 0.9, depthTest: false }));
    this.brushRing.rotation.x = -Math.PI / 2;
    this.brushRing.visible = false;
    this.brushRing.renderOrder = 10;
    this.scene.add(this.selectionRing, this.brushRing, this.paths.group, this.zones, this.labelGroup);

    this.applyTheme(tokens);

    const canvas = this.renderer.domElement;
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(container);
    this.fit();
  }

  /**
   * Applies a token snapshot (theme change): updates colours and materials once, outside the frame loop
   * (ADR-0032 §2). Never called per frame.
   */
  applyTheme(t: SceneTokens): void {
    this.tokens = t;
    (this.scene.background as Color).set(t.background);
    this.ground.color.set(t.ground);
    this.ambient.color.set(t.light);
    this.sun.color.set(t.light);
    this.stalks.material.color.set(t.pathPlannedDim);
    this.selectionRing.material.color.set(t.selection);
    this.brushRing.material.color.set(t.selection);
    // GridHelper bakes its colours into the geometry: rebuild it (theme changes are rare).
    if (this.helperGrid) {
      this.scene.remove(this.helperGrid);
      this.helperGrid.dispose();
      this.helperGrid = undefined;
    }
    if (!this.atlas) {
      this.helperGrid = new GridHelper(200, 40, t.gridMajor, t.gridMinor);
      this.helperGrid.position.y = 0.01;
      this.scene.add(this.helperGrid);
    }
    this.atlas?.applyTheme(t);
    this.beliefAtlas?.applyTheme(t);
    this.sensorOverlay?.applyTheme(t);
    this.stagesOverlay?.applyTheme(t);
    this.sandboxOverlay?.applyTheme(t);
    this.drawZones();
    this.paintAgents();
  }

  /**
   * The loaded run's grid (or undefined for the F0 placeholder): builds the atlas pages, draws the zones,
   * frames the camera on the map, and clears paths of the previous run.
   */
  setGrid(spec: GridSpec | undefined): void {
    this.setBeliefLayer(undefined);
    this.setRays(undefined, undefined);
    this.setTopologyOverlay(undefined, undefined);
    this.atlas?.dispose();
    if (this.atlas) this.scene.remove(this.atlas.group);
    this.atlas = undefined;
    this.gridSpec = spec;
    this.paths.clear();
    this.selectedIndex = -1;
    if (spec) {
      this.atlas = new GridAtlas(spec.dims, spec.queue, this.tokens, this.renderer.capabilities.maxTextureSize);
      this.scene.add(this.atlas.group);
      const w = spec.dims.sizeX * spec.dims.resolutionM;
      const h = spec.dims.sizeY * spec.dims.resolutionM;
      this.controls.target.set(w / 2, 0, -h / 2);
      const d = Math.max(w, h);
      this.camera.position.set(w / 2, d * 0.9, -h / 2 + d * 0.6);
      this.camera.far = Math.max(10_000, d * 10);
      this.camera.updateProjectionMatrix();
    }
    this.groundMesh.visible = !spec;
    this.applyTheme(this.tokens);
  }

  setViewMode(mode: GridViewMode): void {
    this.atlas?.setMode(mode);
  }

  /**
   * The viewed agent's belief overlay (ADR-0027, F2): the queue its chunks arrive in, or `undefined` to release it. The
   * previous agent's pages are disposed first, so one belief atlas is in memory at a time; the new one starts all
   * unknown and fills from the queue within the frame's shared upload budget.
   */
  setBeliefLayer(queue: ChunkQueue | undefined): void {
    if (this.beliefAtlas) {
      this.scene.remove(this.beliefAtlas.group);
      this.beliefAtlas.dispose();
      this.beliefAtlas = undefined;
    }
    const atlas = this.atlas;
    if (queue && atlas && this.gridSpec) {
      this.beliefAtlas = new BeliefAtlas(this.gridSpec.dims, queue, this.tokens, this.renderer.capabilities.maxTextureSize, (p) => atlas.pageTexture(p));
      this.scene.add(this.beliefAtlas.group);
    }
    this.applyBeliefMode();
  }

  private overlay(): SensorOverlay {
    if (!this.sensorOverlay) {
      this.sensorOverlay = new SensorOverlay(this.tokens);
      this.scene.add(this.sensorOverlay.group);
    }
    return this.sensorOverlay;
  }

  /** The viewed agent's lidar rays as segments (x0, y0, x1, y1) and hit flags; `undefined` clears them. */
  setRays(segments: Float32Array | undefined, hit: Uint8Array | undefined): void {
    if (segments === undefined && !this.sensorOverlay) return;
    this.overlay().setRays(segments, hit);
  }

  /** The viewed agent's regions and frontier groups (ADR-0039 layer); `undefined` clears them. */
  setTopologyOverlay(regions: Float32Array | undefined, frontiers: Float32Array | undefined): void {
    if (regions === undefined && frontiers === undefined && !this.sensorOverlay) return;
    this.overlay().setTopology(regions, frontiers);
  }

  /** What exploration is doing for the viewed agent (ADR-0040): the area of its iteration and its marked targets; `undefined` clears them. */
  setExploration(view: ExplorationView | undefined): void {
    if (view === undefined && !this.sensorOverlay) return;
    this.overlay().setExploration(view);
  }

  /** The stages of a planning query (coarse path dashed, legs solid with numbered joints); `undefined` clears them. */
  setStages(lines: readonly StageLine[] | undefined): void {
    if (lines === undefined && !this.stagesOverlay) return;
    if (!this.stagesOverlay) {
      this.stagesOverlay = new StagesOverlay(this.tokens, "run");
      this.scene.add(this.stagesOverlay.group);
    }
    this.stagesOverlay.setStages(lines);
  }

  /** The researcher's Strategy test result, in a tone of its own; `undefined` clears it. */
  setSandboxStages(lines: readonly StageLine[] | undefined): void {
    if (lines === undefined && !this.sandboxOverlay) return;
    if (!this.sandboxOverlay) {
      this.sandboxOverlay = new StagesOverlay(this.tokens, "sandbox");
      this.scene.add(this.sandboxOverlay.group);
    }
    this.sandboxOverlay.setStages(lines);
  }

  /** What the overlays draw now (diagnostics and e2e): sensors, then the stages of the selected query and of the sandbox. */
  overlayCounts(): {
    rays: number;
    regions: number;
    frontiers: number;
    markedFrontiers: number;
    exploration: { area: number; temporary: number; permanent: number };
    stages: { coarseDashes: number; legs: number; legSegments: number; joints: number; labels: number };
    sandbox: { coarseDashes: number; legs: number; legSegments: number; joints: number; labels: number };
  } {
    const none = { coarseDashes: 0, legs: 0, legSegments: 0, joints: 0, labels: 0 };
    return {
      ...(this.sensorOverlay?.counts() ?? { rays: 0, regions: 0, frontiers: 0, markedFrontiers: 0, exploration: { area: 0, temporary: 0, permanent: 0 } }),
      stages: this.stagesOverlay?.counts() ?? none,
      sandbox: this.sandboxOverlay?.counts() ?? none,
    };
  }

  /** `truth` shows the ground-truth atlas; `belief` the agent's map; `difference` the researcher-only comparison. */
  setBeliefMode(mode: "truth" | BeliefViewMode): void {
    this.beliefMode = mode;
    this.applyBeliefMode();
  }

  private applyBeliefMode(): void {
    const shown = this.beliefAtlas !== undefined && this.beliefMode !== "truth";
    if (this.beliefAtlas) {
      this.beliefAtlas.group.visible = shown;
      if (this.beliefMode !== "truth") this.beliefAtlas.setMode(this.beliefMode);
    }
    this.atlas?.setVisible(!shown);
  }

  /** Replaces the drawn zones without rebuilding the atlas (scenario editor). */
  setZones(zones: GridSpec["zones"]): void {
    if (!this.gridSpec) return;
    this.gridSpec = { ...this.gridSpec, zones };
    this.drawZones();
  }

  /**
   * Edit mode (scenario editor): left-button drags go to `onEditPointer` with the ground point under the
   * pointer, instead of rotating the camera; the right button still pans and the wheel zooms.
   */
  setEditMode(on: boolean): void {
    this.editMode = on;
    this.controls.mouseButtons.LEFT = on ? null : MOUSE.ROTATE;
    if (!on) this.setBrushCursor(undefined);
  }

  /** A ring at the brush position (sim metres), or none. Called on pointer moves, not per frame. */
  setBrushCursor(at: { readonly xM: number; readonly yM: number; readonly radiusM: number } | undefined): void {
    this.brushRing.visible = at !== undefined;
    if (!at) return;
    this.brushRing.position.set(at.xM, 0.05, -at.yM);
    this.brushRing.scale.setScalar(Math.max(0.05, at.radiusM));
  }

  /** Camera straight above the map centre, the whole map in view with a 5 % margin (editing view). */
  viewTopDown(): void {
    const g = this.gridSpec;
    if (!g) return;
    this.fit();
    const w = g.dims.sizeX * g.dims.resolutionM;
    const h = g.dims.sizeY * g.dims.resolutionM;
    const halfFov = (this.camera.fov * Math.PI) / 360;
    // Height at which the map's height, or its width at this aspect ratio, fills the view.
    const d = (1.05 * Math.max(h, w / this.camera.aspect)) / 2 / Math.tan(halfFov);
    this.controls.target.set(w / 2, 0, -h / 2);
    // A tiny offset keeps OrbitControls' up vector well defined.
    this.camera.position.set(w / 2, d, -h / 2 + 0.001);
    this.controls.update();
  }

  /** Ground point (sim metres) under a viewport point, if the ray hits the ground plane. */
  groundAt(clientX: number, clientY: number): { xM: number; yM: number } | undefined {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    if (!this.raycaster.ray.intersectPlane(this.groundPlane, this.hit)) return undefined;
    return { xM: this.hit.x, yM: -this.hit.z };
  }

  /** Entity IDs by instance index (on change only): each agent's colour is derived from its ID once. */
  setEntityIds(ids: readonly string[], airborneKinds?: readonly boolean[]): void {
    if (airborneKinds) this.airborne = airborneKinds;
    if (ids.length === this.entityIds.length && ids.every((id, i) => id === this.entityIds[i])) return;
    this.entityIds = ids;
    this.selectedIndex = -1;
    this.rebuildLabels();
    this.paintAgents();
  }

  /** Planned path of an agent (sim metres), set when its latest plan changes. */
  setPlannedPath(agentId: string, waypoints: readonly (readonly [number, number])[]): void {
    this.paths.setPlanned(agentId, waypoints);
  }

  /**
   * Executed path of an agent from simulation state (x, y, z per point, with its replace version): appends the
   * points not drawn yet, or rebuilds the trail after a replace. Called when the worker sends points (≤ 10 Hz),
   * never per frame.
   */
  setExecutedPath(agentId: string, path: ExecutedPathView): void {
    this.paths.setExecuted(agentId, path);
  }

  /** Highlights the selected agent (or none). */
  setSelection(agentId: string | undefined): void {
    this.selectedIndex = agentId === undefined ? -1 : this.entityIds.indexOf(agentId);
  }

  private agentColor(id: string): string {
    return this.tokens.agent[agentColorIndex(id)] ?? this.tokens.selection;
  }

  private paintAgents(): void {
    const n = Math.min(MAX_INSTANCES, this.entityIds.length);
    for (let i = 0; i < n; i++) {
      const id = this.entityIds[i] ?? "";
      const c = this.agentColor(id);
      this.tmpColor.set(c);
      this.agents.setColorAt(i, this.tmpColor);
      this.paths.ensure(id, c);
      const swatch = this.labelObjects[i]?.element.firstElementChild as HTMLElement | null | undefined;
      if (swatch) swatch.style.backgroundColor = c;
    }
    if (this.agents.instanceColor) this.agents.instanceColor.needsUpdate = true;
  }

  /** One DOM label per agent: a colour swatch and the ID text (colour is never the only signal). */
  private rebuildLabels(): void {
    for (const o of this.labelObjects) {
      o.element.remove();
      this.labelGroup.remove(o);
    }
    this.labelObjects = this.entityIds.slice(0, MAX_INSTANCES).map((id) => {
      const el = document.createElement("span");
      el.className = "agent-label mono";
      el.dataset["agent"] = id;
      const swatch = document.createElement("span");
      swatch.className = "agent-swatch";
      el.append(swatch, document.createTextNode(id));
      const o = new CSS2DObject(el);
      o.center.set(0, 1.4);
      this.labelGroup.add(o);
      return o;
    });
  }

  private drawZones(): void {
    for (const c of [...this.zones.children]) {
      const l = c as LineLoop<BufferGeometry, LineBasicMaterial>;
      l.geometry.dispose();
      l.material.dispose();
    }
    this.zones.clear();
    for (const z of this.gridSpec?.zones ?? []) {
      const pts = new Float32Array((z.polygon.length / 2) * 3);
      for (let k = 0; k * 2 < z.polygon.length; k++) pts.set([z.polygon[k * 2] ?? 0, 0.03, -(z.polygon[k * 2 + 1] ?? 0)], k * 3);
      const geom = new BufferGeometry();
      geom.setAttribute("position", new BufferAttribute(pts, 3));
      const loop = new LineLoop(geom, new LineBasicMaterial({ color: this.tokens.zone }));
      loop.name = `zone:${z.id}`;
      this.zones.add(loop);
    }
  }

  start(): void {
    if (this.raf !== 0) return;
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      this.frame(now);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  dispose(): void {
    this.stop();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener("pointerdown", this.onPointerDown);
    canvas.removeEventListener("pointermove", this.onPointerMove);
    canvas.removeEventListener("pointerup", this.onPointerUp);
    this.resize.disconnect();
    this.controls.dispose();
    this.helperGrid?.dispose();
    this.sensorOverlay?.dispose();
    this.stagesOverlay?.dispose();
    this.sandboxOverlay?.dispose();
    this.beliefAtlas?.dispose();
    this.atlas?.dispose();
    this.paths.clear();
    this.renderer.dispose();
    canvas.remove();
    this.labels.domElement.remove();
  }

  private frame(now: number): void {
    const t0 = performance.now();
    if (!Number.isNaN(this.lastFrameAt)) this.frameIntervalMs.add(now - this.lastFrameAt);
    this.lastFrameAt = now;

    // One budget for both atlases (ADR-0027: ≤ 16 chunk uploads per frame): the ground truth first, the belief overlay
    // with what is left, so a belief catching up never costs the frame more than the F1 atlas upload did.
    const uploaded = this.atlas?.upload(this.renderer) ?? 0;
    this.beliefAtlas?.upload(this.renderer, CHUNK_UPLOADS_PER_FRAME - uploaded);
    const poses = this.source.sample(t0);
    const n = Math.min(MAX_INSTANCES, this.source.entityCount);
    let stalks = 0;
    for (let i = 0; i < n; i++) {
      const o = i * POSE_STRIDE;
      const x = poses[o] ?? 0;
      const y = poses[o + 1] ?? 0;
      const z = poses[o + 2] ?? 0;
      // Sim frame: x/y on the ground, z up → Three: x, z(up)→y, y→-z.
      this.dummy.position.set(x, z + 0.75, -y);
      this.dummy.rotation.set(0, poses[o + 3] ?? 0, 0);
      this.dummy.updateMatrix();
      this.agents.setMatrixAt(i, this.dummy.matrix);
      const label = this.labelObjects[i];
      if (label) label.position.set(x, z + 1.6, -y);
      if (this.airborne[i] && z > 0.05) {
        const s = stalks * 6;
        const sp = this.stalkPos;
        sp[s] = x;
        sp[s + 1] = 0.02;
        sp[s + 2] = -y;
        sp[s + 3] = x;
        sp[s + 4] = z;
        sp[s + 5] = -y;
        stalks++;
      }
      if (i === this.selectedIndex) this.selectionRing.position.set(x, 0.04, -y);
    }
    this.selectionRing.visible = this.selectedIndex >= 0 && this.selectedIndex < n;
    if (stalks > 0) (this.stalks.geometry.getAttribute("position") as BufferAttribute).needsUpdate = true;
    this.stalks.geometry.setDrawRange(0, stalks * 2);
    this.agents.count = n;
    this.agents.instanceMatrix.needsUpdate = true;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
    const workMs = performance.now() - t0;
    this.frameWorkMs.add(workMs);
    this.onFrame?.(poses, t0, workMs);
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    this.downAt = { x: e.clientX, y: e.clientY };
    if (this.editMode && e.button === 0) {
      this.editing = true;
      this.renderer.domElement.setPointerCapture(e.pointerId);
      this.emitEdit("down", e);
    }
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (this.editMode) this.emitEdit(this.editing ? "drag" : "hover", e);
  };

  private emitEdit(phase: EditPointerPhase, e: PointerEvent): void {
    const p = this.groundAt(e.clientX, e.clientY);
    if (p) this.onEditPointer?.(phase, p.xM, p.yM, e);
  }

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (this.editing) {
      this.editing = false;
      this.emitEdit("up", e);
    }
    const d = this.downAt;
    this.downAt = undefined;
    if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_SLOP_PX || !this.onPick) return;
    const p = this.pickAt(e.clientX, e.clientY);
    if (p) this.onPick(p);
  };

  /** What lies under a viewport point: an agent first, else the ground cell (scenario runs only). */
  pickAt(clientX: number, clientY: number): ScenePick | undefined {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    this.agents.computeBoundingSphere(); // on pick only: instances moved since the last one
    const hits = this.raycaster.intersectObject(this.agents, false);
    const first = hits[0];
    if (first?.instanceId !== undefined) {
      const id = this.entityIds[first.instanceId];
      if (id !== undefined) return { kind: "agent", id };
    }
    const g = this.gridSpec;
    if (!g || !this.raycaster.ray.intersectPlane(this.groundPlane, this.hit)) return undefined;
    const xM = this.hit.x;
    const yM = -this.hit.z;
    const i = Math.floor(xM / g.dims.resolutionM);
    const j = Math.floor(yM / g.dims.resolutionM);
    if (i < 0 || j < 0 || i >= g.dims.sizeX || j >= g.dims.sizeY) return undefined;
    return { kind: "cell", i, j, xM, yM };
  }

  /** Viewport position of an agent's body (e2e probe and overlays), or undefined if unknown. */
  screenOf(agentId: string): { x: number; y: number } | undefined {
    const i = this.entityIds.indexOf(agentId);
    if (i < 0) return undefined;
    const poses = this.source.sample(performance.now());
    const o = i * POSE_STRIDE;
    this.projected.set(poses[o] ?? 0, (poses[o + 2] ?? 0) + 0.75, -(poses[o + 1] ?? 0)).project(this.camera);
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((this.projected.x + 1) / 2) * r.width, y: r.top + ((1 - this.projected.y) / 2) * r.height };
  }

  /** Viewport position of a ground point in sim metres. */
  screenOfGround(xM: number, yM: number): { x: number; y: number } {
    this.projected.set(xM, 0, -yM).project(this.camera);
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((this.projected.x + 1) / 2) * r.width, y: r.top + ((1 - this.projected.y) / 2) * r.height };
  }

  /** Diagnostics (HUD, e2e probe): atlas pages and uploads, path vertex counts. */
  stats(): { pages: number; chunksUploaded: number; chunksPending: number; belief: { pages: number; chunksUploaded: number; chunksPending: number } } {
    return {
      pages: this.atlas?.layout.pageCount ?? 0,
      chunksUploaded: this.atlas?.uploadedChunks ?? 0,
      chunksPending: this.gridSpec?.queue.size ?? 0,
      belief: { pages: this.beliefAtlas?.pageCount ?? 0, chunksUploaded: this.beliefAtlas?.uploadedChunks ?? 0, chunksPending: this.beliefAtlas?.pendingChunks ?? 0 },
    };
  }

  /** Believed state of a cell as drawn (0 unknown, 1 free, 2 occupied), or undefined without a belief overlay. */
  beliefCell(i: number, j: number): number | undefined {
    return this.beliefAtlas?.state(i, j);
  }

  pathCounts(agentId: string): { planned: number; executed: number } {
    return this.paths.counts(agentId);
  }

  /** Cell values from the atlas' CPU copy (cell inspector). */
  cell(i: number, j: number): ReturnType<GridAtlas["cell"]> {
    return this.atlas?.cell(i, j);
  }

  private fit(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}

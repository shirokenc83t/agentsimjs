import { DataTexture, Group, Mesh, NearestFilter, PlaneGeometry, RGBAFormat, ShaderMaterial, UnsignedByteType, Vector2, type WebGLRenderer } from "three";
import type { SceneTokens } from "../theme/tokens.ts";
import { AtlasLayout, type ChunkQueue, type GridDims } from "./atlas-layout.ts";

/** What the belief overlay shows: the agent's own map, or the researcher-only comparison with the ground truth. */
export type BeliefViewMode = "belief" | "difference";

/** Believed state of a cell as it travels from the worker (one byte per cell): the belief map's own codes. */
export const BELIEF_UNKNOWN_CODE = 0;
export const BELIEF_FREE_CODE = 1;
export const BELIEF_OCCUPIED_CODE = 2;

const VERTEX = /* glsl */ `
uniform vec2 uvScale;
uniform float pageCells;
varying vec2 vUv;
varying vec2 vCell;
void main() {
  vUv = uv * uvScale;
  vCell = vUv * pageCells;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// Belief page: R = believed state (0 unknown, 1 free, 2 occupied). Ground-truth page of the same index (ADR-0027
// layout, same dims): R = occupancy (0 free, 1 blocked, 255 not received yet). The difference mode compares them on
// the GPU, so no ground-truth data travels anywhere for it. Mismatches are hatched, never colour alone.
const FRAGMENT = /* glsl */ `
uniform sampler2D map;
uniform sampler2D truthMap;
uniform int mode;
uniform vec3 cUnknown, cFree, cOccupied, cPhantom, cFalseFree;
varying vec2 vUv;
varying vec2 vCell;
void main() {
  float cls = floor(texture2D(map, vUv).r * 255.0 + 0.5);
  vec3 c;
  if (cls < 0.5) {
    c = cUnknown;
  } else if (mode == 0) {
    c = cls < 1.5 ? cFree : cOccupied;
  } else {
    float truth = floor(texture2D(truthMap, vUv).r * 255.0 + 0.5);
    bool believedOccupied = cls > 1.5;
    bool trulyOccupied = truth > 0.5 && truth < 200.0;
    if (truth > 200.0 || believedOccupied == trulyOccupied) {
      c = believedOccupied ? cOccupied : cFree;
    } else if (believedOccupied) {
      // Believed occupied, truly free: diagonal hatching.
      c = fract((vCell.x + vCell.y) * 2.0) < 0.5 ? cPhantom : cFree;
    } else {
      // Believed free, truly blocked: cross hatching (the dangerous error).
      c = (fract(vCell.x * 2.0) < 0.5 || fract(vCell.y * 2.0) < 0.5) ? cFalseFree : cOccupied;
    }
  }
  gl_FragColor = vec4(c, 1.0);
}`;

/** Height of the belief pages above the ground atlas (m): no z-fight, under paths and agents. */
const BELIEF_Y = 0.02;

/**
 * The viewed agent's belief map as atlas pages (ADR-0027: the F2 overlay uses the same scheme, its own pages per
 * viewed agent). Same layout as the ground-truth atlas, so a page of one lines up with the page of the other. One
 * byte per cell arrives from the worker and is expanded to texels here, a chunk at a time, inside the shared
 * per-frame upload budget. At most one belief atlas exists at a time (the previous agent's is disposed first).
 */
export class BeliefAtlas {
  readonly group = new Group();
  readonly layout: AtlasLayout;
  private readonly pages: { tex: DataTexture; mesh: Mesh<PlaneGeometry, ShaderMaterial> }[] = [];
  private readonly staging: DataTexture;
  private readonly texels: Uint8Array;
  private readonly dst = new Vector2();
  private uploaded = 0;

  constructor(
    dims: GridDims,
    private readonly queue: ChunkQueue,
    tokens: SceneTokens,
    maxTextureSize: number,
    /** The ground-truth page textures, by page index (difference mode samples them). */
    truthPage: (page: number) => DataTexture | undefined,
  ) {
    this.layout = new AtlasLayout(dims, maxTextureSize);
    const P = this.layout.pageCells;
    const res = dims.resolutionM;
    for (let p = 0; p < this.layout.pageCount; p++) {
      const tex = new DataTexture(new Uint8Array(P * P * 4), P, P, RGBAFormat, UnsignedByteType); // all unknown
      tex.magFilter = NearestFilter;
      tex.minFilter = NearestFilter;
      tex.generateMipmaps = false;
      tex.flipY = false;
      tex.needsUpdate = true;
      const cov = this.layout.coveredCells(p);
      const material = new ShaderMaterial({
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        uniforms: {
          map: { value: tex },
          truthMap: { value: truthPage(p) ?? tex },
          mode: { value: 0 },
          uvScale: { value: new Vector2(cov.w / P, cov.h / P) },
          pageCells: { value: P },
          cUnknown: { value: null },
          cFree: { value: null },
          cOccupied: { value: null },
          cPhantom: { value: null },
          cFalseFree: { value: null },
        },
      });
      const mesh = new Mesh(new PlaneGeometry(cov.w * res, cov.h * res), material);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set((cov.x0 + cov.w / 2) * res, BELIEF_Y, -(cov.y0 + cov.h / 2) * res);
      this.group.add(mesh);
      this.pages.push({ tex, mesh });
    }
    const n = dims.chunkSize;
    this.texels = new Uint8Array(n * n * 4);
    this.staging = new DataTexture(this.texels, n, n, RGBAFormat, UnsignedByteType);
    this.staging.flipY = false;
    this.applyTheme(tokens);
  }

  /** Uploads up to `budget` queued chunks (what the ground-truth atlas left of the frame's budget); returns how many. */
  upload(renderer: WebGLRenderer, budget: number): number {
    if (budget <= 0) return 0;
    const n = this.layout.dims.chunkSize;
    const P = this.layout.pageCells;
    return this.queue.take(budget, (ci, cj, classes) => {
      const at = this.layout.locate(ci, cj);
      const page = this.pages[at.page];
      if (!page) return;
      const pageData = page.tex.image.data as Uint8Array;
      for (let row = 0; row < n; row++) {
        for (let col = 0; col < n; col++) {
          const v = classes[row * n + col] ?? 0;
          this.texels[(row * n + col) * 4] = v;
          pageData[((at.y + row) * P + at.x + col) * 4] = v;
        }
      }
      this.dst.set(at.x, at.y);
      renderer.copyTextureToTexture(this.staging, page.tex, null, this.dst);
      this.uploaded++;
    });
  }

  get uploadedChunks(): number {
    return this.uploaded;
  }

  get pendingChunks(): number {
    return this.queue.size;
  }

  get pageCount(): number {
    return this.layout.pageCount;
  }

  /** Believed state of a cell from the CPU page copy (0 unknown, 1 free, 2 occupied), or undefined outside the grid. */
  state(i: number, j: number): number | undefined {
    const d = this.layout.dims;
    if (i < 0 || j < 0 || i >= d.sizeX || j >= d.sizeY) return undefined;
    const P = this.layout.pageCells;
    const px = Math.floor(i / P);
    const py = Math.floor(j / P);
    const page = this.pages[py * this.layout.pagesX + px];
    return page ? (page.tex.image.data as Uint8Array)[((j - py * P) * P + (i - px * P)) * 4] : undefined;
  }

  setMode(mode: BeliefViewMode): void {
    for (const p of this.pages) {
      const u = p.mesh.material.uniforms["mode"];
      if (u) u.value = mode === "difference" ? 1 : 0;
    }
  }

  applyTheme(t: SceneTokens): void {
    const colors: Record<string, string> = { cUnknown: t.beliefUnknown, cFree: t.beliefFree, cOccupied: t.beliefOccupied, cPhantom: t.diffPhantom, cFalseFree: t.diffFalseFree };
    for (const p of this.pages) {
      for (const [name, hex] of Object.entries(colors)) {
        const u = p.mesh.material.uniforms[name];
        if (u) u.value = colorVec(hex);
      }
    }
  }

  dispose(): void {
    for (const p of this.pages) {
      p.tex.dispose();
      p.mesh.geometry.dispose();
      p.mesh.material.dispose();
    }
    this.staging.dispose();
    this.queue.clear();
  }
}

function colorVec(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

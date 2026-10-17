import {
  DataTexture,
  Group,
  Mesh,
  NearestFilter,
  PlaneGeometry,
  RGBAFormat,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
  type WebGLRenderer,
} from "three";
import type { SceneTokens } from "../theme/tokens.ts";
import { AtlasLayout, CHUNK_UPLOADS_PER_FRAME, type ChunkQueue, type GridDims } from "./atlas-layout.ts";

/** Grid view modes of the atlas shader. */
export type GridViewMode = "occupancy" | "terrain" | "height";
const MODE_INDEX: Readonly<Record<GridViewMode, number>> = { occupancy: 0, terrain: 1, height: 2 };

/** Occupancy byte of texels whose chunk has not arrived yet (occupancy itself is 0 or 1). */
const UNLOADED = 255;
/** Height that maps to the top of the height ramp (100 m). */
const HEIGHT_RAMP_DM = 1000;

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

// R occupancy, G terrain cost, B + A height (dm). Nearest filtering: one texel per cell.
const FRAGMENT = /* glsl */ `
uniform sampler2D map;
uniform int mode;
uniform float heightRampDm;
uniform vec3 cFree, cBlocked, cUnloaded, cTerrainLo, cTerrainHi, cImpassable, cHeightLo, cHeightHi, cUnknownHeight;
varying vec2 vUv;
varying vec2 vCell;
void main() {
  vec4 t = texture2D(map, vUv);
  float occ = floor(t.r * 255.0 + 0.5);
  float terrain = floor(t.g * 255.0 + 0.5);
  float h = floor(t.b * 255.0 + 0.5) + 256.0 * floor(t.a * 255.0 + 0.5);
  vec3 c;
  if (occ > 200.0) {
    c = cUnloaded;
  } else if (mode == 0) {
    c = occ > 0.5 ? cBlocked : (terrain < 0.5 ? cImpassable : cFree);
  } else if (mode == 1) {
    c = terrain < 0.5 ? cImpassable : mix(cTerrainLo, cTerrainHi, clamp((terrain - 1.0) / 254.0, 0.0, 1.0));
    if (occ > 0.5) c = cBlocked;
  } else {
    c = mix(cHeightLo, cHeightHi, clamp(h / heightRampDm, 0.0, 1.0));
    // Occupied with unknown height (height 0): diagonal hatching, never colour alone (ADR-0012/0025).
    if (occ > 0.5 && h < 0.5) c = fract((vCell.x + vCell.y) * 2.0) < 0.5 ? cUnknownHeight : cBlocked;
  }
  gl_FragColor = vec4(c, 1.0);
}`;

/**
 * The grid as atlas pages (ADR-0027): one RGBA8 texture and one mesh per page (one draw call each), updated
 * per chunk with sub-image copies, at most `CHUNK_UPLOADS_PER_FRAME` per frame. Page buffers stay on the
 * CPU too (cell inspection). Sim frame: x east, y north → Three: x, −z.
 */
export class GridAtlas {
  readonly group = new Group();
  readonly layout: AtlasLayout;
  private readonly pages: { tex: DataTexture; mesh: Mesh<PlaneGeometry, ShaderMaterial> }[] = [];
  private readonly staging: DataTexture;
  private readonly dst = new Vector2();
  private uploaded = 0;

  constructor(
    dims: GridDims,
    private readonly queue: ChunkQueue,
    tokens: SceneTokens,
    maxTextureSize: number,
  ) {
    this.layout = new AtlasLayout(dims, maxTextureSize);
    const P = this.layout.pageCells;
    const res = dims.resolutionM;
    for (let p = 0; p < this.layout.pageCount; p++) {
      const data = new Uint8Array(P * P * 4);
      for (let k = 0; k < data.length; k += 4) data[k] = UNLOADED;
      const tex = new DataTexture(data, P, P, RGBAFormat, UnsignedByteType);
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
          mode: { value: 0 },
          heightRampDm: { value: HEIGHT_RAMP_DM },
          uvScale: { value: new Vector2(cov.w / P, cov.h / P) },
          pageCells: { value: P },
          cFree: { value: null },
          cBlocked: { value: null },
          cUnloaded: { value: null },
          cTerrainLo: { value: null },
          cTerrainHi: { value: null },
          cImpassable: { value: null },
          cHeightLo: { value: null },
          cHeightHi: { value: null },
          cUnknownHeight: { value: null },
        },
      });
      const mesh = new Mesh(new PlaneGeometry(cov.w * res, cov.h * res), material);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set((cov.x0 + cov.w / 2) * res, 0, -(cov.y0 + cov.h / 2) * res);
      this.group.add(mesh);
      this.pages.push({ tex, mesh });
    }
    const n = dims.chunkSize;
    this.staging = new DataTexture(new Uint8Array(n * n * 4), n, n, RGBAFormat, UnsignedByteType);
    this.staging.flipY = false;
    this.applyTheme(tokens);
  }

  /** Uploads up to the per-frame budget (default: the whole of it) of queued chunks; returns how many were uploaded. */
  upload(renderer: WebGLRenderer, budget = CHUNK_UPLOADS_PER_FRAME): number {
    const n = this.layout.dims.chunkSize;
    const P = this.layout.pageCells;
    return this.queue.take(budget, (ci, cj, data) => {
      const at = this.layout.locate(ci, cj);
      const page = this.pages[at.page];
      if (!page) return;
      // CPU copy of the page (cell inspection), then the GPU sub-image (never the whole page).
      const pageData = page.tex.image.data as Uint8Array;
      for (let row = 0; row < n; row++) pageData.set(data.subarray(row * n * 4, (row + 1) * n * 4), ((at.y + row) * P + at.x) * 4);
      (this.staging.image as { data: Uint8Array }).data = data;
      this.dst.set(at.x, at.y);
      renderer.copyTextureToTexture(this.staging, page.tex, null, this.dst);
      this.uploaded++;
    });
  }

  /** The texture of a page (the belief overlay compares against it on the GPU). */
  pageTexture(page: number): DataTexture | undefined {
    return this.pages[page]?.tex;
  }

  /** Shows or hides the ground-truth pages (the belief view replaces them); the textures keep being updated. */
  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  /** Chunks uploaded since the atlas was created (diagnostics and e2e). */
  get uploadedChunks(): number {
    return this.uploaded;
  }

  /** Raw texel (R, G, B, A) of a cell from the CPU page copy, or undefined outside the grid. */
  cell(i: number, j: number): { occupancy: number; terrainCost: number; heightDm: number; loaded: boolean } | undefined {
    const d = this.layout.dims;
    if (i < 0 || j < 0 || i >= d.sizeX || j >= d.sizeY) return undefined;
    const P = this.layout.pageCells;
    const px = Math.floor(i / P);
    const py = Math.floor(j / P);
    const page = this.pages[py * this.layout.pagesX + px];
    if (!page) return undefined;
    const data = page.tex.image.data as Uint8Array;
    const k = ((j - py * P) * P + (i - px * P)) * 4;
    const occ = data[k] ?? UNLOADED;
    return { occupancy: occ, terrainCost: data[k + 1] ?? 0, heightDm: (data[k + 2] ?? 0) | ((data[k + 3] ?? 0) << 8), loaded: occ !== UNLOADED };
  }

  setMode(mode: GridViewMode): void {
    for (const p of this.pages) {
      const u = p.mesh.material.uniforms["mode"];
      if (u) u.value = MODE_INDEX[mode];
    }
  }

  /** Token snapshot on theme change (outside the frame loop, ADR-0032 §2). */
  applyTheme(t: SceneTokens): void {
    const colors: Record<string, string> = {
      cFree: t.cellFree,
      cBlocked: t.cellBlocked,
      cUnloaded: t.cellUnloaded,
      cTerrainLo: t.terrainLo,
      cTerrainHi: t.terrainHi,
      cImpassable: t.impassable,
      cHeightLo: t.heightLo,
      cHeightHi: t.heightHi,
      cUnknownHeight: t.unknownHeight,
    };
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

/** `#rrggbb` → linear-agnostic RGB triple in [0, 1] for shader uniforms (sRGB values, no conversion). */
function colorVec(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

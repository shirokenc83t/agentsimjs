// Builds the "AgentSim Glyphs" font: the few symbols of the chrome (ADR-0042 §4) drawn as outlines, 600 units wide like JetBrains Mono, so no
// symbol falls back to a system font. The JetBrains Mono files we serve (the Latin subset of @fontsource) do not hold them and the full font is not a
// dependency we have; a font of straight-edged outlines needs none. `node tools/fonts/make-glyph-font.mjs` writes apps/lab/public/fonts/agentsim-glyphs.ttf;
// tools/fonts/glyph-font.test.ts checks the committed file against this script.
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UPM = 1000;
const ADVANCE = 600;

/** Regular polygon points (n vertices) around (cx, cy), starting at the top; clockwise unless `ccw`. */
function circle(cx, cy, r, n, ccw = false) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = Math.PI / 2 - (2 * Math.PI * i) / n;
    pts.push([Math.round(cx + r * Math.cos(a)), Math.round(cy + r * Math.sin(a))]);
  }
  return ccw ? pts.reverse() : pts;
}

/** A bar from (x1, y1) to (x2, y2) of width w, as a rectangle. */
function bar(x1, y1, x2, y2, w) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  const nx = (-dy / len) * (w / 2);
  const ny = (dx / len) * (w / 2);
  return [
    [Math.round(x1 + nx), Math.round(y1 + ny)],
    [Math.round(x2 + nx), Math.round(y2 + ny)],
    [Math.round(x2 - nx), Math.round(y2 - ny)],
    [Math.round(x1 - nx), Math.round(y1 - ny)],
  ];
}

/** Signed area (y up): positive is counter-clockwise. */
function area(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/** TrueType fills the inside of a clockwise contour and leaves a counter-clockwise one empty (a hole). */
const solid = (pts) => (area(pts) > 0 ? [...pts].reverse() : pts);
const hole = (pts) => (area(pts) < 0 ? [...pts].reverse() : pts);

const CX = 300;
const CY = 350;
const MID = 365;
const diamond = (r) => [
  [CX, CY - r],
  [CX - r * 0.96, CY],
  [CX, CY + r],
  [CX + r * 0.96, CY],
].map(([x, y]) => [Math.round(x), Math.round(y)]);

/** The glyphs: code point → name and contours. All within x 40..560, y -150..800. */
export const GLYPHS = [
  { code: 0x2715, name: "multiplication-x", contours: [solid(bar(57, 122, 543, 608, 105)), solid(bar(57, 608, 543, 122, 105))] },
  { code: 0x25b2, name: "triangle-up", contours: [solid([[20, 0], [300, 560], [580, 0]])] },
  { code: 0x25bc, name: "triangle-down", contours: [solid([[20, 560], [580, 560], [300, 0]])] },
  { code: 0x25b7, name: "triangle-right-outline", contours: [solid([[60, 85], [60, 645], [580, 365]]), hole([[155, 244], [380, 365], [155, 486]])] },
  { code: 0x25b6, name: "triangle-right", contours: [solid([[75, 105], [75, 625], [525, 365]])] },
  { code: 0x275a, name: "heavy-bar", contours: [solid([[190, 20], [190, 680], [410, 680], [410, 20]])] },
  { code: 0x25cf, name: "disc", contours: [solid(circle(CX, CY, 300, 32))] },
  { code: 0x25cb, name: "ring", contours: [solid(circle(CX, CY, 300, 32)), hole(circle(CX, CY, 205, 32))] },
  {
    code: 0x25f7,
    name: "ring-upper-right-quadrant",
    // The ring (outer diameter 520, stroke 90, centred on half cap height), and the upper right quarter of what it encloses, a solid wedge to the centre.
    contours: [
      solid(circle(CX, MID, 260, 32)),
      hole(circle(CX, MID, 170, 32)),
      solid([[CX, MID], [CX, MID + 170], ...[1, 2, 3, 4, 5, 6].map((i) => [Math.round(CX + 170 * Math.sin((i * Math.PI) / 14)), Math.round(MID + 170 * Math.cos((i * Math.PI) / 14))]), [CX + 170, MID]]),
    ],
  },
  {
    code: 0x25d0,
    name: "circle-left-half-black",
    // The ring of the ring glyph, and the left half of what it encloses as a solid half disc: the theme control.
    contours: [
      solid(circle(CX, CY, 300, 32)),
      hole(circle(CX, CY, 205, 32)),
      solid(Array.from({ length: 17 }, (_, i) => [Math.round(CX + 205 * Math.cos(Math.PI / 2 + (Math.PI * i) / 16)), Math.round(CY + 205 * Math.sin(Math.PI / 2 + (Math.PI * i) / 16))])),
    ],
  },
  { code: 0x25ce, name: "bullseye", contours: [solid(circle(CX, CY, 300, 32)), hole(circle(CX, CY, 215, 32)), solid(circle(CX, CY, 120, 32))] },
  {
    code: 0x29c9,
    name: "two-joined-squares",
    // The back square as an outline, and the front one over its corner as an outline too (the window button of the trace graph).
    contours: [
      solid([[60, 300], [60, 640], [400, 640], [400, 300]]),
      hole([[120, 360], [120, 580], [340, 580], [340, 360]]),
      solid([[200, 90], [200, 430], [540, 430], [540, 90]]),
      hole([[260, 150], [260, 370], [480, 370], [480, 150]]),
    ],
  },
  { code: 0x25c6, name: "diamond", contours: [solid(diamond(340))] },
  { code: 0x25c7, name: "diamond-outline", contours: [solid(diamond(340)), hole(diamond(250))] },
  { code: 0x25a0, name: "square", contours: [solid([[95, 95], [95, 635], [505, 635], [505, 95]])] },
  { code: 0x25aa, name: "small-square", contours: [solid([[170, 220], [170, 480], [430, 480], [430, 220]])] },
  { code: 0x2713, name: "check", contours: [solid(bar(60, 330, 225, 150, 110)), solid(bar(225, 150, 540, 650, 110))] },
  { code: 0x2502, name: "light-vertical", contours: [solid([[270, -150], [270, 800], [330, 800], [330, -150]])] },
];

export const GLYPH_CODEPOINTS = GLYPHS.map((g) => g.code);

const u16 = (n) => [(n >> 8) & 255, n & 255];
const i16 = (n) => u16(n & 0xffff);
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const pad4 = (bytes) => {
  const out = [...bytes];
  while (out.length % 4) out.push(0);
  return out;
};
const checksum = (bytes) => {
  let sum = 0;
  const b = pad4(bytes);
  for (let i = 0; i < b.length; i += 4) sum = (sum + (((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0)) >>> 0;
  return sum;
};
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const utf16be = (s) => [...s].flatMap((c) => u16(c.charCodeAt(0)));

/** The TrueType file as bytes. Deterministic: the same glyphs give the same bytes (no dates). */
export function buildGlyphFont() {
  // Glyph 0 is .notdef: empty.
  const glyphs = [{ code: 0, contours: [] }, ...GLYPHS];
  const glyfParts = [];
  const loca = [];
  let offset = 0;
  let xMin = 9999;
  let yMin = 9999;
  let xMax = -9999;
  let yMax = -9999;
  let maxPoints = 0;
  let maxContours = 0;
  const lsbs = [];
  for (const g of glyphs) {
    loca.push(offset);
    const pts = g.contours.flat();
    if (pts.length === 0) {
      lsbs.push(0);
      continue;
    }
    const gx0 = Math.min(...pts.map((p) => p[0]));
    const gy0 = Math.min(...pts.map((p) => p[1]));
    const gx1 = Math.max(...pts.map((p) => p[0]));
    const gy1 = Math.max(...pts.map((p) => p[1]));
    xMin = Math.min(xMin, gx0);
    yMin = Math.min(yMin, gy0);
    xMax = Math.max(xMax, gx1);
    yMax = Math.max(yMax, gy1);
    maxPoints = Math.max(maxPoints, pts.length);
    maxContours = Math.max(maxContours, g.contours.length);
    lsbs.push(gx0);
    const ends = [];
    let n = 0;
    for (const c of g.contours) {
      n += c.length;
      ends.push(n - 1);
    }
    const bytes = [...i16(g.contours.length), ...i16(gx0), ...i16(gy0), ...i16(gx1), ...i16(gy1), ...ends.flatMap(u16), ...u16(0)];
    // Every point on the curve, coordinates as 16-bit deltas.
    for (let i = 0; i < pts.length; i++) bytes.push(0x01);
    let px = 0;
    for (const p of pts) {
      bytes.push(...i16(p[0] - px));
      px = p[0];
    }
    let py = 0;
    for (const p of pts) {
      bytes.push(...i16(p[1] - py));
      py = p[1];
    }
    const padded = pad4(bytes);
    glyfParts.push(padded);
    offset += padded.length;
  }
  loca.push(offset);
  const glyf = glyfParts.flat();
  const numGlyphs = glyphs.length;

  const head = [
    ...u32(0x00010000), ...u32(0x00010000), ...u32(0), ...u32(0x5f0f3cf5), ...u16(0x0003), ...u16(UPM),
    ...u32(0), ...u32(0), ...u32(0), ...u32(0),
    ...i16(xMin), ...i16(yMin), ...i16(xMax), ...i16(yMax), ...u16(0), ...u16(8), ...i16(2), ...i16(1), ...i16(0),
  ];
  const hhea = [
    ...u32(0x00010000), ...i16(900), ...i16(-300), ...i16(0), ...u16(ADVANCE), ...i16(Math.min(...lsbs)), ...i16(0), ...i16(xMax),
    ...i16(1), ...i16(0), ...i16(0), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...i16(0), ...u16(numGlyphs),
  ];
  const maxp = [...u32(0x00010000), ...u16(numGlyphs), ...u16(maxPoints), ...u16(maxContours), ...u16(0), ...u16(0), ...u16(1), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u16(0)];
  const hmtx = glyphs.flatMap((_, i) => [...u16(ADVANCE), ...i16(lsbs[i] ?? 0)]);
  const locaBytes = loca.flatMap(u32);

  // cmap format 4, one segment per code point, then the closing 0xFFFF one.
  const codes = GLYPHS.map((g, i) => ({ code: g.code, glyph: i + 1 })).sort((a, b) => a.code - b.code);
  const segCount = codes.length + 1;
  const searchRange = 2 * 2 ** Math.floor(Math.log2(segCount));
  const sub4 = [
    ...u16(4), ...u16(16 + segCount * 8), ...u16(0), ...u16(segCount * 2), ...u16(searchRange), ...u16(Math.log2(searchRange / 2)), ...u16(segCount * 2 - searchRange),
    ...codes.flatMap((c) => u16(c.code)), ...u16(0xffff), ...u16(0),
    ...codes.flatMap((c) => u16(c.code)), ...u16(0xffff),
    ...codes.flatMap((c) => u16((c.glyph - c.code) & 0xffff)), ...u16(1),
    ...codes.flatMap(() => u16(0)), ...u16(0),
  ];
  const cmap = [...u16(0), ...u16(1), ...u16(3), ...u16(1), ...u32(12), ...sub4];

  const os2 = [
    ...u16(3), ...i16(ADVANCE), ...u16(400), ...u16(5), ...u16(0),
    ...i16(650), ...i16(600), ...i16(0), ...i16(75), ...i16(650), ...i16(600), ...i16(0), ...i16(350), ...i16(50), ...i16(260), ...i16(0),
    ...Array(10).fill(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...ascii("NONE"), ...u16(0x40), ...u16(codes[0].code), ...u16(codes.at(-1).code),
    ...i16(800), ...i16(-200), ...i16(0), ...u16(900), ...u16(300), ...u32(1), ...u32(0), ...i16(500), ...i16(730), ...u16(0), ...u16(32), ...u16(1),
  ];
  const names = [[1, "AgentSim Glyphs"], [2, "Regular"], [4, "AgentSim Glyphs"], [6, "AgentSimGlyphs-Regular"]];
  const strings = names.map(([, s]) => utf16be(s));
  let so = 0;
  const records = names.flatMap(([id], i) => {
    const r = [...u16(3), ...u16(1), ...u16(0x409), ...u16(id), ...u16(strings[i].length), ...u16(so)];
    so += strings[i].length;
    return r;
  });
  const name = [...u16(0), ...u16(names.length), ...u16(6 + names.length * 12), ...records, ...strings.flat()];
  const post = [...u32(0x00030000), ...u32(0), ...i16(-100), ...i16(50), ...u32(1), ...u32(0), ...u32(0), ...u32(0), ...u32(0)];

  const tables = { OS2: null, cmap, glyf, head, hhea, hmtx, loca: locaBytes, maxp, name, post };
  const tagged = [
    ["OS/2", os2],
    ["cmap", cmap],
    ["glyf", glyf],
    ["head", head],
    ["hhea", hhea],
    ["hmtx", hmtx],
    ["loca", locaBytes],
    ["maxp", maxp],
    ["name", name],
    ["post", post],
  ];
  void tables;
  const n = tagged.length;
  const entrySelector = Math.floor(Math.log2(n));
  const sr = 16 * 2 ** entrySelector;
  let pos = 12 + n * 16;
  const dir = [];
  const body = [];
  let headAt = 0;
  for (const [tag, bytes] of tagged) {
    if (tag === "head") headAt = pos;
    dir.push(...ascii(tag), ...u32(checksum(bytes)), ...u32(pos), ...u32(bytes.length));
    const padded = pad4(bytes);
    body.push(...padded);
    pos += padded.length;
  }
  const file = [...u32(0x00010000), ...u16(n), ...u16(sr), ...u16(entrySelector), ...u16(n * 16 - sr), ...dir, ...body];
  const adjust = (0xb1b0afba - checksum(file)) >>> 0;
  file.splice(headAt + 8, 4, ...u32(adjust));
  return Uint8Array.from(file);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "apps", "lab", "public", "fonts", "agentsim-glyphs.ttf");
  writeFileSync(out, buildGlyphFont());
  console.log(`wrote ${out}`);
}

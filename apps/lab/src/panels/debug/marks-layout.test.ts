import type { TraceRecord } from "@agentsim/trace";
import { describe, expect, it } from "vitest";
import { BIN_PX, binMarks, CHAR_PX, countLabel, GLYPH_PX, markOf } from "./marks.ts";

// The Timeline's lanes must never draw two labels or glyphs on top of each other, at any zoom and with the widest counts: what a bin draws is laid out to fit it, and a bin that has no
// room for text is a density bar. The test lays out dense lanes with flags and counts of every width, and compares the horizontal extent of everything that is text or a glyph.

const rec = (seq: number, simTime: number, kind: string, agentId: string, payload: unknown = {}) => ({ seq, simTime, kind, agentId, payload }) as unknown as TraceRecord;

describe("the labels of the Timeline's bins", () => {
  it("fit the bin whatever the count: the glyph and the count, the count alone, a compact thousands form, or none (a density bar)", () => {
    for (const n of [2, 9, 10, 35, 99, 100, 123, 999, 1000, 1234, 9999, 10_000, 99_999, 100_000, 999_999, 1_000_000, 12_345_678]) {
      const l = countLabel(n);
      if (l) expect(l.widthPx, `count ${n}`).toBeLessThanOrEqual(BIN_PX - 4);
    }
    expect(countLabel(9)).toMatchObject({ text: "×9", glyph: true });
    expect(countLabel(35)).toMatchObject({ text: "×35", glyph: false }); // the glyph would not fit beside it
    expect(countLabel(123)?.text).toBe("×123");
    expect(countLabel(1234)?.text).toBe("1.2k");
    expect(countLabel(12_345)?.text).toBe("12k");
    expect(countLabel(12_345_678)).toBeUndefined();
    // A wider bin keeps the glyph for wider counts: the rule is the width, not the digits.
    expect(countLabel(35, 48)?.glyph).toBe(true);
  });

  it("never overlap on a lane: counts, lone glyphs and flags (with their glyphs) laid out from dense marks at several zooms", () => {
    const rnd = (() => {
      let s = 12345;
      return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    })();
    const lanes = ["run", "ugv-001", "ugv-002"];
    const records: TraceRecord[] = [];
    let seq = 0;
    // Dense runs of plain marks (counts of every width), sparse lone ones, and flags that fall next to them and next to each other.
    for (let t = 0; t < 60; t += 0.01) records.push(rec(seq++, t, "action", "ugv-001", { op: "phase" }));
    for (let t = 0; t < 60; t += 0.0005 * (1 + Math.floor(t / 10))) records.push(rec(seq++, t, "action", "ugv-002", { op: "phase" }));
    for (let i = 0; i < 40; i++) records.push(rec(seq++, rnd() * 60, "action", i % 2 ? "ugv-001" : "ugv-002", { op: "phase" }));
    for (let i = 0; i < 30; i++) records.push(rec(seq++, rnd() * 60, i % 3 ? "reflex" : "action", i % 2 ? "ugv-001" : "ugv-002", i % 3 ? { code: "x" } : { op: "end", status: "failed", failure: { code: "y" } }));
    for (let i = 0; i < 6; i++) records.push(rec(seq++, 30 + i * 0.01, "reflex", "ugv-001", { code: "burst" })); // flags a pixel or two apart
    const marks = records.map(markOf);
    for (const [scaleS, trackPx] of [[60, 1300], [60, 400], [60, 90], [6, 1300], [600, 1300]] as const) {
      const { bins, flags } = binMarks(marks, lanes, scaleS, trackPx);
      for (let lane = 0; lane < lanes.length; lane++) {
        const spans: { from: number; to: number; what: string }[] = [];
        for (const b of bins.filter((x) => x.lane === lane)) {
          if (b.mode === "count" && b.label) spans.push({ from: b.label.x, to: b.label.x + b.label.widthPx, what: `count in bin ${b.x0}` });
          else if (b.mode === "glyph") spans.push({ from: b.gx - GLYPH_PX / 2, to: b.gx + GLYPH_PX / 2, what: `glyph in bin ${b.x0}` });
        }
        for (const f of flags.filter((x) => x.lane === lane)) {
          spans.push({ from: f.px - 1, to: f.px + 1, what: `flag bar at ${f.px.toFixed(1)}` });
          spans.push({ from: f.gx - GLYPH_PX / 2, to: f.gx + GLYPH_PX / 2, what: `flag glyph at ${f.gx.toFixed(1)}` });
        }
        // A flag's own bar and glyph belong together (the glyph is drawn beside the bar): compare everything else.
        spans.sort((a, b) => a.from - b.from);
        for (let i = 1; i < spans.length; i++) {
          const a = spans[i - 1] as { from: number; to: number; what: string };
          const b = spans[i] as { from: number; to: number; what: string };
          // The thin bar of a flag stands where the flag is, beside its glyph or another flag's: only the bar's neighbours that are counts and lone glyphs are compared.
          const flagPair = a.what.startsWith("flag") && b.what.startsWith("flag") && (a.what.startsWith("flag bar") || b.what.startsWith("flag bar"));
          if (flagPair) continue;
          expect(a.to, `${a.what} reaches into ${b.what} (scale ${scaleS} s over ${trackPx} px, lane ${lane})`).toBeLessThanOrEqual(b.from + 1e-6);
        }
      }
    }
  });

  it("keeps a lone glyph inside its bin, so the glyphs of two neighbouring bins are at least a glyph apart", () => {
    const marks = [rec(1, 31.9 / 10, "action", "ugv-001", { op: "start" }), rec(2, 32.1 / 10, "action", "ugv-001", { op: "start" })].map(markOf);
    const { bins } = binMarks(marks, ["run", "ugv-001"], 100, 1000);
    expect(bins).toHaveLength(2);
    const [a, b] = bins as [(typeof bins)[number], (typeof bins)[number]];
    expect(b.gx - a.gx).toBeGreaterThanOrEqual(GLYPH_PX);
    expect(CHAR_PX).toBeGreaterThan(5); // the width the layout assumes for a character of the mono label
  });
});

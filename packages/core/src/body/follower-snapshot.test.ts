import { describe, expect, it } from "vitest";
import { makeUgv } from "../actions/testing/fakes.ts";
import { decodeValue, encodeValue } from "../snapshot/codec.ts";
import { stepDrive } from "./drive.ts";
import { PathFollower, type FollowerParams, type FollowerSnapshot, type PathSegment } from "./follower.ts";
import type { UgvState } from "./kinematics.ts";

// F3a M1: a follower restored from its snapshot continues bit for bit (ADR-0035 addition of 2026-10-17, item 8).

const DT = 0.1;
const body = (over: Partial<FollowerParams> = {}): FollowerParams => ({ ...(makeUgv().body as FollowerParams), ...over });
const seg = (reverse: boolean, ...pts: number[]): PathSegment => ({ pts: Float64Array.from(pts), reverse });
const start = (x: number, y: number, heading: number): UgvState => ({ x, y, heading, speed: 0, steering: 0, lastStepM: 0, lastRotationRad: 0 });
const bytes = (s: UgvState, c: unknown) => encodeValue({ state: { ...s }, command: c });

/** Drives the vehicle for `ticks` updates and returns the command of each (plain copies). */
function drive(f: PathFollower, s: UgvState, p: FollowerParams, ticks: number): unknown[] {
  const out: unknown[] = [];
  for (let t = 0; t < ticks; t++) {
    const c = f.update(s, DT);
    out.push({ ...c });
    if (!c.arrived && !c.stuck) stepDrive(s, p, c, DT);
  }
  return out;
}

/** Runs one follower to `n`, restores a second from its snapshot (through the codec) and compares the next `after` updates. */
function check(make: () => { f: PathFollower; s: UgvState; p: FollowerParams }, n: number, after: number, extend?: (f: PathFollower) => void) {
  const a = make();
  drive(a.f, a.s, a.p, n);
  extend?.(a.f);
  const snap = decodeValue(encodeValue(a.f.snapshot())) as FollowerSnapshot;
  const restored = PathFollower.restore(snap, a.p);
  expect(encodeValue(restored.snapshot()), "snapshot(restore(snapshot)) is byte-identical").toEqual(encodeValue(a.f.snapshot()));
  const sb: UgvState = { ...a.s };
  for (let t = 0; t < after; t++) {
    const ca = a.f.update(a.s, DT);
    const cb = restored.update(sb, DT);
    expect(bytes(sb, { ...cb }), `update ${t}`).toEqual(bytes(a.s, { ...ca }));
    if (!ca.arrived && !ca.stuck) {
      stepDrive(a.s, a.p, ca, DT);
      stepDrive(sb, a.p, cb, DT);
    }
  }
  expect(encodeValue(restored.snapshot())).toEqual(encodeValue(a.f.snapshot()));
  return { a, restored, snap };
}

describe("PathFollower snapshot and restore (F3a M1)", () => {
  it("restores at the start (bestDistance is still +Infinity) and mid-path, on a drive that rotates in place", () => {
    const p = body({ drive: "differential", turningRadiusM: 0, reverseAllowed: true });
    const make = () => ({ f: new PathFollower([seg(false, 0, 0, 12, 0, 12, 9)], p), s: start(0, 0, 2), p });
    const early = check(make, 0, 400);
    expect(early.snap.pursuit.bestDistance).toBe(Number.POSITIVE_INFINITY);
    const mid = check(make, 60, 400);
    expect(mid.snap.pursuit.bestDistance).toBeLessThan(Number.POSITIVE_INFINITY);
  });

  it("a path with a cusp: restores on the reverse segment with the tighter arrival tolerance of a cusp", () => {
    const p = body({ drive: "differential", turningRadiusM: 0, reverseAllowed: true });
    const make = () => ({ f: new PathFollower([seg(false, 0, 0, 6, 0), seg(true, 6, 0, 2, 0)], p), s: start(0, 0, 0), p });
    const n = 110;
    const { snap } = check(make, n, 300);
    expect(snap.index).toBe(1);
    expect(snap.segments.map((x) => x.reverse)).toEqual([false, true]);
  });

  it("legs appended by a lazy plan are part of the snapshot, and so is progress made before they came", () => {
    const p = body();
    const make = () => ({ f: new PathFollower([seg(false, 0, 0, 10, 0)], p), s: start(0, 0, 0), p });
    const { snap } = check(make, 30, 600, (f) => f.append(Float64Array.from([20, 0, 20, 10])));
    expect(snap.segments[0]?.pts.length).toBe(8);
    expect(snap.pursuit.path.length).toBe(8);
  });

  it("a back-off follower's tighter arrival tolerance comes back, whatever the body says", () => {
    const p = body({ drive: "differential", turningRadiusM: 0, reverseAllowed: true });
    const tight = new PathFollower([seg(true, 5, 5, 3, 5)], { ...p, arrivalToleranceM: 0.05 });
    const snap = decodeValue(encodeValue(tight.snapshot())) as FollowerSnapshot;
    expect(snap.arrivalToleranceM).toBe(0.05);
    expect(PathFollower.restore(snap, p).snapshot().arrivalToleranceM).toBe(0.05);
    expect(p.arrivalToleranceM).toBe(0.5);
  });

  it("refuses a segment index that is not in the path", () => {
    const p = body();
    const snap = new PathFollower([seg(false, 0, 0, 5, 0)], p).snapshot();
    expect(() => PathFollower.restore({ ...snap, index: 3 }, p)).toThrow(/segment index 3 of 1/);
  });
});

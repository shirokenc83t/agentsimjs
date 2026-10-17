// Port of fdlibm 5.3 / FreeBSD msun trigonometric routines (ADR-0023).
// Original notice: Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
// Developed at SunSoft, a Sun Microsystems, Inc. business. Permission to use, copy, modify, and
// distribute this software is freely granted, provided that this notice is preserved.
import { fromWords, highWord } from "./bits.ts";

// ---- __kernel_sin / __kernel_cos (|x| <= pi/4, y is the tail of x) -----------------------------

const S1 = -1.66666666666666324348e-1;
const S2 = 8.33333333332248946124e-3;
const S3 = -1.98412698298579493134e-4;
const S4 = 2.75573137070700676789e-6;
const S5 = -2.50507602534068634195e-8;
const S6 = 1.58969099521155010221e-10;

function kernelSin(x: number, y: number, iy: number): number {
  const ix = highWord(x) & 0x7fffffff;
  if (ix < 0x3e400000 && Math.trunc(x) === 0) return x; // |x| < 2^-27
  const z = x * x;
  const v = z * x;
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  if (iy === 0) return x + v * (S1 + z * r);
  return x - (z * (0.5 * y - v * r) - y - v * S1);
}

const C1 = 4.16666666666666019037e-2;
const C2 = -1.38888888888741095749e-3;
const C3 = 2.48015872894767294178e-5;
const C4 = -2.75573143513906633035e-7;
const C5 = 2.08757232129817482790e-9;
const C6 = -1.13596475577881948265e-11;

function kernelCos(x: number, y: number): number {
  const ix = highWord(x) & 0x7fffffff;
  if (ix < 0x3e400000 && Math.trunc(x) === 0) return 1; // |x| < 2^-27
  const z = x * x;
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  if (ix < 0x3fd33333) return 1 - (0.5 * z - (z * r - x * y)); // |x| < 0.3
  const qx = ix > 0x3fe90000 ? 0.28125 : fromWords(ix - 0x00200000, 0); // x/4
  const hz = 0.5 * z - qx;
  const a = 1 - qx;
  return a - (hz - (z * r - x * y));
}

// ---- argument reduction (__ieee754_rem_pio2, medium path) --------------------------------------

const INV_PIO2 = 6.36619772367581382433e-1;
const PIO2_1 = 1.57079632673412561417;
const PIO2_1T = 6.07710050650619224932e-11;
const PIO2_2 = 6.07710050630396597660e-11;
const PIO2_2T = 2.02226624879595063154e-21;
const PIO2_3 = 2.02226624871116645580e-21;
const PIO2_3T = 8.47842766036889956997e-32;

/** Reduction output (module-level to avoid allocation): x = n*pi/2 + (y0 + y1). */
let y0 = 0;
let y1 = 0;

/**
 * Returns n mod 4 and sets y0/y1. Uses fdlibm's three-step Cody–Waite reduction. fdlibm switches to
 * Payne–Hanek for |x| > 2^19·π/2 (~8.2e5); this port keeps the three-step path there too. That is still
 * deterministic (IEEE operations only) but loses accuracy for such huge arguments, which never occur
 * as angles in the simulator.
 */
function remPio2(x: number): number {
  const hx = highWord(x);
  const ix = hx & 0x7fffffff;
  if (ix <= 0x3fe921fb) {
    y0 = x;
    y1 = 0;
    return 0;
  }
  if (ix < 0x4002d97c) {
    // |x| < 3π/4: special-cased for accuracy near π/2
    if (hx > 0) {
      let z = x - PIO2_1;
      if (ix !== 0x3ff921fb) {
        y0 = z - PIO2_1T;
        y1 = z - y0 - PIO2_1T;
      } else {
        z -= PIO2_2;
        y0 = z - PIO2_2T;
        y1 = z - y0 - PIO2_2T;
      }
      return 1;
    }
    let z = x + PIO2_1;
    if (ix !== 0x3ff921fb) {
      y0 = z + PIO2_1T;
      y1 = z - y0 + PIO2_1T;
    } else {
      z += PIO2_2;
      y0 = z + PIO2_2T;
      y1 = z - y0 + PIO2_2T;
    }
    return 3; // -1 mod 4
  }
  const t0 = Math.abs(x);
  const fn = Math.floor(t0 * INV_PIO2 + 0.5);
  let r = t0 - fn * PIO2_1;
  let w = fn * PIO2_1T;
  const j = ix >> 20;
  y0 = r - w;
  let i = j - ((highWord(y0) >> 20) & 0x7ff);
  if (i > 16) {
    // second iteration: cancellation, use 2nd part of pi/2
    let t = r;
    w = fn * PIO2_2;
    r = t - w;
    w = fn * PIO2_2T - (t - r - w);
    y0 = r - w;
    i = j - ((highWord(y0) >> 20) & 0x7ff);
    if (i > 49) {
      // third iteration
      t = r;
      w = fn * PIO2_3;
      r = t - w;
      w = fn * PIO2_3T - (t - r - w);
      y0 = r - w;
    }
  }
  y1 = r - y0 - w;
  const n = fn % 4;
  if (hx < 0) {
    y0 = -y0;
    y1 = -y1;
    return (4 - n) % 4;
  }
  return n;
}

// ---- public functions --------------------------------------------------------------------------

export function sin(x: number): number {
  const ix = highWord(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) return kernelSin(x, 0, 0);
  if (ix >= 0x7ff00000) return Number.NaN; // Inf or NaN
  switch (remPio2(x)) {
    case 0:
      return kernelSin(y0, y1, 1);
    case 1:
      return kernelCos(y0, y1);
    case 2:
      return -kernelSin(y0, y1, 1);
    default:
      return -kernelCos(y0, y1);
  }
}

export function cos(x: number): number {
  const ix = highWord(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) return kernelCos(x, 0);
  if (ix >= 0x7ff00000) return Number.NaN;
  switch (remPio2(x)) {
    case 0:
      return kernelCos(y0, y1);
    case 1:
      return -kernelSin(y0, y1, 1);
    case 2:
      return -kernelCos(y0, y1);
    default:
      return kernelSin(y0, y1, 1);
  }
}

/** tan as sin/cos of the same reduced argument (deterministic; within ~2 ulp, not fdlibm's kernel_tan). */
export function tan(x: number): number {
  const ix = highWord(x) & 0x7fffffff;
  if (ix >= 0x7ff00000) return Number.NaN;
  const n = ix <= 0x3fe921fb ? ((y0 = x), (y1 = 0), 0) : remPio2(x);
  const s = kernelSin(y0, y1, 1);
  const c = kernelCos(y0, y1);
  return n % 2 === 0 ? s / c : -c / s;
}

// ---- atan / atan2 (s_atan.c, e_atan2.c) --------------------------------------------------------

const ATAN_HI = [4.63647609000806093515e-1, 7.85398163397448278999e-1, 9.82793723247329054082e-1, 1.57079632679489655800];
const ATAN_LO = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17];
const AT0 = 3.33333333333329318027e-1;
const AT1 = -1.99999999998764832476e-1;
const AT2 = 1.42857142725034663711e-1;
const AT3 = -1.11111104054623557880e-1;
const AT4 = 9.09088713343650656196e-2;
const AT5 = -7.69187620504482999495e-2;
const AT6 = 6.66107313738753120669e-2;
const AT7 = -5.83357013379057348645e-2;
const AT8 = 4.97687799461593236017e-2;
const AT9 = -3.65315727442169155270e-2;
const AT10 = 1.62858201153657823623e-2;

export function atan(xIn: number): number {
  let x = xIn;
  const hx = highWord(x);
  const ix = hx & 0x7fffffff;
  let id: number;
  if (ix >= 0x44100000) {
    // |x| >= 2^66
    if (Number.isNaN(x)) return x + x;
    const r = (ATAN_HI[3] ?? 0) + (ATAN_LO[3] ?? 0);
    return hx > 0 ? r : -r;
  }
  if (ix < 0x3fdc0000) {
    // |x| < 0.4375
    if (ix < 0x3e200000) return x; // |x| < 2^-29
    id = -1;
  } else {
    x = Math.abs(x);
    if (ix < 0x3ff30000) {
      if (ix < 0x3fe60000) {
        id = 0;
        x = (2 * x - 1) / (2 + x);
      } else {
        id = 1;
        x = (x - 1) / (x + 1);
      }
    } else if (ix < 0x40038000) {
      id = 2;
      x = (x - 1.5) / (1 + 1.5 * x);
    } else {
      id = 3;
      x = -1 / x;
    }
  }
  const z = x * x;
  const w = z * z;
  const s1 = z * (AT0 + w * (AT2 + w * (AT4 + w * (AT6 + w * (AT8 + w * AT10)))));
  const s2 = w * (AT1 + w * (AT3 + w * (AT5 + w * (AT7 + w * AT9))));
  if (id < 0) return x - x * (s1 + s2);
  const r = (ATAN_HI[id] ?? 0) - (x * (s1 + s2) - (ATAN_LO[id] ?? 0) - x);
  return hx < 0 ? -r : r;
}

const PI_O_4 = 7.8539816339744827900e-1;
const PI_O_2 = 1.5707963267948965580;
const PI = 3.1415926535897931160;
const PI_LO = 1.2246467991473532e-16;

export function atan2(y: number, x: number): number {
  if (Number.isNaN(x) || Number.isNaN(y)) return x + y;
  const hx = highWord(x);
  const ix = hx & 0x7fffffff;
  const hy = highWord(y);
  const iy = hy & 0x7fffffff;
  if (x === 1) return atan(y);
  const m = ((hy >>> 31) & 1) | ((hx >>> 30) & 2);
  if (y === 0) {
    switch (m) {
      case 0:
      case 1:
        return y; // atan(±0, +anything) = ±0
      case 2:
        return PI; // atan(+0, -anything) = π
      default:
        return -PI;
    }
  }
  if (x === 0) return hy < 0 ? -PI_O_2 : PI_O_2;
  if (ix === 0x7ff00000) {
    if (iy === 0x7ff00000) {
      switch (m) {
        case 0:
          return PI_O_4;
        case 1:
          return -PI_O_4;
        case 2:
          return 3 * PI_O_4;
        default:
          return -3 * PI_O_4;
      }
    }
    switch (m) {
      case 0:
        return 0;
      case 1:
        return -0;
      case 2:
        return PI;
      default:
        return -PI;
    }
  }
  if (iy === 0x7ff00000) return hy < 0 ? -PI_O_2 : PI_O_2;
  const k = (iy - ix) >> 20;
  let z: number;
  if (k > 60) z = PI_O_2 + 0.5 * PI_LO; // |y/x| > 2^60
  else if (hx < 0 && k < -60) z = 0; // |y|/x < -2^60
  else z = atan(Math.abs(y / x));
  switch (m) {
    case 0:
      return z;
    case 1:
      return -z;
    case 2:
      return PI - (z - PI_LO);
    default:
      return z - PI_LO - PI;
  }
}

/** asin via atan2 with an exact-IEEE square root (deterministic; within ~2 ulp). */
export function asin(x: number): number {
  if (Number.isNaN(x) || x > 1 || x < -1) return Number.NaN;
  return atan2(x, Math.sqrt((1 - x) * (1 + x)));
}

/** acos via atan2 with an exact-IEEE square root (deterministic; within ~2 ulp). */
export function acos(x: number): number {
  if (Number.isNaN(x) || x > 1 || x < -1) return Number.NaN;
  return atan2(Math.sqrt((1 - x) * (1 + x)), x);
}

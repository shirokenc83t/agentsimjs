// Port of fdlibm 5.3 e_exp.c and e_log.c (ADR-0023).
// Original notice: Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
// Developed at SunSoft, a Sun Microsystems, Inc. business. Permission to use, copy, modify, and
// distribute this software is freely granted, provided that this notice is preserved.
import { highWord, lowWord, withHighWord } from "./bits.ts";

const LN2_HI = 6.93147180369123816490e-1;
const LN2_LO = 1.90821492927058770002e-10;
const INV_LN2 = 1.44269504088896338700;
const P1 = 1.66666666666666019037e-1;
const P2 = -2.77777777770155933842e-3;
const P3 = 6.61375632143793436117e-5;
const P4 = -1.65339022054652515390e-6;
const P5 = 4.13813679705723846039e-8;
const O_THRESHOLD = 7.09782712893383973096e2;
const U_THRESHOLD = -7.45133219101941108420e2;
const TWO_M1000 = 9.33263618503218878990e-302; // 2^-1000

export function exp(xIn: number): number {
  let x = xIn;
  let hx = highWord(x);
  const xsb = (hx >>> 31) & 1;
  hx &= 0x7fffffff;
  if (hx >= 0x40862e42) {
    // |x| >= 709.78...
    if (hx >= 0x7ff00000) {
      if (((hx & 0xfffff) | lowWord(x)) !== 0) return x + x; // NaN
      return xsb === 0 ? x : 0; // exp(±inf) = inf / 0
    }
    if (x > O_THRESHOLD) return Number.POSITIVE_INFINITY;
    if (x < U_THRESHOLD) return 0;
  }
  let hi = 0;
  let lo = 0;
  let k = 0;
  if (hx > 0x3fd62e42) {
    // |x| > 0.5 ln2: argument reduction
    if (hx < 0x3ff0a2b2) {
      hi = xsb === 0 ? x - LN2_HI : x + LN2_HI;
      lo = xsb === 0 ? LN2_LO : -LN2_LO;
      k = 1 - xsb - xsb;
    } else {
      k = Math.trunc(INV_LN2 * x + (xsb === 0 ? 0.5 : -0.5));
      hi = x - k * LN2_HI;
      lo = k * LN2_LO;
    }
    x = hi - lo;
  } else if (hx < 0x3e300000) {
    return 1 + x; // |x| < 2^-28
  }
  const t = x * x;
  const c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
  if (k === 0) return 1 - ((x * c) / (c - 2) - x);
  const y = 1 - (lo - (x * c) / (2 - c) - hi);
  if (k >= -1021) return withHighWord(y, highWord(y) + (k << 20));
  return withHighWord(y, highWord(y) + ((k + 1000) << 20)) * TWO_M1000;
}

const TWO54 = 1.80143985094819840000e16;
const LG1 = 6.666666666666735130e-1;
const LG2 = 3.999999999940941908e-1;
const LG3 = 2.857142874366239149e-1;
const LG4 = 2.222219843214978396e-1;
const LG5 = 1.818357216161805012e-1;
const LG6 = 1.531383769920937332e-1;
const LG7 = 1.479819860511658591e-1;

export function log(xIn: number): number {
  let x = xIn;
  let hx = highWord(x);
  const lx = lowWord(x);
  let k = 0;
  if (hx < 0x00100000) {
    // x < 2^-1022
    if (((hx & 0x7fffffff) | lx) === 0) return Number.NEGATIVE_INFINITY; // log(±0)
    if (hx < 0) return Number.NaN; // log(-#)
    k -= 54;
    x *= TWO54; // subnormal: scale up
    hx = highWord(x);
  }
  if (hx >= 0x7ff00000) return x + x;
  k += (hx >> 20) - 1023;
  hx &= 0x000fffff;
  const i0 = (hx + 0x95f64) & 0x100000;
  x = withHighWord(x, hx | (i0 ^ 0x3ff00000)); // normalize x or x/2
  k += i0 >> 20;
  const f = x - 1;
  const dk = k;
  if ((0x000fffff & (2 + hx)) < 3) {
    // -2^-20 <= f < 2^-20
    if (f === 0) return k === 0 ? 0 : dk * LN2_HI + dk * LN2_LO;
    const R = f * f * (0.5 - 0.3333333333333333 * f);
    return k === 0 ? f - R : dk * LN2_HI - (R - dk * LN2_LO - f);
  }
  const s = f / (2 + f);
  const z = s * s;
  let i = hx - 0x6147a;
  const w = z * z;
  const j = 0x6b851 - hx;
  const t1 = w * (LG2 + w * (LG4 + w * LG6));
  const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
  i |= j;
  const R = t2 + t1;
  if (i > 0) {
    const hfsq = 0.5 * f * f;
    return k === 0 ? f - (hfsq - s * (hfsq + R)) : dk * LN2_HI - (hfsq - (s * (hfsq + R) + dk * LN2_LO) - f);
  }
  return k === 0 ? f - s * (f - R) : dk * LN2_HI - (s * (f - R) - dk * LN2_LO - f);
}

/**
 * pow with fdlibm's special cases and an exact path for small integer exponents; the general case is
 * exp(y·log(x)). Deterministic (IEEE operations + detmath only). Accuracy is lower than fdlibm's
 * e_pow.c when |y·log x| is large; not used on hot paths of the simulator.
 */
export function pow(x: number, y: number): number {
  if (y === 0) return 1;
  if (Number.isNaN(x) || Number.isNaN(y)) return Number.NaN;
  if (y === 1) return x;
  const yIsInt = Number.isInteger(y);
  if (yIsInt && Math.abs(y) <= 64) {
    // exponentiation by squaring: exact sequence of IEEE multiplications
    let n = Math.abs(y);
    let base = x;
    let acc = 1;
    while (n > 0) {
      if (n & 1) acc *= base;
      base *= base;
      n >>>= 1;
    }
    return y < 0 ? 1 / acc : acc;
  }
  if (!Number.isFinite(y)) {
    const ax = Math.abs(x);
    if (ax === 1) return Number.NaN; // as ES Math.pow(±1, ±Infinity)
    return (ax > 1) === y > 0 ? Number.POSITIVE_INFINITY : 0;
  }
  if (x === 0) {
    const oddInt = yIsInt && Math.abs(y % 2) === 1;
    if (y > 0) return oddInt ? x : 0;
    return oddInt && Object.is(x, -0) ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  }
  if (x === Number.NEGATIVE_INFINITY) {
    const oddInt = yIsInt && Math.abs(y % 2) === 1;
    if (y > 0) return oddInt ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
    return oddInt ? -0 : 0;
  }
  if (x < 0) {
    if (!yIsInt) return Number.NaN;
    const mag = exp(y * log(-x));
    return Math.abs(y % 2) === 1 ? -mag : mag;
  }
  if (x === Number.POSITIVE_INFINITY) return y > 0 ? Number.POSITIVE_INFINITY : 0;
  return exp(y * log(x));
}

/** hypot with scaling to avoid overflow/underflow; uses only IEEE operations and sqrt. */
export function hypot(a: number, b: number): number {
  const x = Math.abs(a);
  const y = Math.abs(b);
  if (x === Number.POSITIVE_INFINITY || y === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  if (Number.isNaN(x) || Number.isNaN(y)) return Number.NaN;
  const big = Math.max(x, y);
  const small = Math.min(x, y);
  if (big === 0) return 0;
  const r = small / big;
  return big * Math.sqrt(1 + r * r);
}

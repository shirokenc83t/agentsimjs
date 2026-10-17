// IEEE-754 word access for the fdlibm port (ADR-0023). A module-level little-endian DataView keeps the
// layout explicit and the calls allocation-free.
const view = new DataView(new ArrayBuffer(8));

/** High 32 bits (sign, exponent, top of mantissa) as a signed int. */
export function highWord(x: number): number {
  view.setFloat64(0, x, true);
  return view.getInt32(4, true);
}

/** Low 32 bits of the mantissa as an unsigned int. */
export function lowWord(x: number): number {
  view.setFloat64(0, x, true);
  return view.getUint32(0, true);
}

export function fromWords(hi: number, lo: number): number {
  view.setInt32(4, hi | 0, true);
  view.setUint32(0, lo >>> 0, true);
  return view.getFloat64(0, true);
}

/** `x` with its high word replaced. */
export function withHighWord(x: number, hi: number): number {
  view.setFloat64(0, x, true);
  view.setInt32(4, hi | 0, true);
  return view.getFloat64(0, true);
}

/** `x` with its low word cleared (used by kernels that split a value into exact halves). */
export function withZeroLowWord(x: number): number {
  view.setFloat64(0, x, true);
  view.setUint32(0, 0, true);
  return view.getFloat64(0, true);
}

/**
 * Deterministic math (ADR-0023): the transcendental functions used by deterministic packages.
 * ECMA-262 lets engines approximate `Math.sin`, `Math.exp`, … differently; these implementations use
 * only IEEE-754 arithmetic and `Math.sqrt`, so results are bit-identical across engines.
 */
export { sin, cos, tan, atan, atan2, asin, acos } from "./trig.ts";
export { exp, log, pow, hypot } from "./explog.ts";

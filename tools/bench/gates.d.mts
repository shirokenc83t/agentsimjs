export interface Limit {
  stat: string;
  max: number;
}
export interface Row {
  stat?: string;
  max?: number;
  tailStat?: string;
  tailMax?: number;
  ciStat?: string;
  ciMax?: number;
  report?: boolean;
}
export interface Measurement {
  mean?: number;
  median?: number;
  p95?: number;
  unit?: string;
  [stat: string]: unknown;
}
export function limitsOf(t: Row, ci: boolean): Limit[];
export function evaluate(t: Row, m: Measurement, ci: boolean): { ok: boolean; limits: Limit[]; failures: Limit[] };

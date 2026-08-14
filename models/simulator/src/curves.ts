import type { CurvePoint, CurveSpec, TreePreset, TreeSimulationConfig } from "./types.js";

function normalizedPoints(spec: CurveSpec): { x: number[]; y: number[] } {
  if (spec.points.length < 2) throw new RangeError("A demographic curve needs at least two control points.");
  const sorted = [...spec.points].sort((a, b) => a.time - b.time);
  const x: number[] = [];
  const y: number[] = [];
  for (const point of sorted) {
    if (!Number.isFinite(point.time) || !Number.isFinite(point.value)) throw new RangeError("Curve control points must be finite.");
    const value = spec.space === "log" ? Math.log(Math.max(point.value, 1e-12)) : Math.max(point.value, 0);
    if (x.length > 0 && Math.abs(point.time - x[x.length - 1]!) < 1e-12) y[y.length - 1] = value;
    else { x.push(point.time); y.push(value); }
  }
  if (x.length < 2) throw new RangeError("Curve control-point times must not all coincide.");
  return { x, y };
}

function pchipSlopes(x: readonly number[], y: readonly number[]): number[] {
  const n = x.length;
  const h = Array.from({ length: n - 1 }, (_, i) => x[i + 1]! - x[i]!);
  if (h.some((value) => !(value > 0))) throw new RangeError("Curve times must be strictly increasing.");
  const delta = h.map((value, i) => (y[i + 1]! - y[i]!) / value);
  if (n === 2) return [delta[0]!, delta[0]!];
  const d = new Array<number>(n).fill(0);
  const endpoint = (h0: number, h1: number, m0: number, m1: number): number => {
    let value = ((2 * h0 + h1) * m0 - h0 * m1) / (h0 + h1);
    if (Math.sign(value) !== Math.sign(m0)) value = 0;
    else if (Math.sign(m0) !== Math.sign(m1) && Math.abs(value) > 3 * Math.abs(m0)) value = 3 * m0;
    return value;
  };
  d[0] = endpoint(h[0]!, h[1]!, delta[0]!, delta[1]!);
  d[n - 1] = endpoint(h[n - 2]!, h[n - 3]!, delta[n - 2]!, delta[n - 3]!);
  for (let i = 1; i < n - 1; i += 1) {
    const before = delta[i - 1]!;
    const after = delta[i]!;
    if (before === 0 || after === 0 || Math.sign(before) !== Math.sign(after)) d[i] = 0;
    else {
      const w1 = 2 * h[i]! + h[i - 1]!;
      const w2 = h[i]! + 2 * h[i - 1]!;
      d[i] = (w1 + w2) / (w1 / before + w2 / after);
    }
  }
  return d;
}

export function createCurveEvaluator(spec: CurveSpec): (time: number) => number {
  const { x, y } = normalizedPoints(spec);
  const d = pchipSlopes(x, y);
  return (time: number): number => {
    if (time <= x[0]!) return spec.space === "log" ? Math.exp(y[0]!) : Math.max(0, y[0]!);
    if (time >= x[x.length - 1]!) return spec.space === "log" ? Math.exp(y[y.length - 1]!) : Math.max(0, y[y.length - 1]!);
    let low = 0;
    let high = x.length - 1;
    while (high - low > 1) {
      const middle = (low + high) >>> 1;
      if (x[middle]! <= time) low = middle;
      else high = middle;
    }
    const width = x[low + 1]! - x[low]!;
    const u = (time - x[low]!) / width;
    const h00 = (2 * u - 3) * u * u + 1;
    const h10 = ((u - 2) * u + 1) * u;
    const h01 = (-2 * u + 3) * u * u;
    const h11 = (u - 1) * u * u;
    const value = h00 * y[low]! + h10 * width * d[low]! + h01 * y[low + 1]! + h11 * width * d[low + 1]!;
    return spec.space === "log" ? Math.exp(value) : Math.max(0, value);
  };
}

export interface IntegratedCurve {
  readonly horizon: number;
  readonly bins: number;
  readonly times: Float64Array;
  readonly cumulative: Float64Array;
  readonly evaluate: (time: number) => number;
  readonly integralAt: (time: number) => number;
}

export function integrateCurve(spec: CurveSpec, horizon: number, bins = 4096, transform: (value: number) => number = (value) => value): IntegratedCurve {
  if (!(horizon > 0) || !Number.isInteger(bins) || bins < 64) throw new RangeError("Hazard integration needs a positive horizon and at least 64 bins.");
  const evaluateBase = createCurveEvaluator(spec);
  const evaluate = (time: number): number => transform(evaluateBase(time));
  const times = new Float64Array(bins + 1);
  const cumulative = new Float64Array(bins + 1);
  const width = horizon / bins;
  let previous = evaluate(0);
  for (let i = 0; i < bins; i += 1) {
    const left = i * width;
    const right = left + width;
    const middle = (left + right) / 2;
    const midValue = evaluate(middle);
    const next = evaluate(right);
    times[i + 1] = right;
    cumulative[i + 1] = cumulative[i]! + width * (previous + 4 * midValue + next) / 6;
    previous = next;
  }
  const integralAt = (time: number): number => {
    if (time <= 0) return 0;
    if (time >= horizon) return cumulative[bins]! + (time - horizon) * evaluate(horizon);
    const position = time / width;
    const index = Math.min(bins - 1, Math.floor(position));
    const fraction = position - index;
    return cumulative[index]! + fraction * (cumulative[index + 1]! - cumulative[index]!);
  };
  return { horizon, bins, times, cumulative, evaluate, integralAt };
}

function points(horizon: number, values: readonly number[]): CurvePoint[] {
  return values.map((value, index) => ({ time: horizon * index / (values.length - 1), value }));
}

export function presetCurves(preset: Exclude<TreePreset, "custom">, horizon: number, tips = 100): Pick<TreeSimulationConfig, "population" | "sampling" | "initialTips"> {
  const scale = Math.max(10, tips);
  if (preset === "constant") return { initialTips: tips, population: { space: "log", points: points(horizon, [5 * scale, 5 * scale]) }, sampling: { space: "linear", points: points(horizon, [0, 0]) } };
  if (preset === "serial") return { initialTips: 2, population: { space: "log", points: points(horizon, [5 * scale, 5 * scale]) }, sampling: { space: "log", points: points(horizon, [tips / horizon, tips / horizon]) } };
  if (preset === "ladder") return { initialTips: 1, population: { space: "log", points: points(horizon, [Math.max(2, scale / 10), Math.max(2, scale / 10)]) }, sampling: { space: "log", points: points(horizon, [tips / horizon, tips / horizon]) } };
  if (preset === "exponential") return { initialTips: tips, population: { space: "log", points: points(horizon, [100 * scale, 35 * scale, 10 * scale, 2 * scale]) }, sampling: { space: "linear", points: points(horizon, [0, 0]) } };
  if (preset === "logistic") return { initialTips: 3, population: { space: "log", points: points(horizon, [80 * scale, 60 * scale, 12 * scale, 2 * scale, 1.2 * scale]) }, sampling: { space: "log", points: points(horizon, [tips * 1.2 / horizon, tips * 1.8 / horizon, tips * 0.75 / horizon, tips * 0.25 / horizon]) } };
  if (preset === "seasonal") return { initialTips: 2, population: { space: "log", points: points(horizon, [12, 180, 16, 220, 14, 160, 12].map((value) => value * Math.sqrt(scale))) }, sampling: { space: "log", points: points(horizon, [0.15, 2.4, 0.2, 2.8, 0.2, 2.1, 0.15].map((value) => value * tips / horizon)) } };
  return { initialTips: tips, population: { space: "log", points: points(horizon, [15 * scale, 15 * scale, 0.2 * scale, 0.2 * scale, 12 * scale, 12 * scale]) }, sampling: { space: "linear", points: points(horizon, [0, 0]) } };
}

export const DEFAULT_TREE_CONFIG: TreeSimulationConfig = {
  preset: "logistic",
  observedTips: 48,
  replicates: 4,
  ploidy: 1,
  horizon: 20,
  branchScale: 0.005,
  ...presetCurves("logistic", 20, 48),
  hazardBins: 4096,
};

/** Lanczos log-gamma with reflection for small positive arguments. */
export function logGamma(value: number): number {
  if (!(value > 0) || !Number.isFinite(value)) throw new RangeError("Gamma shape must be finite and positive.");
  const coefficients = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (value < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) - logGamma(1 - value);
  const z = value - 1;
  let series = coefficients[0]!;
  for (let index = 1; index < coefficients.length; index += 1) series += coefficients[index]! / (z + index);
  const t = z + 7.5;
  return 0.9189385332046727 + (z + 0.5) * Math.log(t) - t + Math.log(series);
}

/** Regularized lower incomplete gamma P(shape, x). */
export function regularizedGammaP(shape: number, x: number): number {
  if (!(shape > 0) || !Number.isFinite(shape) || x < 0 || !Number.isFinite(x)) throw new RangeError("Gamma CDF inputs are invalid.");
  if (x === 0) return 0;
  const gln = logGamma(shape);
  if (x < shape + 1) {
    let term = 1 / shape;
    let sum = term;
    let ap = shape;
    for (let iteration = 1; iteration <= 256; iteration += 1) {
      ap += 1;
      term *= x / ap;
      sum += term;
      if (Math.abs(term) <= Math.abs(sum) * 2e-15) break;
    }
    return Math.max(0, Math.min(1, sum * Math.exp(-x + shape * Math.log(x) - gln)));
  }
  const tiny = 1e-300;
  let b = x + 1 - shape;
  let c = 1 / tiny;
  let d = 1 / Math.max(tiny, b);
  let h = d;
  for (let iteration = 1; iteration <= 256; iteration += 1) {
    const an = -iteration * (iteration - shape);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) <= 2e-15) break;
  }
  const q = Math.exp(-x + shape * Math.log(x) - gln) * h;
  return Math.max(0, Math.min(1, 1 - q));
}

/** Regularized upper incomplete gamma Q(shape, x), preserving small tails. */
export function regularizedGammaQ(shape: number, x: number): number {
  if (!(shape > 0) || !Number.isFinite(shape) || x < 0 || !Number.isFinite(x)) throw new RangeError("Gamma survival inputs are invalid.");
  if (x === 0) return 1;
  const gln = logGamma(shape);
  if (x < shape + 1) {
    let term = 1 / shape;
    let sum = term;
    let ap = shape;
    for (let iteration = 1; iteration <= 256; iteration += 1) {
      ap += 1;
      term *= x / ap;
      sum += term;
      if (Math.abs(term) <= Math.abs(sum) * 2e-15) break;
    }
    const p = sum * Math.exp(-x + shape * Math.log(x) - gln);
    return Math.max(0, Math.min(1, 1 - p));
  }
  const tiny = 1e-300;
  let b = x + 1 - shape;
  let c = 1 / tiny;
  let d = 1 / Math.max(tiny, b);
  let h = d;
  for (let iteration = 1; iteration <= 256; iteration += 1) {
    const an = -iteration * (iteration - shape);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) <= 2e-15) break;
  }
  return Math.max(0, Math.min(1, Math.exp(-x + shape * Math.log(x) - gln) * h));
}

/** Unit-scale gamma quantile, solved against the exact regularized CDF. */
export function gammaQuantile(shape: number, probability: number): number {
  if (!(shape > 0) || !Number.isFinite(shape)) throw new RangeError("Gamma shape must be finite and positive.");
  if (!(probability > 0 && probability < 1) || !Number.isFinite(probability)) throw new RangeError("Gamma quantile probability must be between zero and one.");
  let upper = Math.max(1, shape);
  while (regularizedGammaP(shape, upper) < probability) {
    upper *= 2;
    if (upper > 1e12) throw new RangeError("Gamma quantile failed to find a finite bracket.");
  }
  const gammaLog = logGamma(shape);
  // Solve in log(x), not x. FLAVOR's shape=0.05 grid has legitimate lower
  // quantiles around 1e-33; an absolute x-space tolerance erases them.
  let lowerLog = -744;
  let upperLog = Math.log(upper);
  let xLog = Math.max(lowerLog, Math.min(upperLog, (Math.log(probability) + logGamma(shape + 1)) / shape));
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const x = Math.exp(xLog);
    const cdf = regularizedGammaP(shape, x);
    if (cdf < probability) lowerLog = xLog;
    else upperLog = xLog;
    if ((upperLog - lowerLog) <= 4e-14) break;
    const logDerivative = shape * xLog - x - gammaLog;
    const derivative = Math.exp(logDerivative);
    const newton = derivative > 1e-300 ? xLog - (cdf - probability) / derivative : Number.NaN;
    xLog = Number.isFinite(newton) && newton > lowerLog && newton < upperLog ? newton : (lowerLog + upperLog) / 2;
  }
  return Math.exp((lowerLog + upperLog) / 2);
}

/** Mid-quantile discrete-gamma approximation used by the Julia FLAVOR draft. */
export function gammaSlices(mean: number, shape: number, slices = 20): Float64Array {
  if (!(mean > 0) || !Number.isFinite(mean)) throw new RangeError("Gamma mean must be finite and positive.");
  if (!Number.isInteger(slices) || slices < 2 || slices > 64) throw new RangeError("Gamma slices must be an integer between 2 and 64.");
  const scale = mean / shape;
  const result = new Float64Array(slices);
  for (let index = 0; index < slices; index += 1) result[index] = gammaQuantile(shape, (index + 0.5) / slices) * scale;
  return result;
}

/** Equal-probability Gamma categories represented by their conditional means. */
export function gammaMeanSlices(mean: number, shape: number, slices = 4): Float64Array {
  if (!(mean > 0) || !(shape > 0) || !Number.isFinite(mean + shape)) throw new RangeError("Gamma mean and shape must be finite and positive.");
  if (!Number.isInteger(slices) || slices < 2 || slices > 64) throw new RangeError("Gamma mean slices must be an integer between 2 and 64.");
  const result = new Float64Array(slices);
  for (let index = 0; index < slices; index += 1) {
    const lower = index / slices;
    const upper = (index + 1) / slices;
    const lowerMoment = lower === 0 ? 0 : regularizedGammaP(shape + 1, gammaQuantile(shape, lower));
    const upperMoment = upper === 1 ? 1 : regularizedGammaP(shape + 1, gammaQuantile(shape, upper));
    result[index] = mean * (upperMoment - lowerMoment) * slices;
  }
  return result;
}

export interface ThresholdGammaSlices {
  readonly values: Float64Array;
  readonly weights: Float64Array;
  readonly positiveMask: Uint8Array;
  readonly positiveProbability: number;
}

/**
 * Threshold-aware Gamma quadrature. It preserves the exact probability mass
 * on each side of `threshold`, so a small but real positive tail is not erased
 * merely because it falls beyond the last equal-probability midpoint.
 */
export function thresholdGammaSlices(mean: number, shape: number, slices = 8, threshold = 1): ThresholdGammaSlices {
  if (!(mean > 0) || !(shape > 0) || !(threshold > 0) || !Number.isFinite(mean + shape + threshold)) {
    throw new RangeError("Threshold-Gamma inputs must be finite and positive.");
  }
  if (!Number.isInteger(slices) || slices < 4 || slices > 64) throw new RangeError("Threshold-Gamma slices must be an integer between 4 and 64.");
  const scale = mean / shape;
  const x = threshold / scale;
  const rawLower = regularizedGammaP(shape, x);
  const rawUpper = regularizedGammaQ(shape, x);
  const total = rawLower + rawUpper;
  const lowerProbability = total > 0 ? rawLower / total : 1;
  const positiveProbability = total > 0 ? rawUpper / total : 0;
  // Tails below machine-resolvable quantile probability cannot be represented
  // honestly by a finite double category; retain their probability in the
  // diagnostic but use no atomic tail component.
  const resolvablePositive = positiveProbability >= 2e-15;
  const resolvableLower = lowerProbability >= 2e-15;
  let positiveCount = resolvablePositive ? Math.max(1, Math.min(slices - 1, Math.round(slices * positiveProbability))) : 0;
  let lowerCount = slices - positiveCount;
  if (!resolvableLower) {
    lowerCount = 0;
    positiveCount = slices;
  }
  const values = new Float64Array(slices);
  const weights = new Float64Array(slices);
  const positiveMask = new Uint8Array(slices);
  const intervalMean = (lower: number, upper: number): number => {
    const mass = upper - lower;
    if (!(mass > 0)) return threshold;
    const lowerX = lower <= 0 ? 0 : gammaQuantile(shape, lower);
    const upperMoment = upper >= 1 ? 1 : regularizedGammaP(shape + 1, gammaQuantile(shape, upper));
    const lowerMoment = lower <= 0 ? 0 : regularizedGammaP(shape + 1, lowerX);
    return mean * Math.max(0, upperMoment - lowerMoment) / mass;
  };
  let offset = 0;
  for (let index = 0; index < lowerCount; index += 1) {
    const lower = lowerProbability * index / lowerCount;
    const upper = lowerProbability * (index + 1) / lowerCount;
    values[offset] = intervalMean(lower, upper);
    weights[offset] = lowerProbability / lowerCount;
    offset += 1;
  }
  for (let index = 0; index < positiveCount; index += 1) {
    const lower = lowerProbability + positiveProbability * index / positiveCount;
    const upper = lowerProbability + positiveProbability * (index + 1) / positiveCount;
    values[offset] = intervalMean(lower, upper);
    weights[offset] = positiveProbability / positiveCount;
    positiveMask[offset] = 1;
    offset += 1;
  }
  let weightTotal = 0;
  for (const weight of weights) weightTotal += weight;
  if (weightTotal > 0) for (let index = 0; index < weights.length; index += 1) weights[index] = weights[index]! / weightTotal;
  return { values, weights, positiveMask, positiveProbability };
}

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

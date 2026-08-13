function logGamma(value: number): number {
  const coefficients = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (value < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) - logGamma(1 - value);
  const z = value - 1;
  let series = coefficients[0]!;
  for (let index = 1; index < coefficients.length; index += 1) series += coefficients[index]! / (z + index);
  const t = z + 7.5;
  return 0.9189385332046727 + (z + 0.5) * Math.log(t) - t + Math.log(series);
}

function gammaP(shape: number, x: number): number {
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
    d = Math.abs(an * d + b) < tiny ? tiny : an * d + b;
    c = Math.abs(b + an / c) < tiny ? tiny : b + an / c;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) <= 2e-15) break;
  }
  return Math.max(0, Math.min(1, 1 - Math.exp(-x + shape * Math.log(x) - gln) * h));
}

function gammaQuantile(shape: number, probability: number): number {
  let upper = Math.max(1, shape);
  while (gammaP(shape, upper) < probability) upper *= 2;
  let lowerLog = -744;
  let upperLog = Math.log(upper);
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const middle = (lowerLog + upperLog) / 2;
    if (gammaP(shape, Math.exp(middle)) < probability) lowerLog = middle;
    else upperLog = middle;
  }
  return Math.exp((lowerLog + upperLog) / 2);
}

/** Equal-probability Gamma categories represented by exact conditional means. */
export function discreteGammaRates(shape: number, count = 4): { readonly rates: Float64Array; readonly weights: Float64Array } {
  if (!(shape > 0) || !Number.isFinite(shape) || !Number.isInteger(count) || count < 1 || count > 16) throw new RangeError("Discrete-Gamma shape/count is invalid.");
  if (count === 1) return { rates: Float64Array.of(1), weights: Float64Array.of(1) };
  const rates = new Float64Array(count);
  const weights = new Float64Array(count).fill(1 / count);
  for (let index = 0; index < count; index += 1) {
    const lower = index / count;
    const upper = (index + 1) / count;
    const lowerMoment = lower === 0 ? 0 : gammaP(shape + 1, gammaQuantile(shape, lower));
    const upperMoment = upper === 1 ? 1 : gammaP(shape + 1, gammaQuantile(shape, upper));
    rates[index] = (upperMoment - lowerMoment) * count;
  }
  return { rates, weights };
}

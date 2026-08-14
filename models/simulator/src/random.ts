/** Small deterministic PRNG with a full 32-bit seed path, suitable for reproducible simulations. */
export class Random {
  private state: number;
  private spareNormal: number | undefined;

  constructor(seed: number) {
    this.state = (seed | 0) || 0x6d2b79f5;
  }

  uniform(): number {
    let t = this.state += 0x6d2b79f5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    return value === 0 ? Number.MIN_VALUE : value;
  }

  exponential(rate = 1): number {
    if (!(rate > 0) || !Number.isFinite(rate)) throw new RangeError("Exponential rate must be finite and positive.");
    return -Math.log(this.uniform()) / rate;
  }

  normal(): number {
    if (this.spareNormal !== undefined) {
      const value = this.spareNormal;
      this.spareNormal = undefined;
      return value;
    }
    const radius = Math.sqrt(-2 * Math.log(this.uniform()));
    const angle = 2 * Math.PI * this.uniform();
    this.spareNormal = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  }

  gamma(shape: number, scale = 1): number {
    if (!(shape > 0) || !(scale > 0)) throw new RangeError("Gamma shape and scale must be positive.");
    if (shape < 1) return this.gamma(shape + 1, scale) * Math.pow(this.uniform(), 1 / shape);
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      const x = this.normal();
      const v0 = 1 + c * x;
      if (v0 <= 0) continue;
      const v = v0 * v0 * v0;
      const u = this.uniform();
      if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return scale * d * v;
    }
  }

  poisson(mean: number): number {
    if (!(mean >= 0) || !Number.isFinite(mean)) throw new RangeError("Poisson mean must be finite and non-negative.");
    if (mean === 0) return 0;
    if (mean < 30) {
      const limit = Math.exp(-mean);
      let product = 1;
      let count = 0;
      do { product *= this.uniform(); count += 1; } while (product > limit);
      return count - 1;
    }
    // Rejection is unnecessary for simulation UI purposes at large means; this
    // continuity-corrected normal approximation has negligible relative error.
    return Math.max(0, Math.floor(mean + Math.sqrt(mean) * this.normal() + 0.5));
  }

  integer(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) throw new RangeError("Integer bound must be positive.");
    return Math.floor(this.uniform() * maxExclusive);
  }

  weighted(weights: ArrayLike<number>): number {
    let total = 0;
    for (let i = 0; i < weights.length; i += 1) total += Math.max(0, weights[i]!);
    if (!(total > 0)) throw new RangeError("At least one sampling weight must be positive.");
    let draw = this.uniform() * total;
    for (let i = 0; i < weights.length; i += 1) {
      draw -= Math.max(0, weights[i]!);
      if (draw <= 0) return i;
    }
    return weights.length - 1;
  }

  shuffle<T>(values: T[]): void {
    for (let i = values.length - 1; i > 0; i -= 1) {
      const j = this.integer(i + 1);
      [values[i], values[j]] = [values[j]!, values[i]!];
    }
  }
}

export function drawMarginal(spec: { readonly kind: "fixed" | "gamma"; readonly mean: number; readonly shape?: number }, rng: Random): number {
  if (!(spec.mean >= 0) || !Number.isFinite(spec.mean)) throw new RangeError("Distribution mean must be finite and non-negative.");
  if (spec.kind === "fixed" || spec.mean === 0) return spec.mean;
  const shape = spec.shape ?? 1;
  return rng.gamma(shape, spec.mean / shape);
}

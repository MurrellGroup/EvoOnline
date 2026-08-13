export interface FixedGtrInput {
  /** Equilibrium frequencies in A, C, G, T order. */
  readonly frequencies: ArrayLike<number>;
  /** Symmetric exchangeabilities in AC, AG, AT, CG, CT, GT order. */
  readonly exchangeabilities: ArrayLike<number>;
}

export interface GtrTransition {
  /** Row-major P(parent state, child state). */
  readonly matrix: Float64Array;
  /** Derivative with respect to the unscaled branch length. */
  readonly derivative: Float64Array;
}

const PAIRS: readonly (readonly [number, number])[] = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];

function validatePositive(values: ArrayLike<number>, length: number, label: string): Float64Array {
  if (values.length !== length) throw new RangeError(`${label} requires ${length} values.`);
  const result = Float64Array.from(values);
  if (result.some((value) => !(value > 0) || !Number.isFinite(value))) throw new RangeError(`${label} values must be finite and positive.`);
  return result;
}

/** Jacobi diagonalization for a real symmetric 4x4 matrix. */
function symmetricEigen4(input: Float64Array): { readonly values: Float64Array; readonly vectors: Float64Array } {
  const a = input.slice();
  const vectors = new Float64Array(16);
  for (let index = 0; index < 4; index += 1) vectors[index * 4 + index] = 1;
  for (let sweep = 0; sweep < 64; sweep += 1) {
    let p = 0;
    let q = 1;
    let largest = 0;
    for (let row = 0; row < 4; row += 1) {
      for (let column = row + 1; column < 4; column += 1) {
        const magnitude = Math.abs(a[row * 4 + column]!);
        if (magnitude > largest) { largest = magnitude; p = row; q = column; }
      }
    }
    if (largest <= 2e-15) break;
    const app = a[p * 4 + p]!;
    const aqq = a[q * 4 + q]!;
    const apq = a[p * 4 + q]!;
    const tau = (aqq - app) / (2 * apq);
    const t = (tau >= 0 ? 1 : -1) / (Math.abs(tau) + Math.sqrt(1 + tau * tau));
    const c = 1 / Math.sqrt(1 + t * t);
    const s = t * c;
    for (let k = 0; k < 4; k += 1) {
      if (k === p || k === q) continue;
      const akp = a[k * 4 + p]!;
      const akq = a[k * 4 + q]!;
      const nextP = c * akp - s * akq;
      const nextQ = s * akp + c * akq;
      a[k * 4 + p] = nextP;
      a[p * 4 + k] = nextP;
      a[k * 4 + q] = nextQ;
      a[q * 4 + k] = nextQ;
    }
    a[p * 4 + p] = app - t * apq;
    a[q * 4 + q] = aqq + t * apq;
    a[p * 4 + q] = 0;
    a[q * 4 + p] = 0;
    for (let k = 0; k < 4; k += 1) {
      const vkp = vectors[k * 4 + p]!;
      const vkq = vectors[k * 4 + q]!;
      vectors[k * 4 + p] = c * vkp - s * vkq;
      vectors[k * 4 + q] = s * vkp + c * vkq;
    }
  }
  const order = [0, 1, 2, 3].sort((left, right) => a[right * 4 + right]! - a[left * 4 + left]!);
  const values = Float64Array.from(order, (index) => a[index * 4 + index]!);
  const sorted = new Float64Array(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) sorted[row * 4 + column] = vectors[row * 4 + order[column]!]!;
  }
  return { values, vectors: sorted };
}

export class FixedGtrModel {
  readonly frequencies: Float64Array;
  readonly exchangeabilities: Float64Array;
  readonly generator: Float64Array;
  private readonly eigenvalues: Float64Array;
  private readonly eigenvectors: Float64Array;
  private readonly squareRoots: Float64Array;

  constructor(input: FixedGtrInput) {
    const frequencies = validatePositive(input.frequencies, 4, "GTR equilibrium frequencies");
    const total = frequencies.reduce((sum, value) => sum + value, 0);
    for (let index = 0; index < 4; index += 1) frequencies[index] = frequencies[index]! / total;
    const exchangeabilities = validatePositive(input.exchangeabilities, 6, "GTR exchangeabilities");
    const generator = new Float64Array(16);
    for (let pair = 0; pair < PAIRS.length; pair += 1) {
      const [left, right] = PAIRS[pair]!;
      const rate = exchangeabilities[pair]!;
      generator[left * 4 + right] = rate * frequencies[right]!;
      generator[right * 4 + left] = rate * frequencies[left]!;
    }
    let expected = 0;
    for (let row = 0; row < 4; row += 1) {
      let leaving = 0;
      for (let column = 0; column < 4; column += 1) if (column !== row) leaving += generator[row * 4 + column]!;
      generator[row * 4 + row] = -leaving;
      expected += frequencies[row]! * leaving;
    }
    if (!(expected > 0)) throw new RangeError("The GTR generator has zero expected substitution rate.");
    for (let index = 0; index < generator.length; index += 1) generator[index] = generator[index]! / expected;
    const squareRoots = Float64Array.from(frequencies, Math.sqrt);
    const symmetric = new Float64Array(16);
    for (let row = 0; row < 4; row += 1) {
      for (let column = 0; column < 4; column += 1) {
        symmetric[row * 4 + column] = squareRoots[row]! * generator[row * 4 + column]! / squareRoots[column]!;
      }
    }
    const eigen = symmetricEigen4(symmetric);
    this.frequencies = frequencies;
    this.exchangeabilities = exchangeabilities;
    this.generator = generator;
    this.eigenvalues = eigen.values;
    this.eigenvectors = eigen.vectors;
    this.squareRoots = squareRoots;
  }

  transition(length: number, rate = 1): GtrTransition {
    if (!(length >= 0) || !Number.isFinite(length) || !(rate >= 0) || !Number.isFinite(rate)) throw new RangeError("Branch length and rate must be finite and nonnegative.");
    const matrix = new Float64Array(16);
    const derivative = new Float64Array(16);
    const time = length * rate;
    for (let row = 0; row < 4; row += 1) {
      for (let column = 0; column < 4; column += 1) {
        let probability = 0;
        let slope = 0;
        for (let component = 0; component < 4; component += 1) {
          const eigenvalue = this.eigenvalues[component]!;
          const basis = this.eigenvectors[row * 4 + component]! * this.eigenvectors[column * 4 + component]!;
          const decay = Math.exp(eigenvalue * time);
          probability += basis * decay;
          slope += basis * eigenvalue * decay;
        }
        const transform = this.squareRoots[column]! / this.squareRoots[row]!;
        const index = row * 4 + column;
        matrix[index] = Math.max(0, probability * transform);
        derivative[index] = slope * transform * rate;
      }
    }
    // Jacobi roundoff can leave row sums a few ulps away from one. Correcting
    // the diagonal preserves stochasticity and the derivative's zero row sum.
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      let derivativeSum = 0;
      for (let column = 0; column < 4; column += 1) {
        sum += matrix[row * 4 + column]!;
        derivativeSum += derivative[row * 4 + column]!;
      }
      matrix[row * 4 + row] = matrix[row * 4 + row]! + 1 - sum;
      derivative[row * 4 + row] = derivative[row * 4 + row]! - derivativeSum;
    }
    return { matrix, derivative };
  }
}

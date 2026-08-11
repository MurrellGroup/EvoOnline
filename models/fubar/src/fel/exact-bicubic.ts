export interface SplineValueGradient {
  readonly value: number;
  readonly dx: number;
  readonly dy: number;
}

export interface SplineAudit {
  readonly maximumNodeError: number;
  readonly fullCubicViolation: number;
  readonly tension: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function index(size: number, alpha: number, beta: number): number {
  return alpha * size + beta;
}

/**
 * Second-order nodal derivatives. They exactly reproduce planes and quadratic
 * log-likelihood bowls, including at the boundary, without fitting a noise model.
 */
function differentiate(values: Float64Array): Float64Array {
  const size = values.length;
  if (size < 2) throw new RangeError("A cubic likelihood spline needs at least two grid points.");
  const derivative = new Float64Array(size);
  if (size === 2) {
    derivative[0] = values[1]! - values[0]!;
    derivative[1] = derivative[0]!;
    return derivative;
  }
  derivative[0] = (-3 * values[0]! + 4 * values[1]! - values[2]!) / 2;
  for (let position = 1; position < size - 1; position += 1) {
    derivative[position] = (values[position + 1]! - values[position - 1]!) / 2;
  }
  derivative[size - 1] = (3 * values[size - 1]! - 4 * values[size - 2]! + values[size - 3]!) / 2;
  return derivative;
}

function locate(coordinate: number, size: number): readonly [number, number] {
  const bounded = clamp(coordinate, 0, size - 1);
  if (bounded === size - 1) return [size - 2, 1];
  const cell = Math.floor(bounded);
  return [cell, bounded - cell];
}

function quadraticAllowance(values: Float64Array, size: number, cellAlpha: number, cellBeta: number): readonly [number, number, number] {
  const alphaStart = Math.max(0, cellAlpha - 1);
  const alphaEnd = Math.min(size - 1, cellAlpha + 2);
  const betaStart = Math.max(0, cellBeta - 1);
  const betaEnd = Math.min(size - 1, cellBeta + 2);
  let localMinimum = Infinity;
  let localMaximum = -Infinity;
  let curvatureAlpha = 0;
  let curvatureBeta = 0;
  let curvatureMixed = 0;
  for (let alpha = alphaStart; alpha <= alphaEnd; alpha += 1) {
    for (let beta = betaStart; beta <= betaEnd; beta += 1) {
      const value = values[index(size, alpha, beta)]!;
      localMinimum = Math.min(localMinimum, value);
      localMaximum = Math.max(localMaximum, value);
      if (alpha > 0 && alpha < size - 1) {
        curvatureAlpha = Math.max(curvatureAlpha, Math.abs(
          values[index(size, alpha - 1, beta)]! - 2 * value + values[index(size, alpha + 1, beta)]!,
        ));
      }
      if (beta > 0 && beta < size - 1) {
        curvatureBeta = Math.max(curvatureBeta, Math.abs(
          values[index(size, alpha, beta - 1)]! - 2 * value + values[index(size, alpha, beta + 1)]!,
        ));
      }
      if (alpha > 0 && alpha < size - 1 && beta > 0 && beta < size - 1) {
        curvatureMixed = Math.max(curvatureMixed, Math.abs((
          values[index(size, alpha + 1, beta + 1)]!
          - values[index(size, alpha + 1, beta - 1)]!
          - values[index(size, alpha - 1, beta + 1)]!
          + values[index(size, alpha - 1, beta - 1)]!
        ) / 4));
      }
    }
  }
  // A quadratic whose vertex lies at the centre of a unit cell rises by at
  // most |f_xx|/8 + |f_yy|/8 + |f_xy|/4 above its sampled corners.
  const allowance = Math.max(1e-10, (curvatureAlpha + curvatureBeta) / 8 + curvatureMixed / 4);
  return [localMinimum - allowance, localMaximum + allowance, allowance];
}

/**
 * Nodal-exact, local bicubic interpolation for a square relative-log-L grid.
 * A single deterministic tension is selected for the entire surface. Full
 * cubic interpolation is retained unless dense cell audits exceed the local
 * curvature envelope; blending toward the exact bilinear surface then removes
 * the excess while preserving every node and every shared cell boundary.
 */
export class ExactBicubicLogLikelihoodSpline {
  readonly size: number;
  readonly audit: SplineAudit;
  readonly #values: Float64Array;
  readonly #dx: Float64Array;
  readonly #dy: Float64Array;
  readonly #dxy: Float64Array;

  constructor(input: ArrayLike<number>, size: number, forcedTension?: number) {
    if (!Number.isInteger(size) || size < 2 || input.length !== size * size) {
      throw new RangeError("Likelihood surface dimensions do not match its square grid size.");
    }
    this.size = size;
    this.#values = Float64Array.from(input);
    for (const value of this.#values) {
      if (!Number.isFinite(value)) throw new RangeError("Likelihood spline input must contain only finite log likelihoods.");
    }
    this.#dx = new Float64Array(this.#values.length);
    this.#dy = new Float64Array(this.#values.length);
    this.#dxy = new Float64Array(this.#values.length);

    const line = new Float64Array(size);
    for (let beta = 0; beta < size; beta += 1) {
      for (let alpha = 0; alpha < size; alpha += 1) line[alpha] = this.#values[index(size, alpha, beta)]!;
      const derivative = differentiate(line);
      for (let alpha = 0; alpha < size; alpha += 1) this.#dx[index(size, alpha, beta)] = derivative[alpha]!;
    }
    for (let alpha = 0; alpha < size; alpha += 1) {
      for (let beta = 0; beta < size; beta += 1) line[beta] = this.#values[index(size, alpha, beta)]!;
      const derivative = differentiate(line);
      for (let beta = 0; beta < size; beta += 1) this.#dy[index(size, alpha, beta)] = derivative[beta]!;
    }

    const mixedFromDx = new Float64Array(this.#values.length);
    const mixedFromDy = new Float64Array(this.#values.length);
    for (let alpha = 0; alpha < size; alpha += 1) {
      for (let beta = 0; beta < size; beta += 1) line[beta] = this.#dx[index(size, alpha, beta)]!;
      const derivative = differentiate(line);
      for (let beta = 0; beta < size; beta += 1) mixedFromDx[index(size, alpha, beta)] = derivative[beta]!;
    }
    for (let beta = 0; beta < size; beta += 1) {
      for (let alpha = 0; alpha < size; alpha += 1) line[alpha] = this.#dy[index(size, alpha, beta)]!;
      const derivative = differentiate(line);
      for (let alpha = 0; alpha < size; alpha += 1) mixedFromDy[index(size, alpha, beta)] = derivative[alpha]!;
    }
    for (let position = 0; position < this.#dxy.length; position += 1) {
      this.#dxy[position] = (mixedFromDx[position]! + mixedFromDy[position]!) / 2;
    }

    if (forcedTension !== undefined && (!Number.isFinite(forcedTension) || forcedTension < 0 || forcedTension > 1)) {
      throw new RangeError("Forced likelihood spline tension must be between zero and one.");
    }
    let safeTension = forcedTension ?? 1;
    let fullCubicViolation = 0;
    if (forcedTension === undefined) {
      const sampleCoordinates = [0.25, 0.5, 0.75] as const;
      for (let alpha = 0; alpha < size - 1; alpha += 1) {
        for (let beta = 0; beta < size - 1; beta += 1) {
          const [lower, upper] = quadraticAllowance(this.#values, size, alpha, beta);
          for (const u of sampleCoordinates) {
            for (const v of sampleCoordinates) {
              const cubic = this.#evaluateCell(alpha, beta, u, v, 1).value;
              const linear = this.#evaluateCell(alpha, beta, u, v, 0).value;
              if (cubic > upper) {
                const violation = cubic - upper;
                fullCubicViolation = Math.max(fullCubicViolation, violation);
                if (cubic > linear) safeTension = Math.min(safeTension, (upper - linear) / (cubic - linear));
              } else if (cubic < lower) {
                const violation = lower - cubic;
                fullCubicViolation = Math.max(fullCubicViolation, violation);
                if (cubic < linear) safeTension = Math.min(safeTension, (linear - lower) / (linear - cubic));
              }
            }
          }
        }
      }
    }
    const tension = forcedTension ?? clamp(safeTension < 1 ? safeTension * 0.995 : 1, 0, 1);
    let maximumNodeError = 0;
    for (let alpha = 0; alpha < size; alpha += 1) {
      for (let beta = 0; beta < size; beta += 1) {
        maximumNodeError = Math.max(maximumNodeError, Math.abs(
          this.#evaluate(alpha, beta, tension).value - this.#values[index(size, alpha, beta)]!,
        ));
      }
    }
    this.audit = { maximumNodeError, fullCubicViolation, tension };
  }

  evaluate(alpha: number, beta: number): number {
    return this.#evaluate(alpha, beta, this.audit.tension).value;
  }

  evaluateWithGradient(alpha: number, beta: number): SplineValueGradient {
    return this.#evaluate(alpha, beta, this.audit.tension);
  }

  evaluateCellWithGradient(cellAlpha: number, cellBeta: number, u: number, v: number): SplineValueGradient {
    if (cellAlpha < 0 || cellAlpha >= this.size - 1 || cellBeta < 0 || cellBeta >= this.size - 1) {
      throw new RangeError("Likelihood spline cell is outside the grid.");
    }
    return this.#evaluateCell(cellAlpha, cellBeta, clamp(u, 0, 1), clamp(v, 0, 1), this.audit.tension);
  }

  #evaluate(alpha: number, beta: number, tension: number): SplineValueGradient {
    const [cellAlpha, u] = locate(alpha, this.size);
    const [cellBeta, v] = locate(beta, this.size);
    return this.#evaluateCell(cellAlpha, cellBeta, u, v, tension);
  }

  #evaluateCell(cellAlpha: number, cellBeta: number, u: number, v: number, tension: number): SplineValueGradient {
    const u2 = u * u;
    const u3 = u2 * u;
    const ux0 = 2 * u3 - 3 * u2 + 1;
    const ux1 = -2 * u3 + 3 * u2;
    const tx0 = u3 - 2 * u2 + u;
    const tx1 = u3 - u2;
    const dux0 = 6 * u2 - 6 * u;
    const dux1 = -dux0;
    const dtx0 = 3 * u2 - 4 * u + 1;
    const dtx1 = 3 * u2 - 2 * u;
    const v2 = v * v;
    const v3 = v2 * v;
    const uy0 = 2 * v3 - 3 * v2 + 1;
    const uy1 = -2 * v3 + 3 * v2;
    const ty0 = v3 - 2 * v2 + v;
    const ty1 = v3 - v2;
    const duy0 = 6 * v2 - 6 * v;
    const duy1 = -duy0;
    const dty0 = 3 * v2 - 4 * v + 1;
    const dty1 = 3 * v2 - 2 * v;
    let cubic = 0;
    let cubicDx = 0;
    let cubicDy = 0;
    let linear = 0;
    let linearDx = 0;
    let linearDy = 0;
    for (let cornerAlpha = 0; cornerAlpha < 2; cornerAlpha += 1) {
      for (let cornerBeta = 0; cornerBeta < 2; cornerBeta += 1) {
        const ux = cornerAlpha === 0 ? ux0 : ux1;
        const tx = cornerAlpha === 0 ? tx0 : tx1;
        const dux = cornerAlpha === 0 ? dux0 : dux1;
        const dtx = cornerAlpha === 0 ? dtx0 : dtx1;
        const uy = cornerBeta === 0 ? uy0 : uy1;
        const ty = cornerBeta === 0 ? ty0 : ty1;
        const duy = cornerBeta === 0 ? duy0 : duy1;
        const dty = cornerBeta === 0 ? dty0 : dty1;
        const position = index(this.size, cellAlpha + cornerAlpha, cellBeta + cornerBeta);
        const f = this.#values[position]!;
        const fx = this.#dx[position]!;
        const fy = this.#dy[position]!;
        const fxy = this.#dxy[position]!;
        cubic += f * ux * uy + fx * tx * uy + fy * ux * ty + fxy * tx * ty;
        cubicDx += f * dux * uy + fx * dtx * uy + fy * dux * ty + fxy * dtx * ty;
        cubicDy += f * ux * duy + fx * tx * duy + fy * ux * dty + fxy * tx * dty;
        const wx = cornerAlpha === 0 ? 1 - u : u;
        const wy = cornerBeta === 0 ? 1 - v : v;
        const dwx = cornerAlpha === 0 ? -1 : 1;
        const dwy = cornerBeta === 0 ? -1 : 1;
        linear += f * wx * wy;
        linearDx += f * dwx * wy;
        linearDy += f * wx * dwy;
      }
    }
    const linearWeight = 1 - tension;
    return {
      value: tension * cubic + linearWeight * linear,
      dx: tension * cubicDx + linearWeight * linearDx,
      dy: tension * cubicDy + linearWeight * linearDy,
    };
  }
}

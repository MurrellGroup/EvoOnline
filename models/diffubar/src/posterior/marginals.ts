import type { DifFUBARGrid, PosteriorMarginals } from "../types.js";

function exactIndex(values: Float64Array): Map<number, number> {
  const index = new Map<number, number>();
  for (let position = 0; position < values.length; position += 1) {
    index.set(values[position]!, position);
  }
  return index;
}

/**
 * Collapse the Julia-compatible category × site allocation grid into the
 * alpha, omega1, and omega2 marginals used by the paper figures.
 */
export function collapsePosteriorMarginals(
  allocations: Uint32Array,
  retainedIterations: number,
  grid: DifFUBARGrid,
  siteCount: number,
): PosteriorMarginals {
  if (allocations.length !== grid.categoryCount * siteCount) {
    throw new RangeError("Allocation table dimensions do not match the DifFUBAR grid and site count.");
  }
  if (!(retainedIterations > 0 && Number.isInteger(retainedIterations))) {
    throw new RangeError("Retained sampler iterations must be a positive integer.");
  }

  const alpha = new Float32Array(siteCount * grid.alpha.length);
  const omega1 = new Float32Array(siteCount * grid.omega.length);
  const omega2 = new Float32Array(siteCount * grid.omega.length);
  const alphaIndex = exactIndex(grid.alpha);
  const omegaIndex = exactIndex(grid.omega);

  for (let category = 0; category < grid.categoryCount; category += 1) {
    const parameterOffset = category * grid.parameterCount;
    const alphaBin = alphaIndex.get(grid.categories[parameterOffset]!);
    const omega1Bin = omegaIndex.get(grid.categories[parameterOffset + 1]!);
    const omega2Bin = omegaIndex.get(grid.categories[parameterOffset + 2]!);
    if (alphaBin === undefined || omega1Bin === undefined || omega2Bin === undefined) {
      throw new RangeError("A category value is absent from its declared DifFUBAR parameter grid.");
    }
    const allocationOffset = category * siteCount;
    for (let site = 0; site < siteCount; site += 1) {
      const count = allocations[allocationOffset + site]!;
      if (count === 0) continue;
      const alphaOffset = site * grid.alpha.length + alphaBin;
      const omega1Offset = site * grid.omega.length + omega1Bin;
      const omega2Offset = site * grid.omega.length + omega2Bin;
      alpha[alphaOffset] = alpha[alphaOffset]! + count;
      omega1[omega1Offset] = omega1[omega1Offset]! + count;
      omega2[omega2Offset] = omega2[omega2Offset]! + count;
    }
  }

  const inverseRetained = 1 / retainedIterations;
  for (let index = 0; index < alpha.length; index += 1) alpha[index] = alpha[index]! * inverseRetained;
  for (let index = 0; index < omega1.length; index += 1) omega1[index] = omega1[index]! * inverseRetained;
  for (let index = 0; index < omega2.length; index += 1) omega2[index] = omega2[index]! * inverseRetained;

  return {
    siteCount,
    alphaValues: grid.alpha.slice(),
    omegaValues: grid.omega.slice(),
    alpha,
    omega1,
    omega2,
  };
}

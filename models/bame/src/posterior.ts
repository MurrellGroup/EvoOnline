import type {
  FameGrid,
  FamePosteriorProducts,
  FameSiteResult,
  FlavorGrid,
  FlavorPosteriorProducts,
  FlavorSiteResult,
} from "./types.js";

interface PosteriorAccessor {
  readonly massAt: (category: number, site: number) => number;
  readonly theta: Float64Array;
}

function empiricalBayesFactor(posterior: number, prior: number): number {
  if (posterior <= 0) return 0;
  if (posterior >= 1) return Number.POSITIVE_INFINITY;
  if (prior <= 0) return Number.POSITIVE_INFINITY;
  if (prior >= 1) return 0;
  return (posterior / (1 - posterior)) * ((1 - prior) / prior);
}

function emAccessor(
  conditionals: Float64Array,
  theta: Float64Array,
  categoryCount: number,
  siteCount: number,
): PosteriorAccessor {
  if (conditionals.length !== categoryCount * siteCount || theta.length !== categoryCount) throw new RangeError("BAME posterior dimensions do not match.");
  const denominators = new Float64Array(siteCount);
  for (let category = 0; category < categoryCount; category += 1) {
    const offset = category * siteCount;
    for (let site = 0; site < siteCount; site += 1) denominators[site] = denominators[site]! + theta[category]! * conditionals[offset + site]!;
  }
  for (let site = 0; site < siteCount; site += 1) if (!(denominators[site]! > 0)) throw new RangeError(`BAME posterior is undefined at codon site ${site + 1}.`);
  return {
    theta,
    massAt: (category, site) => theta[category]! * conditionals[category * siteCount + site]! / denominators[site]!,
  };
}

function allocationAccessor(
  allocations: Uint32Array,
  retainedIterations: number,
  theta: Float64Array,
  categoryCount: number,
  siteCount: number,
): PosteriorAccessor {
  if (allocations.length !== categoryCount * siteCount || retainedIterations <= 0) throw new RangeError("BAME Gibbs allocation dimensions do not match.");
  for (let site = 0; site < siteCount; site += 1) {
    let total = 0;
    for (let category = 0; category < categoryCount; category += 1) total += allocations[category * siteCount + site]!;
    if (total !== retainedIterations) throw new RangeError(`BAME Gibbs allocations are incomplete at codon site ${site + 1}.`);
  }
  return { theta, massAt: (category, site) => allocations[category * siteCount + site]! / retainedIterations };
}

export function positivePrior(theta: Float64Array, mask: ArrayLike<number>): number {
  if (theta.length !== mask.length) throw new RangeError("Positive-selection mask and mixture weights differ in length.");
  let total = 0;
  for (let category = 0; category < theta.length; category += 1) if (mask[category] !== 0) total += theta[category]!;
  return total;
}

function postprocessFameWithAccessor(
  accessor: PosteriorAccessor,
  grid: FameGrid,
  siteCount: number,
  threshold: number,
): { readonly sites: readonly FameSiteResult[]; readonly posterior: FamePosteriorProducts; readonly prior: number } {
  const surfaces = new Float32Array(siteCount * grid.categoryCount);
  const alpha = new Float32Array(siteCount * grid.alphaValues.length);
  const omega1 = new Float32Array(siteCount * grid.omega1Values.length);
  const omega2 = new Float32Array(siteCount * grid.omega2Values.length);
  const mask = new Uint8Array(grid.categoryCount);
  for (let category = 0; category < grid.categoryCount; category += 1) mask[category] = grid.categories[category * 3 + 2]! > 1 ? 1 : 0;
  const prior = positivePrior(accessor.theta, mask);
  const sites: FameSiteResult[] = [];
  for (let site = 0; site < siteCount; site += 1) {
    let pPositive = 0;
    let meanAlpha = 0;
    let meanOmega1 = 0;
    let meanOmega2 = 0;
    for (let category = 0; category < grid.categoryCount; category += 1) {
      const mass = accessor.massAt(category, site);
      surfaces[site * grid.categoryCount + category] = mass;
      const a = grid.alphaIndex[category]!;
      const first = grid.omega1Index[category]!;
      const second = grid.omega2Index[category]!;
      alpha[site * grid.alphaValues.length + a] = alpha[site * grid.alphaValues.length + a]! + mass;
      omega1[site * grid.omega1Values.length + first] = omega1[site * grid.omega1Values.length + first]! + mass;
      omega2[site * grid.omega2Values.length + second] = omega2[site * grid.omega2Values.length + second]! + mass;
      if (mask[category] === 1) pPositive += mass;
      meanAlpha += mass * grid.alphaValues[a]!;
      meanOmega1 += mass * grid.omega1Values[first]!;
      meanOmega2 += mass * grid.omega2Values[second]!;
    }
    sites.push({
      site: site + 1,
      pPositive,
      bayesFactor: empiricalBayesFactor(pPositive, prior),
      meanAlpha,
      meanOmega1,
      meanOmega2,
      detected: pPositive > threshold,
    });
  }
  return {
    sites,
    posterior: {
      siteCount,
      alphaValues: grid.alphaValues.slice(),
      omega1Values: grid.omega1Values.slice(),
      omega2Values: grid.omega2Values.slice(),
      surfaces,
      alpha,
      omega1,
      omega2,
    },
    prior,
  };
}

export function postprocessFame(
  conditionals: Float64Array,
  theta: Float64Array,
  grid: FameGrid,
  siteCount: number,
  threshold: number,
) {
  return postprocessFameWithAccessor(emAccessor(conditionals, theta, grid.categoryCount, siteCount), grid, siteCount, threshold);
}

export function postprocessFameAllocations(
  allocations: Uint32Array,
  retainedIterations: number,
  theta: Float64Array,
  grid: FameGrid,
  siteCount: number,
  threshold: number,
) {
  return postprocessFameWithAccessor(allocationAccessor(allocations, retainedIterations, theta, grid.categoryCount, siteCount), grid, siteCount, threshold);
}

function postprocessFlavorWithAccessor(
  accessor: PosteriorAccessor,
  grid: FlavorGrid,
  siteCount: number,
  threshold: number,
): { readonly sites: readonly FlavorSiteResult[]; readonly posterior: FlavorPosteriorProducts; readonly prior: number } {
  const surfaces = new Float32Array(siteCount * grid.categoryCount);
  const mu = new Float32Array(siteCount * grid.muValues.length);
  const shape = new Float32Array(siteCount * grid.shapeValues.length);
  const alpha = new Float32Array(siteCount * grid.alphaValues.length);
  const capState = new Float32Array(siteCount * 2);
  const prior = positivePrior(accessor.theta, grid.positiveMask);
  const sites: FlavorSiteResult[] = [];
  for (let site = 0; site < siteCount; site += 1) {
    let pPositive = 0;
    let pUncapped = 0;
    let meanAlpha = 0;
    let meanOmega = 0;
    let meanShape = 0;
    let meanOmegaStandardDeviation = 0;
    let meanPositiveBranchFraction = 0;
    for (let category = 0; category < grid.categoryCount; category += 1) {
      const mass = accessor.massAt(category, site);
      surfaces[site * grid.categoryCount + category] = mass;
      const muIndex = grid.muIndex[category]!;
      const shapeIndex = grid.shapeIndex[category]!;
      const alphaIndex = grid.alphaIndex[category]!;
      const cap = grid.capped[category]!;
      const mean = grid.muValues[muIndex]!;
      const shapeValue = grid.shapeValues[shapeIndex]!;
      mu[site * grid.muValues.length + muIndex] = mu[site * grid.muValues.length + muIndex]! + mass;
      shape[site * grid.shapeValues.length + shapeIndex] = shape[site * grid.shapeValues.length + shapeIndex]! + mass;
      alpha[site * grid.alphaValues.length + alphaIndex] = alpha[site * grid.alphaValues.length + alphaIndex]! + mass;
      capState[site * 2 + cap] = capState[site * 2 + cap]! + mass;
      if (grid.positiveMask[category] === 1) pPositive += mass;
      if (cap === 0) pUncapped += mass;
      meanAlpha += mass * grid.alphaValues[alphaIndex]!;
      meanOmega += mass * mean;
      meanShape += mass * shapeValue;
      meanOmegaStandardDeviation += mass * mean / Math.sqrt(shapeValue);
      meanPositiveBranchFraction += mass * grid.positiveBranchFraction[category]!;
    }
    sites.push({
      site: site + 1,
      pPositive,
      pUncapped,
      bayesFactor: empiricalBayesFactor(pPositive, prior),
      meanAlpha,
      meanOmega,
      meanShape,
      meanOmegaStandardDeviation,
      meanPositiveBranchFraction,
      detected: pPositive > threshold,
    });
  }
  return {
    sites,
    posterior: {
      siteCount,
      muValues: grid.muValues.slice(),
      shapeValues: grid.shapeValues.slice(),
      alphaValues: grid.alphaValues.slice(),
      surfaces,
      mu,
      shape,
      alpha,
      capState,
    },
    prior,
  };
}

export function postprocessFlavor(
  conditionals: Float64Array,
  theta: Float64Array,
  grid: FlavorGrid,
  siteCount: number,
  threshold: number,
) {
  return postprocessFlavorWithAccessor(emAccessor(conditionals, theta, grid.categoryCount, siteCount), grid, siteCount, threshold);
}

export function postprocessFlavorAllocations(
  allocations: Uint32Array,
  retainedIterations: number,
  theta: Float64Array,
  grid: FlavorGrid,
  siteCount: number,
  threshold: number,
) {
  return postprocessFlavorWithAccessor(allocationAccessor(allocations, retainedIterations, theta, grid.categoryCount, siteCount), grid, siteCount, threshold);
}

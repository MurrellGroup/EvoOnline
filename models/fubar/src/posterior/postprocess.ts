import type {
  FubarGrid,
  FubarPosteriorProducts,
  FubarSelection,
  FubarSiteResult,
} from "../types.js";

export interface FubarPostprocessResult {
  readonly sites: readonly FubarSiteResult[];
  readonly posterior: FubarPosteriorProducts;
}

function postprocessMasses(
  grid: FubarGrid,
  siteCount: number,
  threshold: number,
  massAt: (category: number, site: number) => number,
): FubarPostprocessResult {
  const gridSize = grid.values.length;
  const surfaces = new Float32Array(siteCount * grid.categoryCount);
  const alphaMarginals = new Float32Array(siteCount * gridSize);
  const betaMarginals = new Float32Array(siteCount * gridSize);
  const sites: FubarSiteResult[] = [];

  for (let site = 0; site < siteCount; site += 1) {
    let pPositive = 0;
    let pPurifying = 0;
    let meanAlpha = 0;
    let meanBeta = 0;
    const surfaceOffset = site * grid.categoryCount;
    const marginalOffset = site * gridSize;
    for (let category = 0; category < grid.categoryCount; category += 1) {
      const alphaIndex = grid.alphaIndex[category]!;
      const betaIndex = grid.betaIndex[category]!;
      const mass = massAt(category, site);
      surfaces[surfaceOffset + category] = mass;
      const alphaOffset = marginalOffset + alphaIndex;
      const betaOffset = marginalOffset + betaIndex;
      alphaMarginals[alphaOffset] = alphaMarginals[alphaOffset]! + mass;
      betaMarginals[betaOffset] = betaMarginals[betaOffset]! + mass;
      if (betaIndex > alphaIndex) pPositive += mass;
      else if (betaIndex < alphaIndex) pPurifying += mass;
      meanAlpha += mass * grid.values[alphaIndex]!;
      meanBeta += mass * grid.values[betaIndex]!;
    }
    const selection: FubarSelection = pPositive > threshold
      ? "positive"
      : pPurifying > threshold
        ? "purifying"
        : "none";
    sites.push({ site: site + 1, pPositive, pPurifying, meanAlpha, meanBeta, selection });
  }
  return {
    sites,
    posterior: {
      siteCount,
      gridSize,
      gridValues: grid.values.slice(),
      surfaces,
      alpha: alphaMarginals,
      beta: betaMarginals,
    },
  };
}

export function postprocessFubar(
  conditionals: Float64Array,
  theta: Float64Array,
  grid: FubarGrid,
  siteCount: number,
  threshold: number,
): FubarPostprocessResult {
  if (conditionals.length !== grid.categoryCount * siteCount || theta.length !== grid.categoryCount) {
    throw new RangeError("FUBAR posterior dimensions do not match the likelihood grid.");
  }
  const denominators = new Float64Array(siteCount);
  for (let site = 0; site < siteCount; site += 1) {
    for (let category = 0; category < grid.categoryCount; category += 1) {
      denominators[site] = denominators[site]! + theta[category]! * conditionals[category * siteCount + site]!;
    }
    if (!(denominators[site]! > 0)) throw new RangeError(`FUBAR posterior is undefined at codon site ${site + 1}.`);
  }
  return postprocessMasses(
    grid,
    siteCount,
    threshold,
    (category, site) => theta[category]! * conditionals[category * siteCount + site]! / denominators[site]!,
  );
}

/** Collapse exact Gibbs allocation counts into the same products used by EM. */
export function postprocessFubarAllocations(
  allocations: Uint32Array,
  retainedIterations: number,
  grid: FubarGrid,
  siteCount: number,
  threshold: number,
): FubarPostprocessResult {
  if (allocations.length !== grid.categoryCount * siteCount) {
    throw new RangeError("FUBAR Gibbs allocation dimensions do not match the likelihood grid.");
  }
  if (!(retainedIterations > 0 && Number.isInteger(retainedIterations))) {
    throw new RangeError("FUBAR Gibbs sampling must retain at least one iteration.");
  }
  for (let site = 0; site < siteCount; site += 1) {
    let total = 0;
    for (let category = 0; category < grid.categoryCount; category += 1) {
      total += allocations[category * siteCount + site]!;
    }
    if (total !== retainedIterations) {
      throw new RangeError(`FUBAR Gibbs allocations are incomplete at codon site ${site + 1}.`);
    }
  }
  return postprocessMasses(
    grid,
    siteCount,
    threshold,
    (category, site) => allocations[category * siteCount + site]! / retainedIterations,
  );
}

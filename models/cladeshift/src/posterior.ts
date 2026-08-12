import type { FubarPosteriorProducts, FubarSiteResult } from "@phylo-workbench/model-fubar";
import type { TreeNode } from "@phylo-workbench/model-diffubar";
import type {
  CladeShiftBranchResult,
  CladeShiftPosteriorProducts,
  CladeShiftSiteResult,
} from "./types.js";

export interface CompressedNullPosterior {
  readonly componentCount: number;
  readonly categories: Uint32Array;
  readonly weights: Float64Array;
  readonly capturedMass: Float64Array;
  readonly retainedCounts: Uint16Array;
}

export function compressNullPosterior(
  posterior: FubarPosteriorProducts,
  maximumComponents: number,
  targetMass = 1,
): CompressedNullPosterior {
  const categoryCount = posterior.gridSize * posterior.gridSize;
  const componentCap = Math.max(1, Math.min(categoryCount, Math.round(maximumComponents)));
  if (!(targetMass > 0 && targetMass <= 1)) throw new RangeError("Null posterior mass target must lie in (0, 1].");
  const retainedCounts = new Uint16Array(posterior.siteCount);
  const capturedMass = new Float64Array(posterior.siteCount);
  const order = new Array<number>(categoryCount);
  const selectedCategories: number[][] = [];
  const selectedWeights: number[][] = [];
  let componentCount = 1;
  for (let site = 0; site < posterior.siteCount; site += 1) {
    for (let category = 0; category < categoryCount; category += 1) order[category] = category;
    const offset = site * categoryCount;
    order.sort((left, right) => posterior.surfaces[offset + right]! - posterior.surfaces[offset + left]! || left - right);
    let total = 0;
    const siteCategories: number[] = [];
    const siteWeights: number[] = [];
    for (let component = 0; component < componentCap && (component === 0 || total < targetMass); component += 1) {
      const category = order[component]!;
      const probability = posterior.surfaces[offset + category]!;
      siteCategories.push(category);
      siteWeights.push(probability);
      total += probability;
    }
    if (!(total > 0)) throw new RangeError(`FUBAR null posterior is empty at codon ${site + 1}.`);
    capturedMass[site] = Math.min(1, total);
    retainedCounts[site] = siteCategories.length;
    componentCount = Math.max(componentCount, siteCategories.length);
    const inverse = 1 / total;
    for (let component = 0; component < siteWeights.length; component += 1) siteWeights[component] = siteWeights[component]! * inverse;
    selectedCategories.push(siteCategories);
    selectedWeights.push(siteWeights);
  }
  // The WASM ABI is rectangular. Shorter site rows are zero-weight padded;
  // the kernel skips them before doing any tree or transition work.
  const categories = new Uint32Array(posterior.siteCount * componentCount);
  const weights = new Float64Array(categories.length);
  for (let site = 0; site < posterior.siteCount; site += 1) {
    const siteCategories = selectedCategories[site]!;
    const siteWeights = selectedWeights[site]!;
    for (let component = 0; component < siteCategories.length; component += 1) {
      const index = site * componentCount + component;
      categories[index] = siteCategories[component]!;
      weights[index] = siteWeights[component]!;
    }
  }
  return { componentCount, categories, weights, capturedMass, retainedCounts };
}

function logAdd(left: number, right: number): number {
  if (left === Number.NEGATIVE_INFINITY) return right;
  if (right === Number.NEGATIVE_INFINITY) return left;
  const maximum = Math.max(left, right);
  return maximum + Math.log(Math.exp(left - maximum) + Math.exp(right - maximum));
}

function probability(logNumerator: number, logDenominator: number): number {
  if (logNumerator === Number.NEGATIVE_INFINITY) return 0;
  return Math.max(0, Math.min(1, Math.exp(Math.min(0, logNumerator - logDenominator))));
}

function branchName(node: TreeNode, edge: number): string {
  if (node.name.length > 0) return node.name;
  return node.children.length === 0 ? `Tip ${node.tipIndex + 1}` : `Internal branch ${edge + 1}`;
}

export interface CladeShiftSummaryInput {
  readonly logLikelihoodRatios: Float64Array;
  readonly intensities: Float64Array;
  readonly candidateBranches: Uint32Array;
  readonly edgeNodes: readonly TreeNode[];
  readonly nodeForEdge: Uint32Array;
  readonly descendantTips: Uint32Array;
  readonly capturedMass: Float64Array;
  readonly baselineSites: readonly FubarSiteResult[];
  readonly shiftPrior: number;
  readonly threshold: number;
}

export interface CladeShiftSummary {
  readonly sites: readonly CladeShiftSiteResult[];
  readonly branches: readonly CladeShiftBranchResult[];
  readonly posterior: CladeShiftPosteriorProducts;
}

/** Fixed-prior empirical-Bayes integration over direction, K, and initiating clade. */
export function summarizeCladeShift(input: CladeShiftSummaryInput): CladeShiftSummary {
  const siteCount = input.baselineSites.length;
  const branchCount = input.edgeNodes.length;
  const candidateCount = input.candidateBranches.length;
  const intensityCount = input.intensities.length;
  const expectedLength = siteCount * candidateCount * intensityCount;
  if (input.logLikelihoodRatios.length !== expectedLength) throw new RangeError("CladeShift likelihood-ratio dimensions are inconsistent.");
  if (!(input.shiftPrior > 0 && input.shiftPrior < 1)) throw new RangeError("CladeShift prior must lie strictly between zero and one.");
  const relaxation = [...input.intensities].map((value, index) => value < 1 ? index : -1).filter((index) => index >= 0);
  const intensification = [...input.intensities].map((value, index) => value > 1 ? index : -1).filter((index) => index >= 0);
  if (relaxation.length === 0 || intensification.length === 0) throw new RangeError("CladeShift requires K states on both sides of one.");

  const branchPosterior = new Float32Array(branchCount * siteCount);
  const branchRelaxation = new Float32Array(branchPosterior.length);
  const branchIntensification = new Float32Array(branchPosterior.length);
  const intensityPosterior = new Float32Array(siteCount * intensityCount);
  const sites: CladeShiftSiteResult[] = [];
  const logNoShiftPrior = Math.log1p(-input.shiftPrior);
  const directionLogPrior = Math.log(input.shiftPrior / 2);

  for (let site = 0; site < siteCount; site += 1) {
    let relaxationSum = Number.NEGATIVE_INFINITY;
    let intensificationSum = Number.NEGATIVE_INFINITY;
    for (let intensity = 0; intensity < intensityCount; intensity += 1) {
      const destination = input.intensities[intensity]! < 1 ? "relaxation" : "intensification";
      for (let candidate = 0; candidate < candidateCount; candidate += 1) {
        const index = (site * intensityCount + intensity) * candidateCount + candidate;
        if (destination === "relaxation") relaxationSum = logAdd(relaxationSum, input.logLikelihoodRatios[index]!);
        else intensificationSum = logAdd(intensificationSum, input.logLikelihoodRatios[index]!);
      }
    }
    const relaxationLogBayesFactor = relaxationSum - Math.log(candidateCount * relaxation.length);
    const intensificationLogBayesFactor = intensificationSum - Math.log(candidateCount * intensification.length);
    const logBayesFactor = logAdd(Math.log(0.5) + relaxationLogBayesFactor, Math.log(0.5) + intensificationLogBayesFactor);
    const logShiftNumerator = Math.log(input.shiftPrior) + logBayesFactor;
    const logDenominator = logAdd(logNoShiftPrior, logShiftNumerator);
    const pRelaxation = probability(directionLogPrior + relaxationLogBayesFactor, logDenominator);
    const pIntensification = probability(directionLogPrior + intensificationLogBayesFactor, logDenominator);
    const pShift = Math.max(0, Math.min(1, pRelaxation + pIntensification));

    let mapBranch = 0;
    let mapBranchPosterior = -1;
    let mapIntensity = input.intensities[0]!;
    let mapHypothesisPosterior = -1;
    let weightedIntensity = 0;
    for (let candidate = 0; candidate < candidateCount; candidate += 1) {
      const edge = input.candidateBranches[candidate]!;
      let edgeRelaxation = 0;
      let edgeIntensification = 0;
      for (let intensity = 0; intensity < intensityCount; intensity += 1) {
        const directionCount = input.intensities[intensity]! < 1 ? relaxation.length : intensification.length;
        const hypothesisPrior = directionLogPrior - Math.log(candidateCount * directionCount);
        const source = (site * intensityCount + intensity) * candidateCount + candidate;
        const joint = probability(hypothesisPrior + input.logLikelihoodRatios[source]!, logDenominator);
        intensityPosterior[site * intensityCount + intensity] = intensityPosterior[site * intensityCount + intensity]! + joint;
        weightedIntensity += joint * input.intensities[intensity]!;
        if (input.intensities[intensity]! < 1) edgeRelaxation += joint;
        else edgeIntensification += joint;
        if (joint > mapHypothesisPosterior) {
          mapHypothesisPosterior = joint;
          mapIntensity = input.intensities[intensity]!;
        }
      }
      const matrixIndex = edge * siteCount + site;
      branchRelaxation[matrixIndex] = edgeRelaxation;
      branchIntensification[matrixIndex] = edgeIntensification;
      branchPosterior[matrixIndex] = edgeRelaxation + edgeIntensification;
      if (branchPosterior[matrixIndex]! > mapBranchPosterior) {
        mapBranchPosterior = branchPosterior[matrixIndex]!;
        mapBranch = edge;
      }
    }
    const detected = pShift >= input.threshold;
    const direction = detected ? (pRelaxation >= pIntensification ? "relaxation" : "intensification") : "none";
    const baseline = input.baselineSites[site]!;
    sites.push({
      site: site + 1,
      pShift,
      pRelaxation,
      pIntensification,
      logBayesFactor,
      relaxationLogBayesFactor,
      intensificationLogBayesFactor,
      direction,
      detected,
      mapBranch: mapBranch + 1,
      mapBranchName: branchName(input.edgeNodes[mapBranch]!, mapBranch),
      mapBranchPosterior: Math.max(0, mapBranchPosterior),
      mapIntensity,
      meanIntensityGivenShift: pShift > 0 ? weightedIntensity / pShift : 1,
      capturedNullPosteriorMass: input.capturedMass[site]!,
      baselineMeanAlpha: baseline.meanAlpha,
      baselineMeanBeta: baseline.meanBeta,
    });
  }

  const eligible = new Set(input.candidateBranches);
  const branches: CladeShiftBranchResult[] = input.edgeNodes.map((node, edge) => {
    let expectedShiftedSites = 0;
    let expectedRelaxedSites = 0;
    let expectedIntensifiedSites = 0;
    let maximumSitePosterior = 0;
    let mapSite = 1;
    for (let site = 0; site < siteCount; site += 1) {
      const index = edge * siteCount + site;
      expectedShiftedSites += branchPosterior[index]!;
      expectedRelaxedSites += branchRelaxation[index]!;
      expectedIntensifiedSites += branchIntensification[index]!;
      if (branchPosterior[index]! > maximumSitePosterior) {
        maximumSitePosterior = branchPosterior[index]!;
        mapSite = site + 1;
      }
    }
    return {
      branch: edge + 1,
      nodeId: node.id,
      nodeIndex: input.nodeForEdge[edge]!,
      name: branchName(node, edge),
      parentName: node.parent?.name || "Root",
      terminal: node.children.length === 0,
      descendantTips: input.descendantTips[edge]!,
      eligible: eligible.has(edge),
      expectedShiftedSites,
      expectedRelaxedSites,
      expectedIntensifiedSites,
      maximumSitePosterior,
      mapSite,
    };
  });
  return {
    sites,
    branches,
    posterior: {
      siteCount,
      branchCount,
      intensities: input.intensities,
      branchPosterior,
      branchRelaxation,
      branchIntensification,
      intensityPosterior,
    },
  };
}

import {
  DifFUBARError,
  type CompiledTree,
  type DifFUBARGrid,
  type FastaAlignment,
  type FittedModel,
  type LikelihoodRequest,
  type LikelihoodResult,
  type ModelBank,
  type ParsedTree,
  type ProgressDetail,
  type RuntimeWorkload,
} from "../types.js";
import {
  buildModelBank,
  codonEquilibriumFromF3x4,
  countF3x4,
  countNucleotideFrequencies,
  encodeCodonTips,
  getGeneticCode,
  type GeneticCodeInput,
} from "../model/genetic-code.js";

export interface EvaluationBackend {
  readonly kind: "wasm" | "wasm-parallel" | "webgpu";
  prepare(workload?: RuntimeWorkload): Promise<void>;
  evaluate(request: LikelihoodRequest): Promise<LikelihoodResult>;
}

export interface PartitionedFitSegment {
  readonly alignment: FastaAlignment;
  readonly tree: ParsedTree;
  readonly compiled: CompiledTree;
}

type ProgressCallback = (fraction: number, detail?: ProgressDetail) => void;

const NUCLEOTIDE_INDEX = new Map([["A", 0], ["C", 1], ["G", 2], ["T", 3], ["U", 3]]);
const IUPAC_MASK = new Map<string, number>([
  ["A", 1], ["C", 2], ["G", 4], ["T", 8], ["U", 8],
  ["B", 14], ["M", 3], ["Y", 10], ["D", 13], ["V", 7], ["H", 11],
  ["K", 12], ["R", 5], ["W", 9], ["S", 6], ["N", 15], ["-", 15],
]);
const PAIR_INDEX = new Int8Array([
  -1, 0, 1, 2,
   0,-1, 3, 4,
   1, 3,-1, 5,
   2, 4, 5,-1,
]);

function dummyGrid(categoryCount: number, classCount: number): DifFUBARGrid {
  return {
    alpha: new Float64Array(0),
    omega: new Float64Array(0),
    backgroundOmega: new Float64Array(0),
    categories: new Float64Array(categoryCount * (classCount + 1)),
    categoryCount,
    parameterCount: classCount + 1,
    hasBackground: classCount === 3,
  };
}

function encodeNucleotideTips(alignment: FastaAlignment, tree: ParsedTree): Uint8Array {
  const sequenceIndex = new Map(alignment.names.map((name, index) => [name, index]));
  const encoded = new Uint8Array(tree.tips.length * alignment.nucleotideSites);
  encoded.fill(255);
  for (const tip of tree.tips) {
    const index = sequenceIndex.get(tip.name);
    if (index === undefined) throw new DifFUBARError("MISSING_SEQUENCE", `No sequence matches tree tip '${tip.name}'.`);
    const sequence = alignment.sequences[index]!.toUpperCase();
    for (let site = 0; site < alignment.nucleotideSites; site += 1) {
      const character = sequence[site]!;
      const exact = NUCLEOTIDE_INDEX.get(character);
      if (exact !== undefined) {
        encoded[tip.tipIndex * alignment.nucleotideSites + site] = exact;
      } else {
        const mask = IUPAC_MASK.get(character);
        encoded[tip.tipIndex * alignment.nucleotideSites + site] = mask === undefined ? 255 : 128 | mask;
      }
    }
  }
  return encoded;
}

function buildNucleotideBank(logRateVectors: readonly Float64Array[], equilibrium: Float64Array, classCount: number): ModelBank {
  const stateCount = 4;
  const maxNeighbors = 3;
  const modelCount = logRateVectors.length;
  const neighborCount = new Uint32Array(stateCount).fill(3);
  const neighborIndex = new Uint32Array(stateCount * maxNeighbors);
  for (let state = 0; state < stateCount; state += 1) {
    let k = 0;
    for (let neighbor = 0; neighbor < stateCount; neighbor += 1) {
      if (neighbor !== state) neighborIndex[state * maxNeighbors + k++] = neighbor;
    }
  }
  const rDiagonal = new Float64Array(modelCount * stateCount);
  const rOffDiagonal = new Float64Array(modelCount * stateCount * maxNeighbors);
  const mu = new Float64Array(modelCount);
  const modelAlpha = new Float64Array(modelCount);
  const modelOmega = new Float64Array(modelCount);
  for (let model = 0; model < modelCount; model += 1) {
    const logs = logRateVectors[model]!;
    const rates = Float64Array.from(logs, Math.exp);
    let uniformizationRate = 0;
    for (let state = 0; state < stateCount; state += 1) {
      let exitRate = 0;
      let k = 0;
      for (let neighbor = 0; neighbor < stateCount; neighbor += 1) {
        if (neighbor === state) continue;
        const rate = rates[PAIR_INDEX[state * 4 + neighbor]!]! * equilibrium[neighbor]!;
        rOffDiagonal[model * stateCount * maxNeighbors + state * maxNeighbors + k++] = rate;
        exitRate += rate;
      }
      rDiagonal[model * stateCount + state] = -exitRate;
      uniformizationRate = Math.max(uniformizationRate, exitRate);
    }
    mu[model] = uniformizationRate;
    for (let state = 0; state < stateCount; state += 1) {
      rDiagonal[model * stateCount + state] = 1 + rDiagonal[model * stateCount + state]! / uniformizationRate;
      for (let k = 0; k < maxNeighbors; k += 1) {
        const offset = model * stateCount * maxNeighbors + state * maxNeighbors + k;
        rOffDiagonal[offset] = rOffDiagonal[offset]! / uniformizationRate;
      }
    }
  }
  const gridModels = new Uint32Array(modelCount * classCount);
  for (let model = 0; model < modelCount; model += 1) {
    for (let branchClass = 0; branchClass < classCount; branchClass += 1) gridModels[model * classCount + branchClass] = model;
  }
  return {
    stateCount,
    maxNeighbors,
    modelCount,
    neighborCount,
    neighborIndex,
    rDiagonal,
    rOffDiagonal,
    mu,
    modelAlpha,
    modelOmega,
    gridModels,
  };
}

async function evaluateNucleotideCandidates(
  candidates: readonly Float64Array[],
  alignment: FastaAlignment,
  tree: ParsedTree,
  compiled: CompiledTree,
  backend: EvaluationBackend,
  equilibrium: Float64Array,
  tipStates: Uint8Array,
  signal?: AbortSignal,
): Promise<Float64Array> {
  const models = buildNucleotideBank(candidates, equilibrium, tree.classCount);
  const result = await backend.evaluate({
    tree: compiled,
    tipStates,
    siteCount: alignment.nucleotideSites,
    grid: dummyGrid(candidates.length, tree.classCount),
    models,
    equilibrium,
    ...(signal === undefined ? {} : { signal }),
  });
  const sums = new Float64Array(candidates.length);
  for (let candidate = 0; candidate < candidates.length; candidate += 1) {
    let sum = 0;
    const offset = candidate * alignment.nucleotideSites;
    for (let site = 0; site < alignment.nucleotideSites; site += 1) sum += result.logLikelihoods[offset + site]!;
    sums[candidate] = sum;
  }
  return sums;
}

function empiricalGtr(alignment: FastaAlignment, equilibrium: Float64Array): Float64Array {
  const pairCounts = new Float64Array(6);
  const counts = new Float64Array(4);
  for (let site = 0; site < alignment.nucleotideSites; site += 1) {
    counts.fill(0);
    for (const sequence of alignment.sequences) {
      const index = NUCLEOTIDE_INDEX.get(sequence[site]!.toUpperCase());
      if (index !== undefined) counts[index] = counts[index]! + 1;
    }
    for (let i = 0; i < 4; i += 1) {
      for (let j = i + 1; j < 4; j += 1) {
        const pair = PAIR_INDEX[i * 4 + j]!;
        pairCounts[pair] = pairCounts[pair]! + counts[i]! * counts[j]!;
      }
    }
  }
  const rates = new Float64Array(6);
  let logMean = 0;
  for (let i = 0; i < 4; i += 1) {
    for (let j = i + 1; j < 4; j += 1) {
      const pair = PAIR_INDEX[i * 4 + j]!;
      rates[pair] = (pairCounts[pair]! + 0.5) / (equilibrium[i]! * equilibrium[j]! + 1e-12);
      logMean += Math.log(rates[pair]!);
    }
  }
  const geometricMean = Math.exp(logMean / 6);
  for (let pair = 0; pair < 6; pair += 1) rates[pair] = rates[pair]! / geometricMean;
  return rates;
}

async function optimizeGtr(
  alignment: FastaAlignment,
  tree: ParsedTree,
  compiled: CompiledTree,
  backend: EvaluationBackend,
  equilibrium: Float64Array,
  tipStates: Uint8Array,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<Float64Array> {
  const dimension = 6;
  let simplex = [new Float64Array(dimension)];
  for (let axis = 0; axis < dimension; axis += 1) {
    const point = new Float64Array(dimension);
    point[axis] = 0.25;
    simplex.push(point);
  }
  onProgress?.(0, {
    message: "Initializing the nucleotide optimizer",
    current: 0,
    total: 90,
    indeterminate: true,
  });
  let values = Array.from(await evaluateNucleotideCandidates(simplex, alignment, tree, compiled, backend, equilibrium, tipStates, signal));
  const clamp = (value: number): number => Math.max(-5, Math.min(5, value));
  let completedIterations = 0;

  for (let iteration = 0; iteration < 90; iteration += 1) {
    signal?.throwIfAborted();
    const order = simplex.map((_point, index) => index).sort((a, b) => values[b]! - values[a]!);
    simplex = order.map((index) => simplex[index]!);
    values = order.map((index) => values[index]!);
    let diameter = 0;
    for (let i = 1; i < simplex.length; i += 1) {
      for (let d = 0; d < dimension; d += 1) diameter = Math.max(diameter, Math.abs(simplex[i]![d]! - simplex[0]![d]!));
    }
    if (diameter < 2e-3) break;
    onProgress?.(iteration / 90, {
      message: "Nucleotide Nelder–Mead step",
      current: iteration,
      total: 90,
      metricLabel: "log L",
      metricValue: values[0]!,
      indeterminate: true,
    });

    const centroid = new Float64Array(dimension);
    for (let i = 0; i < dimension; i += 1) {
      for (let d = 0; d < dimension; d += 1) centroid[d] = centroid[d]! + simplex[i]![d]! / dimension;
    }
    const worst = simplex[dimension]!;
    const reflected = Float64Array.from(centroid, (value, d) => clamp(value + (value - worst[d]!)));
    const reflectedValue = (await evaluateNucleotideCandidates([reflected], alignment, tree, compiled, backend, equilibrium, tipStates, signal))[0]!;
    if (reflectedValue > values[0]!) {
      const expanded = Float64Array.from(centroid, (value, d) => clamp(value + 2 * (reflected[d]! - value)));
      const expandedValue = (await evaluateNucleotideCandidates([expanded], alignment, tree, compiled, backend, equilibrium, tipStates, signal))[0]!;
      simplex[dimension] = expandedValue > reflectedValue ? expanded : reflected;
      values[dimension] = Math.max(expandedValue, reflectedValue);
    } else if (reflectedValue > values[dimension - 1]!) {
      simplex[dimension] = reflected;
      values[dimension] = reflectedValue;
    } else {
      const contracted = Float64Array.from(centroid, (value, d) => clamp(value + 0.5 * (worst[d]! - value)));
      const contractedValue = (await evaluateNucleotideCandidates([contracted], alignment, tree, compiled, backend, equilibrium, tipStates, signal))[0]!;
      if (contractedValue > values[dimension]!) {
        simplex[dimension] = contracted;
        values[dimension] = contractedValue;
      } else {
        const best = simplex[0]!;
        const shrunk = simplex.slice(1).map((point) => Float64Array.from(best, (value, d) => clamp(value + 0.5 * (point[d]! - value))));
        const shrunkValues = await evaluateNucleotideCandidates(shrunk, alignment, tree, compiled, backend, equilibrium, tipStates, signal);
        for (let i = 1; i < simplex.length; i += 1) {
          simplex[i] = shrunk[i - 1]!;
          values[i] = shrunkValues[i - 1]!;
        }
      }
    }
    completedIterations = iteration + 1;
    onProgress?.(completedIterations / 90, {
      message: "Nucleotide Nelder–Mead step",
      current: completedIterations,
      total: 90,
      metricLabel: "log L",
      metricValue: Math.max(...values),
    });
  }
  const best = values.indexOf(Math.max(...values));
  onProgress?.(1, {
    message: `Nucleotide optimizer converged after ${completedIterations.toLocaleString()} steps`,
    current: completedIterations,
    total: completedIterations,
    metricLabel: "log L",
    metricValue: values[best]!,
  });
  return Float64Array.from(simplex[best]!, Math.exp);
}

function codonCandidateGrid(pairs: readonly (readonly [number, number])[], tree: ParsedTree): DifFUBARGrid {
  const parameterCount = tree.classCount + 1;
  const categories = new Float64Array(pairs.length * parameterCount);
  for (let category = 0; category < pairs.length; category += 1) {
    const [alpha, beta] = pairs[category]!;
    const omega = alpha > 0 ? beta / alpha : 1;
    categories[category * parameterCount] = alpha;
    for (let branchClass = 0; branchClass < tree.classCount; branchClass += 1) {
      categories[category * parameterCount + 1 + branchClass] = omega;
    }
  }
  return {
    alpha: Float64Array.from(pairs, (pair) => pair[0]),
    omega: Float64Array.from(pairs, (pair) => pair[1] / pair[0]),
    backgroundOmega: new Float64Array(0),
    categories,
    categoryCount: pairs.length,
    parameterCount,
    hasBackground: tree.hasBackground,
  };
}

async function evaluateCodonCandidates(
  pairs: readonly (readonly [number, number])[],
  alignment: FastaAlignment,
  tree: ParsedTree,
  compiled: CompiledTree,
  backend: EvaluationBackend,
  gtrRates: Float64Array,
  f3x4: Float64Array,
  equilibrium: Float64Array,
  tipStates: Uint8Array,
  geneticCode: GeneticCodeInput,
  signal?: AbortSignal,
): Promise<Float64Array> {
  const grid = codonCandidateGrid(pairs, tree);
  const models = buildModelBank(grid, tree, gtrRates, f3x4, geneticCode);
  const likelihood = await backend.evaluate({
    tree: compiled,
    tipStates,
    siteCount: alignment.codonSites,
    grid,
    models,
    equilibrium,
    ...(signal === undefined ? {} : { signal }),
  });
  const sums = new Float64Array(pairs.length);
  for (let category = 0; category < pairs.length; category += 1) {
    let sum = 0;
    const offset = category * alignment.codonSites;
    for (let site = 0; site < alignment.codonSites; site += 1) sum += likelihood.logLikelihoods[offset + site]!;
    sums[category] = sum;
  }
  return sums;
}

async function goldenMaximum(
  objective: (value: number) => Promise<number>,
  lower: number,
  upper: number,
  tolerance: number,
  message: string,
  onProgress?: ProgressCallback,
): Promise<{ x: number; value: number }> {
  const ratio = (Math.sqrt(5) - 1) / 2;
  const expectedEvaluations = 2 + Math.max(0, Math.ceil(Math.log(tolerance / (upper - lower)) / Math.log(ratio)));
  let evaluations = 0;
  let bestValue = -Infinity;
  const evaluate = async (value: number): Promise<number> => {
    onProgress?.(Math.min(0.99, evaluations / expectedEvaluations), {
      message,
      current: evaluations,
      total: expectedEvaluations,
      ...(Number.isFinite(bestValue) ? { metricLabel: "log L", metricValue: bestValue } : {}),
      indeterminate: true,
    });
    const result = await objective(value);
    evaluations += 1;
    bestValue = Math.max(bestValue, result);
    onProgress?.(Math.min(1, evaluations / expectedEvaluations), {
      message,
      current: evaluations,
      total: expectedEvaluations,
      metricLabel: "log L",
      metricValue: bestValue,
    });
    return result;
  };
  let a = lower;
  let b = upper;
  let c = b - ratio * (b - a);
  let d = a + ratio * (b - a);
  let fc = await evaluate(c);
  let fd = await evaluate(d);
  while (Math.abs(b - a) > tolerance) {
    if (fc > fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - ratio * (b - a);
      fc = await evaluate(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + ratio * (b - a);
      fd = await evaluate(d);
    }
  }
  onProgress?.(1, {
    message,
    current: evaluations,
    total: evaluations,
    metricLabel: "log L",
    metricValue: Math.max(fc, fd),
  });
  return fc > fd ? { x: c, value: fc } : { x: d, value: fd };
}

async function optimizeAlphaBeta(
  mode: "empirical-fast" | "reference-compatible",
  alignment: FastaAlignment,
  tree: ParsedTree,
  compiled: CompiledTree,
  backend: EvaluationBackend,
  gtrRates: Float64Array,
  f3x4: Float64Array,
  equilibrium: Float64Array,
  tipStates: Uint8Array,
  geneticCode: GeneticCodeInput,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<{ alpha: number; beta: number; logLikelihood: number }> {
  if (mode === "empirical-fast") {
    let alpha = 1;
    let beta = 1;
    let score = -Infinity;
    // A multiresolution 3x3 stencil covers a broad multiplicative range on
    // the first pass, then contracts around the best point. This replaces the
    // old 9x9 coarse grid (117 total candidates) with 54 smooth-objective
    // evaluations while retaining sub-percent final log resolution.
    const logSteps = [0.8, 0.4, 0.2, 0.1, 0.05, 0.025];
    for (let pass = 0; pass < logSteps.length; pass += 1) {
      const logStep = logSteps[pass]!;
      onProgress?.(pass / logSteps.length, {
        message: `Codon fit refinement ${pass + 1} of ${logSteps.length}`,
        current: pass,
        total: logSteps.length,
        ...(Number.isFinite(score) ? { metricLabel: "log L", metricValue: score } : {}),
        indeterminate: true,
      });
      const multipliers = [Math.exp(-logStep), 1, Math.exp(logStep)];
      const pairs: Array<[number, number]> = [];
      for (const am of multipliers) for (const bm of multipliers) pairs.push([Math.max(1e-4, Math.min(5, alpha * am)), Math.max(1e-4, Math.min(5, beta * bm))]);
      const scores = await evaluateCodonCandidates(pairs, alignment, tree, compiled, backend, gtrRates, f3x4, equilibrium, tipStates, geneticCode, signal);
      const best = scores.indexOf(Math.max(...scores));
      alpha = pairs[best]![0];
      beta = pairs[best]![1];
      score = scores[best]!;
      onProgress?.((pass + 1) / logSteps.length, {
        message: `Codon fit refinement ${pass + 1} of ${logSteps.length} · α=${alpha.toPrecision(4)}, β=${beta.toPrecision(4)}`,
        current: pass + 1,
        total: logSteps.length,
        metricLabel: "log L",
        metricValue: score,
      });
    }
    return { alpha, beta, logLikelihood: score };
  }

  let alpha = 1;
  let beta = 1;
  const alphaFit = await goldenMaximum(async (candidate) => (
    await evaluateCodonCandidates([[candidate, beta]], alignment, tree, compiled, backend, gtrRates, f3x4, equilibrium, tipStates, geneticCode, signal)
  )[0]!, 1e-6, 5, 1e-4, "Optimizing global α", (fraction, detail) => onProgress?.(fraction * 0.34, detail));
  alpha = alphaFit.x;
  const betaFit = await goldenMaximum(async (candidate) => (
    await evaluateCodonCandidates([[alpha, candidate]], alignment, tree, compiled, backend, gtrRates, f3x4, equilibrium, tipStates, geneticCode, signal)
  )[0]!, 1e-6, 5, 1e-4, "Optimizing global β", (fraction, detail) => onProgress?.(0.34 + fraction * 0.33, detail));
  beta = betaFit.x;
  const polished = await goldenMaximum(async (candidate) => (
    await evaluateCodonCandidates([[candidate, beta]], alignment, tree, compiled, backend, gtrRates, f3x4, equilibrium, tipStates, geneticCode, signal)
  )[0]!, Math.max(1e-6, alpha - 0.05), Math.min(5, alpha + 0.05), 1e-7, "Polishing global α", (fraction, detail) => onProgress?.(0.67 + fraction * 0.33, detail));
  return { alpha: polished.x, beta, logLikelihood: polished.value };
}

export async function fitGlobalModel(
  alignment: FastaAlignment,
  tree: ParsedTree,
  compiled: CompiledTree,
  backend: EvaluationBackend,
  mode: "empirical-fast" | "reference-compatible" = "empirical-fast",
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
  geneticCodeInput: GeneticCodeInput = 1,
): Promise<FittedModel> {
  signal?.throwIfAborted();
  const geneticCode = getGeneticCode(geneticCodeInput);
  onProgress?.(0, { message: "Estimating F3×4 equilibrium frequencies", indeterminate: true });
  const f3x4 = countF3x4(alignment);
  const codonEquilibrium = codonEquilibriumFromF3x4(f3x4, geneticCode);
  const nucleotideEquilibrium = countNucleotideFrequencies(alignment);
  const nucleotideTips = encodeNucleotideTips(alignment, tree);
  const gtrRates = mode === "reference-compatible"
    ? await optimizeGtr(
      alignment,
      tree,
      compiled,
      backend,
      nucleotideEquilibrium,
      nucleotideTips,
      (fraction, detail) => onProgress?.(0.02 + fraction * 0.5, detail),
      signal,
    )
    : empiricalGtr(alignment, nucleotideEquilibrium);
  if (mode === "empirical-fast") {
    onProgress?.(0.12, { message: "Empirical GTR initialization complete" });
  }
  const codonTips = encodeCodonTips(alignment, tree, geneticCode);
  const fit = await optimizeAlphaBeta(
    mode,
    alignment,
    tree,
    compiled,
    backend,
    gtrRates,
    f3x4,
    codonEquilibrium,
    codonTips,
    geneticCode,
    (fraction, detail) => onProgress?.(
      mode === "reference-compatible" ? 0.52 + fraction * 0.48 : 0.12 + fraction * 0.88,
      detail,
    ),
    signal,
  );
  onProgress?.(1, {
    message: `Global codon fit complete · α=${fit.alpha.toPrecision(5)}, β=${fit.beta.toPrecision(5)}`,
    metricLabel: "log L",
    metricValue: fit.logLikelihood,
  });
  return {
    geneticCodeId: geneticCode.id,
    gtrRates,
    f3x4,
    codonEquilibrium,
    globalAlpha: fit.alpha,
    globalBeta: fit.beta,
    logLikelihood: fit.logLikelihood,
    fitKind: mode,
  };
}

async function evaluatePartitionedNucleotideCandidates(
  candidates: readonly Float64Array[],
  segments: readonly PartitionedFitSegment[],
  backend: EvaluationBackend,
  equilibrium: Float64Array,
  signal?: AbortSignal,
  onSegment?: (completed: number, total: number) => void,
): Promise<Float64Array> {
  const sums = new Float64Array(candidates.length);
  const models = buildNucleotideBank(candidates, equilibrium, segments[0]!.tree.classCount);
  const grid = dummyGrid(candidates.length, segments[0]!.tree.classCount);
  for (let region = 0; region < segments.length; region += 1) {
    const segment = segments[region]!;
    signal?.throwIfAborted();
    const tips = encodeNucleotideTips(segment.alignment, segment.tree);
    const likelihood = await backend.evaluate({ tree: segment.compiled, tipStates: tips, siteCount: segment.alignment.nucleotideSites, grid, models, equilibrium, ...(signal === undefined ? {} : { signal }) });
    for (let candidate = 0; candidate < candidates.length; candidate += 1) {
      const offset = candidate * segment.alignment.nucleotideSites;
      let local = 0;
      for (let site = 0; site < segment.alignment.nucleotideSites; site += 1) local += likelihood.logLikelihoods[offset + site]!;
      sums[candidate] = sums[candidate]! + local;
    }
    onSegment?.(region + 1, segments.length);
  }
  return sums;
}

async function optimizePartitionedGtr(
  segments: readonly PartitionedFitSegment[],
  backend: EvaluationBackend,
  equilibrium: Float64Array,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<Float64Array> {
  const dimension = 6;
  let simplex = [new Float64Array(dimension)];
  for (let axis = 0; axis < dimension; axis += 1) {
    const point = new Float64Array(dimension);
    point[axis] = 0.25;
    simplex.push(point);
  }
  let values = Array.from(await evaluatePartitionedNucleotideCandidates(simplex, segments, backend, equilibrium, signal));
  const clamp = (value: number): number => Math.max(-5, Math.min(5, value));
  let completedIterations = 0;
  for (let iteration = 0; iteration < 90; iteration += 1) {
    signal?.throwIfAborted();
    const order = simplex.map((_point, index) => index).sort((a, b) => values[b]! - values[a]!);
    simplex = order.map((index) => simplex[index]!);
    values = order.map((index) => values[index]!);
    let diameter = 0;
    for (let point = 1; point < simplex.length; point += 1) for (let axis = 0; axis < dimension; axis += 1) diameter = Math.max(diameter, Math.abs(simplex[point]![axis]! - simplex[0]![axis]!));
    if (diameter < 2e-3) break;
    onProgress?.(iteration / 90, { message: `Joint nucleotide optimizer step across ${segments.length} fixed-scale trees`, current: iteration, total: 90, metricLabel: "log L", metricValue: values[0]!, indeterminate: true });
    const centroid = new Float64Array(dimension);
    for (let point = 0; point < dimension; point += 1) for (let axis = 0; axis < dimension; axis += 1) centroid[axis] = centroid[axis]! + simplex[point]![axis]! / dimension;
    const worst = simplex[dimension]!;
    const reflected = Float64Array.from(centroid, (value, axis) => clamp(value + (value - worst[axis]!)));
    const reflectedValue = (await evaluatePartitionedNucleotideCandidates([reflected], segments, backend, equilibrium, signal))[0]!;
    if (reflectedValue > values[0]!) {
      const expanded = Float64Array.from(centroid, (value, axis) => clamp(value + 2 * (reflected[axis]! - value)));
      const expandedValue = (await evaluatePartitionedNucleotideCandidates([expanded], segments, backend, equilibrium, signal))[0]!;
      simplex[dimension] = expandedValue > reflectedValue ? expanded : reflected;
      values[dimension] = Math.max(expandedValue, reflectedValue);
    } else if (reflectedValue > values[dimension - 1]!) {
      simplex[dimension] = reflected;
      values[dimension] = reflectedValue;
    } else {
      const contracted = Float64Array.from(centroid, (value, axis) => clamp(value + 0.5 * (worst[axis]! - value)));
      const contractedValue = (await evaluatePartitionedNucleotideCandidates([contracted], segments, backend, equilibrium, signal))[0]!;
      if (contractedValue > values[dimension]!) {
        simplex[dimension] = contracted;
        values[dimension] = contractedValue;
      } else {
        const best = simplex[0]!;
        const shrunk = simplex.slice(1).map((point) => Float64Array.from(best, (value, axis) => clamp(value + 0.5 * (point[axis]! - value))));
        const shrunkValues = await evaluatePartitionedNucleotideCandidates(shrunk, segments, backend, equilibrium, signal);
        for (let point = 1; point < simplex.length; point += 1) {
          simplex[point] = shrunk[point - 1]!;
          values[point] = shrunkValues[point - 1]!;
        }
      }
    }
    completedIterations = iteration + 1;
  }
  const best = values.indexOf(Math.max(...values));
  onProgress?.(1, { message: `Joint nucleotide fit converged across ${segments.length} trees`, current: completedIterations, total: completedIterations, metricLabel: "log L", metricValue: values[best]! });
  return Float64Array.from(simplex[best]!, Math.exp);
}

async function evaluatePartitionedCodonCandidates(
  pairs: readonly (readonly [number, number])[],
  segments: readonly PartitionedFitSegment[],
  backend: EvaluationBackend,
  gtrRates: Float64Array,
  f3x4: Float64Array,
  equilibrium: Float64Array,
  geneticCode: GeneticCodeInput,
  signal?: AbortSignal,
  onSegment?: (completed: number, total: number) => void,
): Promise<Float64Array> {
  const sums = new Float64Array(pairs.length);
  const grid = codonCandidateGrid(pairs, segments[0]!.tree);
  const models = buildModelBank(grid, segments[0]!.tree, gtrRates, f3x4, geneticCode);
  for (let region = 0; region < segments.length; region += 1) {
    const segment = segments[region]!;
    signal?.throwIfAborted();
    const tips = encodeCodonTips(segment.alignment, segment.tree, geneticCode);
    const likelihood = await backend.evaluate({ tree: segment.compiled, tipStates: tips, siteCount: segment.alignment.codonSites, grid, models, equilibrium, ...(signal === undefined ? {} : { signal }) });
    for (let candidate = 0; candidate < pairs.length; candidate += 1) {
      const offset = candidate * segment.alignment.codonSites;
      let local = 0;
      for (let site = 0; site < segment.alignment.codonSites; site += 1) local += likelihood.logLikelihoods[offset + site]!;
      sums[candidate] = sums[candidate]! + local;
    }
    onSegment?.(region + 1, segments.length);
  }
  return sums;
}

async function optimizePartitionedAlphaBeta(
  mode: "empirical-fast" | "reference-compatible",
  segments: readonly PartitionedFitSegment[],
  backend: EvaluationBackend,
  gtrRates: Float64Array,
  f3x4: Float64Array,
  equilibrium: Float64Array,
  geneticCode: GeneticCodeInput,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<{ alpha: number; beta: number; logLikelihood: number }> {
  const evaluate = (pairs: readonly (readonly [number, number])[], onSegment?: (completed: number, total: number) => void) => evaluatePartitionedCodonCandidates(pairs, segments, backend, gtrRates, f3x4, equilibrium, geneticCode, signal, onSegment);
  if (mode === "empirical-fast") {
    let alpha = 1;
    let beta = 1;
    let score = -Infinity;
    const logSteps = [0.8, 0.4, 0.2, 0.1, 0.05, 0.025];
    for (let pass = 0; pass < logSteps.length; pass += 1) {
      const multipliers = [Math.exp(-logSteps[pass]!), 1, Math.exp(logSteps[pass]!)];
      const pairs: Array<[number, number]> = [];
      for (const alphaMultiplier of multipliers) for (const betaMultiplier of multipliers) pairs.push([Math.max(1e-4, Math.min(5, alpha * alphaMultiplier)), Math.max(1e-4, Math.min(5, beta * betaMultiplier))]);
      const scores = await evaluate(pairs, (completed, total) => onProgress?.((pass + completed / total) / logSteps.length, {
        message: `Joint codon refinement ${pass + 1}/${logSteps.length} · regional tree ${completed}/${total}`,
        current: completed,
        total,
        indeterminate: true,
      }));
      const best = scores.indexOf(Math.max(...scores));
      alpha = pairs[best]![0];
      beta = pairs[best]![1];
      score = scores[best]!;
      onProgress?.((pass + 1) / logSteps.length, { message: `Joint codon refinement ${pass + 1} of ${logSteps.length} across ${segments.length} trees · α=${alpha.toPrecision(4)}, β=${beta.toPrecision(4)}`, current: pass + 1, total: logSteps.length, metricLabel: "log L", metricValue: score });
    }
    return { alpha, beta, logLikelihood: score };
  }
  let alpha = 1;
  let beta = 1;
  const alphaFit = await goldenMaximum(async (candidate) => (await evaluate([[candidate, beta]]))[0]!, 1e-6, 5, 1e-4, `Optimizing global α across ${segments.length} trees`, (fraction, detail) => onProgress?.(fraction * 0.34, detail));
  alpha = alphaFit.x;
  const betaFit = await goldenMaximum(async (candidate) => (await evaluate([[alpha, candidate]]))[0]!, 1e-6, 5, 1e-4, `Optimizing global β across ${segments.length} trees`, (fraction, detail) => onProgress?.(0.34 + fraction * 0.33, detail));
  beta = betaFit.x;
  const polished = await goldenMaximum(async (candidate) => (await evaluate([[candidate, beta]]))[0]!, Math.max(1e-6, alpha - 0.05), Math.min(5, alpha + 0.05), 1e-7, "Polishing joint global α", (fraction, detail) => onProgress?.(0.67 + fraction * 0.33, detail));
  return { alpha: polished.x, beta, logLikelihood: polished.value };
}

/**
 * Fit one codon model against a forest of fixed relative-scale regional trees.
 * No segment-specific length multiplier is represented by this API.
 */
export async function fitPartitionedGlobalModel(
  alignment: FastaAlignment,
  segments: readonly PartitionedFitSegment[],
  backend: EvaluationBackend,
  mode: "empirical-fast" | "reference-compatible" = "empirical-fast",
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
  geneticCodeInput: GeneticCodeInput = 1,
): Promise<FittedModel> {
  if (segments.length === 0) throw new RangeError("A partitioned global fit requires at least one regional tree.");
  if (segments.some((segment) => segment.tree.classCount !== 1)) throw new RangeError("Partitioned codon fits require untagged one-class regional trees.");
  signal?.throwIfAborted();
  const geneticCode = getGeneticCode(geneticCodeInput);
  onProgress?.(0, { message: `Estimating one F3×4/GTR/codon model across ${segments.length} fixed-scale trees`, indeterminate: true });
  const f3x4 = countF3x4(alignment);
  const codonEquilibrium = codonEquilibriumFromF3x4(f3x4, geneticCode);
  const nucleotideEquilibrium = countNucleotideFrequencies(alignment);
  const gtrRates = mode === "reference-compatible"
    ? await optimizePartitionedGtr(segments, backend, nucleotideEquilibrium, (fraction, detail) => onProgress?.(0.02 + fraction * 0.5, detail), signal)
    : empiricalGtr(alignment, nucleotideEquilibrium);
  if (mode === "empirical-fast") onProgress?.(0.12, { message: `Pooled empirical GTR initialization complete across ${segments.length} regions` });
  const fit = await optimizePartitionedAlphaBeta(mode, segments, backend, gtrRates, f3x4, codonEquilibrium, geneticCode, (fraction, detail) => onProgress?.(mode === "reference-compatible" ? 0.52 + fraction * 0.48 : 0.12 + fraction * 0.88, detail), signal);
  onProgress?.(1, { message: `Joint global codon fit complete · ${segments.length} trees · α=${fit.alpha.toPrecision(5)}, β=${fit.beta.toPrecision(5)}`, metricLabel: "log L", metricValue: fit.logLikelihood });
  return {
    geneticCodeId: geneticCode.id,
    gtrRates,
    f3x4,
    codonEquilibrium,
    globalAlpha: fit.alpha,
    globalBeta: fit.beta,
    logLikelihood: fit.logLikelihood,
    fitKind: mode,
  };
}

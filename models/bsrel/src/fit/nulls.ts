import type { ProgressDetail } from "@phylo-workbench/model-diffubar";
import {
  NULL_PARAMETERS_PER_BRANCH,
  decodeNullBranch,
  projectedNullRaw,
  type DecodedBranchModel,
} from "../model/parameters.js";
import { BsrelLikelihood, type LocalBranchCandidate } from "./likelihood.js";

export interface NullFitResult {
  readonly raw: Float64Array;
  readonly logLikelihoods: Float64Array;
  readonly completedIterations: number;
}

function decodeNulls(
  raw: Float64Array,
  edges: readonly number[],
  baseLengths: Float64Array,
): DecodedBranchModel[] {
  return edges.map((edge, index) => decodeNullBranch(
    raw,
    index * NULL_PARAMETERS_PER_BRANCH,
    baseLengths[edge]!,
  ));
}

async function evaluateNullCandidates(
  likelihood: BsrelLikelihood,
  alternative: readonly DecodedBranchModel[],
  candidates: readonly LocalBranchCandidate[],
): Promise<Float64Array> {
  return (await likelihood.evaluate(alternative, candidates)).objectives.slice(1);
}

/**
 * Re-optimize every branch null concurrently. Each objective is bounded by
 * the two incoming messages around that edge; nothing outside that local
 * Markov blanket is rebuilt or allowed to drift from the global alternative.
 */
export async function optimizeBranchNulls(
  likelihood: BsrelLikelihood,
  alternativeRaw: Float64Array,
  alternative: readonly DecodedBranchModel[],
  testedEdges: readonly number[],
  baseLengths: Float64Array,
  maximumIterations: number,
  onProgress?: (fraction: number, detail?: ProgressDetail) => void,
  signal?: AbortSignal,
): Promise<NullFitResult> {
  const raw = projectedNullRaw(alternativeRaw, testedEdges);
  const initialModels = decodeNulls(raw, testedEdges, baseLengths);
  onProgress?.(0, {
    message: `Caching two-sided boundary messages and projecting ${testedEdges.length.toLocaleString()} branch nulls`,
    current: 0,
    total: maximumIterations,
    indeterminate: true,
  });
  let logLikelihoods = await evaluateNullCandidates(
    likelihood,
    alternative,
    testedEdges.map((edge, index) => ({ edge, model: initialModels[index]! })),
  );
  const steps = new Float64Array(testedEdges.length * NULL_PARAMETERS_PER_BRANCH);
  const initialSteps = [0.7, 0.7, 0.55, 0.55, 0.22] as const;
  for (let branch = 0; branch < testedEdges.length; branch += 1) steps.set(initialSteps, branch * NULL_PARAMETERS_PER_BRANCH);
  let completedIterations = 0;

  for (let iteration = 0; iteration < maximumIterations; iteration += 1) {
    signal?.throwIfAborted();
    const candidates: LocalBranchCandidate[] = [];
    for (let branch = 0; branch < testedEdges.length; branch += 1) {
      const branchOffset = branch * NULL_PARAMETERS_PER_BRANCH;
      for (let parameter = 0; parameter < NULL_PARAMETERS_PER_BRANCH; parameter += 1) {
        for (const direction of [-1, 1] as const) {
          const local = raw.slice(branchOffset, branchOffset + NULL_PARAMETERS_PER_BRANCH);
          local[parameter] = local[parameter]! + direction * steps[branchOffset + parameter]!;
          candidates.push({
            edge: testedEdges[branch]!,
            model: decodeNullBranch(local, 0, baseLengths[testedEdges[branch]!]!),
          });
        }
      }
    }
    const objectives = await evaluateNullCandidates(likelihood, alternative, candidates);
    let active = 0;
    for (let branch = 0; branch < testedEdges.length; branch += 1) {
      const candidateStart = branch * NULL_PARAMETERS_PER_BRANCH * 2;
      let best = logLikelihoods[branch]!;
      let bestParameter = -1;
      let bestDirection = 0;
      for (let parameter = 0; parameter < NULL_PARAMETERS_PER_BRANCH; parameter += 1) {
        for (let directionIndex = 0; directionIndex < 2; directionIndex += 1) {
          const value = objectives[candidateStart + parameter * 2 + directionIndex]!;
          if (value > best + 1e-8) {
            best = value;
            bestParameter = parameter;
            bestDirection = directionIndex === 0 ? -1 : 1;
          }
        }
      }
      const branchOffset = branch * NULL_PARAMETERS_PER_BRANCH;
      if (bestParameter >= 0) {
        raw[branchOffset + bestParameter] = raw[branchOffset + bestParameter]!
          + bestDirection * steps[branchOffset + bestParameter]!;
        logLikelihoods[branch] = best;
        active += 1;
      } else {
        for (let parameter = 0; parameter < NULL_PARAMETERS_PER_BRANCH; parameter += 1) {
          steps[branchOffset + parameter] = steps[branchOffset + parameter]! * 0.55;
          if (steps[branchOffset + parameter]! > 0.01) active += 1;
        }
      }
    }
    completedIterations = iteration + 1;
    const bestNull = logLikelihoods.length === 0 ? Number.NaN : Math.max(...logLikelihoods);
    onProgress?.(completedIterations / maximumIterations, {
      message: `Local blanket null round ${completedIterations} · ${testedEdges.length.toLocaleString()} branches in one batch`,
      current: completedIterations,
      total: maximumIterations,
      metricLabel: "best null log L",
      metricValue: bestNull,
    });
    if (active === 0) break;
    // Yield so worker progress and cancellation are visible between fused passes.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  onProgress?.(1, {
    message: `${testedEdges.length.toLocaleString()} branch nulls re-optimized from fixed two-sided boundary messages`,
    current: testedEdges.length,
    total: testedEdges.length,
  });
  return { raw, logLikelihoods, completedIterations };
}

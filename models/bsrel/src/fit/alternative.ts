import type { ProgressDetail } from "@phylo-workbench/model-diffubar";
import {
  ALT_PARAMETERS_PER_BRANCH,
  decodeAlternativeBranch,
  type DecodedBranchModel,
} from "../model/parameters.js";
import { BsrelLikelihood, type LocalBranchCandidate } from "./likelihood.js";

interface HistoryEntry {
  readonly s: Float64Array;
  readonly y: Float64Array;
  readonly rho: number;
}

export interface AlternativeFitResult {
  readonly raw: Float64Array;
  readonly models: readonly DecodedBranchModel[];
  readonly logLikelihood: number;
  readonly completedIterations: number;
  readonly converged: boolean;
}

function dot(left: ArrayLike<number>, right: ArrayLike<number>): number {
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) sum += left[index]! * right[index]!;
  return sum;
}

function decodeAll(raw: Float64Array, baseLengths: Float64Array, maximumOmega: number): DecodedBranchModel[] {
  return Array.from({ length: baseLengths.length }, (_unused, edge) => decodeAlternativeBranch(
    raw,
    edge * ALT_PARAMETERS_PER_BRANCH,
    baseLengths[edge]!,
    maximumOmega,
  ));
}

function lbfgsDirection(gradient: Float64Array, history: readonly HistoryEntry[]): Float64Array {
  const q = gradient.slice();
  const alpha = new Float64Array(history.length);
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index]!;
    alpha[index] = item.rho * dot(item.s, q);
    for (let parameter = 0; parameter < q.length; parameter += 1) q[parameter] = q[parameter]! - alpha[index]! * item.y[parameter]!;
  }
  let scale = 1;
  if (history.length > 0) {
    const last = history[history.length - 1]!;
    scale = dot(last.s, last.y) / Math.max(1e-20, dot(last.y, last.y));
  }
  const result = Float64Array.from(q, (value) => scale * value);
  for (let index = 0; index < history.length; index += 1) {
    const item = history[index]!;
    const beta = item.rho * dot(item.y, result);
    for (let parameter = 0; parameter < result.length; parameter += 1) {
      result[parameter] = result[parameter]! + item.s[parameter]! * (alpha[index]! - beta);
    }
  }
  for (let parameter = 0; parameter < result.length; parameter += 1) result[parameter] = -result[parameter]!;
  return result;
}

async function objectiveAndGradient(
  likelihood: BsrelLikelihood,
  raw: Float64Array,
  baseLengths: Float64Array,
  maximumOmega: number,
  siteCount: number,
): Promise<{ readonly loss: number; readonly logLikelihood: number; readonly gradient: Float64Array; readonly models: readonly DecodedBranchModel[] }> {
  const models = decodeAll(raw, baseLengths, maximumOmega);
  const step = 2e-4;
  const candidates: LocalBranchCandidate[] = [];
  for (let parameter = 0; parameter < raw.length; parameter += 1) {
    const edge = Math.floor(parameter / ALT_PARAMETERS_PER_BRANCH);
    const local = raw.slice(edge * ALT_PARAMETERS_PER_BRANCH, (edge + 1) * ALT_PARAMETERS_PER_BRANCH);
    local[parameter % ALT_PARAMETERS_PER_BRANCH] = local[parameter % ALT_PARAMETERS_PER_BRANCH]! + step;
    candidates.push({
      edge,
      model: decodeAlternativeBranch(local, 0, baseLengths[edge]!, maximumOmega),
    });
  }
  const evaluated = await likelihood.evaluate(models, candidates);
  const logLikelihood = evaluated.objectives[0]!;
  const gradient = new Float64Array(raw.length);
  for (let parameter = 0; parameter < raw.length; parameter += 1) {
    gradient[parameter] = -(evaluated.objectives[parameter + 1]! - logLikelihood) / step / siteCount;
  }
  return { loss: -logLikelihood / siteCount, logLikelihood, gradient, models };
}

export async function optimizeAlternative(
  likelihood: BsrelLikelihood,
  initialRaw: Float64Array,
  baseLengths: Float64Array,
  maximumOmega: number,
  siteCount: number,
  maximumIterations: number,
  tolerance: number,
  onProgress?: (fraction: number, detail?: ProgressDetail) => void,
  signal?: AbortSignal,
): Promise<AlternativeFitResult> {
  let raw = initialRaw.slice();
  let bestLogLikelihood = -Infinity;
  let completedIterations = 0;
  let converged = false;
  const history: HistoryEntry[] = [];
  let previousRaw: Float64Array | undefined;
  let previousGradient: Float64Array | undefined;
  let finalModels: readonly DecodedBranchModel[] = decodeAll(raw, baseLengths, maximumOmega);
  onProgress?.(0, {
    message: `Initializing the joint alternative over ${baseLengths.length.toLocaleString()} fixed three-rate branch mixtures`,
    current: 0,
    total: maximumIterations,
    indeterminate: true,
  });

  for (let iteration = 0; iteration < maximumIterations; iteration += 1) {
    signal?.throwIfAborted();
    const current = await objectiveAndGradient(likelihood, raw, baseLengths, maximumOmega, siteCount);
    finalModels = current.models;
    bestLogLikelihood = current.logLikelihood;
    if (previousRaw !== undefined && previousGradient !== undefined) {
      const s = Float64Array.from(raw, (value, index) => value - previousRaw![index]!);
      const y = Float64Array.from(current.gradient, (value, index) => value - previousGradient![index]!);
      const curvature = dot(s, y);
      if (curvature > 1e-10) {
        history.push({ s, y, rho: 1 / curvature });
        if (history.length > 7) history.shift();
      }
    }
    const gradientRms = Math.sqrt(dot(current.gradient, current.gradient) / Math.max(1, current.gradient.length));
    onProgress?.(Math.min(0.98, (iteration + 1) / maximumIterations), {
      message: `Joint L-BFGS step ${iteration + 1} · one all-message gradient batch for ${baseLengths.length.toLocaleString()} branches`,
      current: iteration + 1,
      total: maximumIterations,
      metricLabel: "log L",
      metricValue: current.logLikelihood,
    });
    if (gradientRms < tolerance) {
      converged = true;
      break;
    }

    let direction = lbfgsDirection(current.gradient, history);
    if (!(dot(current.gradient, direction) < 0)) direction = Float64Array.from(current.gradient, (value) => -value);
    let maximumMove = 0;
    for (const value of direction) maximumMove = Math.max(maximumMove, Math.abs(value));
    if (maximumMove > 1.25) direction = Float64Array.from(direction, (value) => value * 1.25 / maximumMove);
    const directionalDerivative = dot(current.gradient, direction);
    let step = 1;
    let acceptedRaw: typeof raw | undefined;
    let acceptedLogLikelihood = current.logLikelihood;
    for (let lineSearch = 0; lineSearch < 7; lineSearch += 1) {
      const candidateRaw = Float64Array.from(raw, (value, index) => value + step * direction[index]!);
      const candidateModels = decodeAll(candidateRaw, baseLengths, maximumOmega);
      const candidateEvaluation = await likelihood.evaluate(candidateModels);
      const candidateLoss = -candidateEvaluation.objectives[0]! / siteCount;
      if (candidateLoss <= current.loss + 1e-4 * step * directionalDerivative) {
        acceptedRaw = candidateRaw;
        acceptedLogLikelihood = candidateEvaluation.objectives[0]!;
        break;
      }
      step *= 0.5;
    }
    if (acceptedRaw === undefined) {
      converged = true;
      break;
    }
    const improvementPerSite = (acceptedLogLikelihood - current.logLikelihood) / siteCount;
    previousRaw = raw;
    previousGradient = current.gradient;
    raw = acceptedRaw;
    bestLogLikelihood = acceptedLogLikelihood;
    completedIterations = iteration + 1;
    if (improvementPerSite >= 0 && improvementPerSite < tolerance) {
      converged = true;
      break;
    }
  }
  finalModels = decodeAll(raw, baseLengths, maximumOmega);
  if (!Number.isFinite(bestLogLikelihood)) bestLogLikelihood = (await likelihood.evaluate(finalModels)).objectives[0]!;
  onProgress?.(1, {
    message: `${converged ? "Joint alternative converged" : "Joint alternative reached its iteration limit"} after ${completedIterations.toLocaleString()} steps`,
    current: completedIterations,
    total: completedIterations,
    metricLabel: "log L",
    metricValue: bestLogLikelihood,
  });
  return { raw, models: finalModels, logLikelihood: bestLogLikelihood, completedIterations, converged };
}

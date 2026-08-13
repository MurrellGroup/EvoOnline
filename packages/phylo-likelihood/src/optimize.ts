import type { DifferentiableLinkedLikelihood, LinkedLikelihoodEvaluation } from "./likelihood.js";

interface HistoryEntry {
  readonly s: Float64Array;
  readonly y: Float64Array;
  readonly rho: number;
}

export interface BranchOptimizationProgress {
  readonly iteration: number;
  readonly maximumIterations: number;
  readonly logLikelihood: number;
  readonly gradientRms: number;
}

export interface BranchOptimizationOptions {
  readonly maximumIterations?: number;
  readonly tolerance?: number;
  readonly minimumLength?: number;
  readonly maximumLength?: number;
  readonly historySize?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: BranchOptimizationProgress) => void;
}

export interface BranchOptimizationResult {
  readonly lengths: Float64Array;
  readonly logLikelihood: number;
  readonly initialLogLikelihood: number;
  readonly iterations: number;
  readonly converged: boolean;
  readonly gradientRms: number;
}

const dot = (left: ArrayLike<number>, right: ArrayLike<number>): number => {
  let total = 0;
  for (let index = 0; index < left.length; index += 1) total += left[index]! * right[index]!;
  return total;
};

function direction(gradient: Float64Array, history: readonly HistoryEntry[]): Float64Array {
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
    scale = Math.max(1e-3, Math.min(1e3, dot(last.s, last.y) / Math.max(1e-20, dot(last.y, last.y))));
  }
  const result = Float64Array.from(q, (value) => scale * value);
  for (let index = 0; index < history.length; index += 1) {
    const item = history[index]!;
    const beta = item.rho * dot(item.y, result);
    for (let parameter = 0; parameter < result.length; parameter += 1) result[parameter] = result[parameter]! + item.s[parameter]! * (alpha[index]! - beta);
  }
  return Float64Array.from(result, (value) => -value);
}

export function optimizeLinkedBranchLengths(
  likelihood: DifferentiableLinkedLikelihood,
  assignment: Int32Array,
  initialLengths: Float64Array,
  options: BranchOptimizationOptions = {},
): BranchOptimizationResult {
  const maximumIterations = Math.max(1, Math.round(options.maximumIterations ?? 32));
  const tolerance = Math.max(1e-9, options.tolerance ?? 2e-6);
  const minimumLength = Math.max(1e-9, options.minimumLength ?? 1e-6);
  const maximumLength = Math.max(minimumLength * 10, options.maximumLength ?? 5);
  const historySize = Math.max(1, Math.round(options.historySize ?? 8));
  const sites = Math.max(1, assignment.length);
  const decode = (raw: Float64Array): Float64Array => Float64Array.from(raw, (value) => Math.max(minimumLength, Math.min(maximumLength, Math.exp(value))));
  let raw: Float64Array = Float64Array.from(initialLengths, (value) => Math.log(Math.max(minimumLength, Math.min(maximumLength, value))));
  let lengths: Float64Array = decode(raw);
  let evaluated = likelihood.evaluate(lengths, assignment, true);
  const initialLogLikelihood = evaluated.logLikelihood;
  let loss = -evaluated.logLikelihood / sites;
  let gradient = Float64Array.from(evaluated.gradient, (value, index) => -value * lengths[index]! / sites);
  const history: HistoryEntry[] = [];
  let converged = false;
  let iterations = 0;
  let gradientRms = Math.sqrt(dot(gradient, gradient) / Math.max(1, gradient.length));

  for (let iteration = 0; iteration < maximumIterations; iteration += 1) {
    options.signal?.throwIfAborted();
    gradientRms = Math.sqrt(dot(gradient, gradient) / Math.max(1, gradient.length));
    options.onProgress?.({ iteration: iteration + 1, maximumIterations, logLikelihood: evaluated.logLikelihood, gradientRms });
    if (gradientRms <= tolerance) { converged = true; break; }
    let search = direction(gradient, history);
    if (!(dot(gradient, search) < 0)) search = Float64Array.from(gradient, (value) => -value);
    let largest = 0;
    for (const value of search) largest = Math.max(largest, Math.abs(value));
    if (largest > 1.5) search = Float64Array.from(search, (value) => value * 1.5 / largest);
    const directional = dot(gradient, search);
    let accepted: { readonly raw: Float64Array; readonly lengths: Float64Array; readonly evaluation: LinkedLikelihoodEvaluation; readonly loss: number } | undefined;
    let step = 1;
    for (let trial = 0; trial < 12; trial += 1) {
      const candidateRaw = Float64Array.from(raw, (value, index) => Math.max(Math.log(minimumLength), Math.min(Math.log(maximumLength), value + step * search[index]!)));
      const candidateLengths = decode(candidateRaw);
      const candidateEvaluation = likelihood.evaluate(candidateLengths, assignment, true);
      const candidateLoss = -candidateEvaluation.logLikelihood / sites;
      if (candidateLoss <= loss + 1e-4 * step * directional) {
        accepted = { raw: candidateRaw, lengths: candidateLengths, evaluation: candidateEvaluation, loss: candidateLoss };
        break;
      }
      step *= 0.5;
    }
    if (accepted === undefined) { converged = true; break; }
    const nextGradient = Float64Array.from(accepted.evaluation.gradient, (value, index) => -value * accepted!.lengths[index]! / sites);
    const s = Float64Array.from(accepted.raw, (value, index) => value - raw[index]!);
    const y = Float64Array.from(nextGradient, (value, index) => value - gradient[index]!);
    const curvature = dot(s, y);
    if (curvature > 1e-12) {
      history.push({ s, y, rho: 1 / curvature });
      if (history.length > historySize) history.shift();
    }
    const improvement = evaluated.logLikelihood - accepted.evaluation.logLikelihood;
    raw = accepted.raw;
    lengths = accepted.lengths;
    evaluated = accepted.evaluation;
    loss = accepted.loss;
    gradient = nextGradient;
    iterations = iteration + 1;
    if (Math.abs(improvement) / sites <= tolerance) { converged = true; break; }
  }
  gradientRms = Math.sqrt(dot(gradient, gradient) / Math.max(1, gradient.length));
  return { lengths, logLikelihood: evaluated.logLikelihood, initialLogLikelihood, iterations, converged, gradientRms };
}

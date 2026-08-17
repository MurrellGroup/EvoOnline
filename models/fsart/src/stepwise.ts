import type {
  InformationCriterion,
  MergedBreakpoint,
  PartitionSegment,
  PartitionStep,
  SegmentEvaluator,
  SegmentLikelihood,
  StepwisePartitionOptions,
  StepwisePartitionResult,
} from "./types.js";
import { selectTreeBankBreakpoints } from "./tree-bank.js";

export function fastTreeParameterCount(taxa: number, segments: number): number {
  // GARD-style sharing: five free relative GTR rates and three free base
  // frequencies are global. Each unrooted segment adds 2n-3 branch lengths
  // and one Gamma shape parameter.
  return 8 + Math.max(1, segments) * (2 * taxa - 2);
}

export function treeHmmParameterCount(taxa: number, states: number): number {
  if (states <= 1) return 2 * taxa + 6;
  // Shared: five relative GTR rates and three free base frequencies. Each
  // topology contributes 2n-3 branch lengths and one Gamma shape; the HMM
  // contributes K-1 stationary weights and one switching-rate parameter.
  return 8 + states * (2 * taxa - 2) + (states - 1) + 1;
}

/** Largest state count for which the finite-sample AICc correction is
 * mathematically defined (n - k - 1 > 0). */
export function maximumAiccTreeStates(taxa: number, observations: number, limit = 64): number {
  let maximum = 0;
  for (let states = 1; states <= Math.max(1, Math.floor(limit)); states += 1) {
    if (observations - treeHmmParameterCount(taxa, states) - 1 <= 0) break;
    maximum = states;
  }
  return maximum;
}

export function informationCriterion(
  criterion: InformationCriterion,
  logLikelihood: number,
  parameterCount: number,
  observations: number,
): number {
  const aic = 2 * parameterCount - 2 * logLikelihood;
  if (criterion === "aic") return aic;
  if (criterion === "bic") return Math.log(Math.max(2, observations)) * parameterCount - 2 * logLikelihood;
  const denominator = observations - parameterCount - 1;
  return denominator > 0 ? aic + (2 * parameterCount * (parameterCount + 1)) / denominator : Infinity;
}

function segmentId(start: number, end: number): string {
  return `segment-${start}-${end}`;
}

function asPartitionSegment(value: SegmentLikelihood): PartitionSegment {
  return { ...value, id: segmentId(value.start, value.end) };
}

export async function selectStepwisePartition(
  breakpoints: readonly MergedBreakpoint[],
  evaluate: SegmentEvaluator,
  options: StepwisePartitionOptions,
): Promise<StepwisePartitionResult> {
  const criterion = options.criterion ?? "aicc";
  const minimumLength = Math.max(4, Math.round(options.minimumSegmentLength ?? Math.max(30, 2 * options.taxa - 3)));
  const maximumBreakpoints = Math.max(1, Math.min(100, Math.round(options.maximumBreakpoints ?? 8)));
  const maximumCandidates = Math.max(maximumBreakpoints, Math.min(500, Math.round(options.maximumCandidates ?? 24)));
  // A small number of very strong peaks can cluster far from a weaker real
  // event. Preserve evidence ordering while reserving alignment-wide coverage
  // inside the same fixed FastTree budget.
  const candidates = selectTreeBankBreakpoints(
    breakpoints,
    options.sites,
    maximumCandidates,
    minimumLength,
  );
  const cache = new Map<string, Promise<PartitionSegment>>();
  const getSegment = (start: number, end: number): Promise<PartitionSegment> => {
    const key = `${start}:${end}`;
    const existing = cache.get(key);
    if (existing !== undefined) return existing;
    const pending = evaluate(start, end).then(asPartitionSegment);
    cache.set(key, pending);
    return pending;
  };

  options.signal?.throwIfAborted();
  let segments = [await getSegment(1, options.sites)];
  let totalLogLikelihood = segments[0]!.logLikelihood;
  let parameterCount = fastTreeParameterCount(options.taxa, 1);
  let criterionValue = informationCriterion(criterion, totalLogLikelihood, parameterCount, options.sites);
  const steps: PartitionStep[] = [];
  const accepted: number[] = [];
  const unavailable = new Set<number>();
  let completedEvaluations = 0;
  let cachedBestImprovement = -Infinity;

  interface Proposal {
    readonly candidate: MergedBreakpoint;
    readonly parentIndex: number;
    readonly parent: PartitionSegment;
    readonly left: PartitionSegment;
    readonly right: PartitionSegment;
    readonly logLikelihood: number;
    readonly parameterCount: number;
    readonly criterionValue: number;
    readonly improvement: number;
  }

  while (accepted.length < maximumBreakpoints) {
    options.signal?.throwIfAborted();
    const remaining = candidates.filter((candidate) => !accepted.includes(candidate.breakpoint) && !unavailable.has(candidate.breakpoint));
    if (remaining.length === 0) break;
    const proposals: Proposal[] = [];
    const round = accepted.length;

    for (let candidateIndex = 0; candidateIndex < remaining.length; candidateIndex += 1) {
      options.signal?.throwIfAborted();
      const candidate = remaining[candidateIndex]!;
      const parentIndex = segments.findIndex((segment) => candidate.breakpoint >= segment.start && candidate.breakpoint < segment.end);
      if (parentIndex < 0) {
        unavailable.add(candidate.breakpoint);
        continue;
      }
      const parent = segments[parentIndex]!;
      const leftLength = candidate.breakpoint - parent.start + 1;
      const rightLength = parent.end - candidate.breakpoint;
      if (leftLength < minimumLength || rightLength < minimumLength) {
        unavailable.add(candidate.breakpoint);
        continue;
      }

      // Most work occurs in the first round. This geometric schedule remains
      // monotonic without pretending we know how many IC-improving rounds will
      // survive; the textual counters expose the exact work in progress.
      const withinRound = candidateIndex / Math.max(1, remaining.length);
      const fraction = Math.min(0.985, 1 - 2 ** -(round + withinRound + 1));
      options.onProgress?.(fraction, {
        message: `Best-first FastTree round ${round + 1}: candidate ${candidateIndex + 1} / ${remaining.length} · split ${parent.start}–${parent.end} at ${candidate.breakpoint}`,
        current: candidateIndex + 1,
        total: remaining.length,
        metricLabel: Number.isFinite(cachedBestImprovement) ? `best Δ${criterion.toUpperCase()}` : "accepted breakpoints",
        metricValue: Number.isFinite(cachedBestImprovement) ? cachedBestImprovement : accepted.length,
      });
      try {
        const [left, right] = await Promise.all([
          getSegment(parent.start, candidate.breakpoint),
          getSegment(candidate.breakpoint + 1, parent.end),
        ]);
        completedEvaluations += 1;
        const proposedLogLikelihood = totalLogLikelihood - parent.logLikelihood + left.logLikelihood + right.logLikelihood;
        const proposedParameterCount = fastTreeParameterCount(options.taxa, segments.length + 1);
        const proposedCriterion = informationCriterion(criterion, proposedLogLikelihood, proposedParameterCount, options.sites);
        const improvement = criterionValue - proposedCriterion;
        cachedBestImprovement = Math.max(cachedBestImprovement, improvement);
        proposals.push({
          candidate,
          parentIndex,
          parent,
          left,
          right,
          logLikelihood: proposedLogLikelihood,
          parameterCount: proposedParameterCount,
          criterionValue: proposedCriterion,
          improvement,
        });
      } catch {
        completedEvaluations += 1;
        unavailable.add(candidate.breakpoint);
      }
    }

    const best = proposals.sort((a, b) =>
      b.improvement - a.improvement
      || a.candidate.rank - b.candidate.rank
      || a.candidate.breakpoint - b.candidate.breakpoint
    )[0];
    if (best === undefined) break;

    const criterionBefore = criterionValue;
    const logLikelihoodBefore = totalLogLikelihood;
    const parameterCountBefore = parameterCount;
    if (!(best.improvement > 0)) {
      steps.push({
        candidateRank: best.candidate.rank,
        breakpoint: best.candidate.breakpoint,
        accepted: false,
        reason: `Best of ${proposals.length} valid remaining splits worsened ${criterion.toUpperCase()} by ${(-best.improvement).toFixed(3)}; best-first search stopped.`,
        criterionBefore,
        criterionAfter: best.criterionValue,
        deltaCriterion: best.improvement,
        logLikelihoodBefore,
        logLikelihoodAfter: best.logLikelihood,
        parameterCountBefore,
        parameterCountAfter: best.parameterCount,
        consecutiveFailures: 1,
      });
      break;
    }

    segments = [
      ...segments.slice(0, best.parentIndex),
      best.left,
      best.right,
      ...segments.slice(best.parentIndex + 1),
    ].sort((a, b) => a.start - b.start);
    totalLogLikelihood = best.logLikelihood;
    parameterCount = best.parameterCount;
    criterionValue = best.criterionValue;
    accepted.push(best.candidate.breakpoint);
    steps.push({
      candidateRank: best.candidate.rank,
      breakpoint: best.candidate.breakpoint,
      accepted: true,
      reason: `Best of ${proposals.length} valid remaining splits; ${criterion.toUpperCase()} improved by ${best.improvement.toFixed(3)}.`,
      criterionBefore,
      criterionAfter: best.criterionValue,
      deltaCriterion: best.improvement,
      logLikelihoodBefore,
      logLikelihoodAfter: best.logLikelihood,
      parameterCountBefore,
      parameterCountAfter: best.parameterCount,
      consecutiveFailures: 0,
    });
    cachedBestImprovement = -Infinity;
  }
  options.onProgress?.(1, {
    message: `${accepted.length} breakpoints accepted · ${segments.length} FastTree partitions`,
    current: completedEvaluations,
    total: completedEvaluations,
    metricLabel: criterion.toUpperCase(),
    metricValue: criterionValue,
  });
  const considered = await Promise.allSettled(cache.values());
  const candidateTrees = considered.flatMap((value) => value.status === "fulfilled" ? [value.value] : []);
  return {
    status: "complete",
    criterion,
    criterionValue,
    segments,
    candidateTrees,
    steps,
    acceptedBreakpoints: accepted.slice().sort((a, b) => a - b),
    rejectedBreakpoints: candidates
      .filter((candidate) => !accepted.includes(candidate.breakpoint))
      .map((candidate) => candidate.breakpoint),
  };
}

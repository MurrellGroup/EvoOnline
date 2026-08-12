import type { BreakpointAccuracy } from "./metrics.js";
import type { DiversitySummary } from "./diversity.js";

export type BenchmarkApproach = "ranked-window" | "local-hmm-merged" | "stepwise-aicc" | "tree-hmm-aicc" | "oracle-aicc" | "single-tree";

export interface ApproachResult {
  readonly approach: BenchmarkApproach;
  readonly predictedBreakpoints: readonly number[];
  readonly accuracy: BreakpointAccuracy | null;
  readonly topologyRf: number | null;
  readonly wallMs: number;
  readonly fastTreeFreshFits: number;
  readonly status: string;
}

export interface ReplicateResult {
  readonly diversityId: string;
  readonly diversityLabel: string;
  readonly branchLengthScale: number;
  readonly scenarioId: string;
  readonly scenarioLabel: string;
  readonly replicate: number;
  readonly seed: number;
  readonly taxa: number;
  readonly sites: number;
  readonly tolerance: number;
  readonly trueBreakpoints: readonly number[];
  readonly simulationMs: number;
  readonly scanMs: number;
  readonly hmmMs: number;
  readonly mergeMs: number;
  readonly rateSummary: {
    readonly mean: number;
    readonly invariantFraction: number;
    readonly q10: number;
    readonly median: number;
    readonly q90: number;
    readonly maximum: number;
  };
  readonly diversitySummary: DiversitySummary;
  readonly approaches: readonly ApproachResult[];
}

export interface SummaryResult {
  readonly diversityId: string;
  readonly diversityLabel: string;
  readonly branchLengthScale: number;
  readonly scenarioId: string;
  readonly scenarioLabel: string;
  readonly approach: BenchmarkApproach;
  readonly replicates: number;
  readonly trueBreakpoints: number;
  readonly predictedBreakpoints: number;
  readonly truePositive: number;
  readonly falsePositive: number;
  readonly falseNegative: number;
  readonly precision: number | null;
  readonly recall: number | null;
  readonly f1: number | null;
  readonly exactCountRate: number | null;
  readonly falsePositivesPerReplicate: number | null;
  readonly localizationMae: number | null;
  readonly intervalCoverage: number | null;
  readonly meanIntervalWidth: number | null;
  readonly topologyRf: number | null;
  readonly meanWallMs: number;
  readonly medianWallMs: number;
  readonly p95WallMs: number;
  readonly meanFastTreeFreshFits: number;
  readonly meanPairwiseDistance: number;
  readonly meanVariableSiteFraction: number;
  readonly meanParsimonyInformativeFraction: number;
  readonly meanEventsPerTriplet: number;
  readonly medianEventsPerTriplet: number;
  readonly eligibleTripletFraction: number;
}

export interface BenchmarkResult {
  readonly generatedAt: string;
  readonly config: Record<string, unknown>;
  readonly environment: Record<string, string | number | boolean | null>;
  readonly replicates: readonly ReplicateResult[];
  readonly summaries: readonly SummaryResult[];
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function quantile(values: readonly number[], probability: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const position = probability * (sorted.length - 1);
  const low = Math.floor(position);
  const high = Math.ceil(position);
  const fraction = position - low;
  return sorted[low]! * (1 - fraction) + sorted[high]! * fraction;
}

export function summarizeResults(replicates: readonly ReplicateResult[]): SummaryResult[] {
  const groups = new Map<string, {
    readonly diversityId: string;
    readonly diversityLabel: string;
    readonly branchLengthScale: number;
    readonly scenarioId: string;
    readonly scenarioLabel: string;
    readonly approach: BenchmarkApproach;
    readonly values: { readonly replicate: ReplicateResult; readonly approach: ApproachResult }[];
  }>();
  for (const replicate of replicates) {
    for (const approach of replicate.approaches) {
      const key = `${replicate.diversityId}\0${replicate.scenarioId}\0${approach.approach}`;
      const group = groups.get(key);
      const value = { replicate, approach };
      if (group === undefined) groups.set(key, {
        diversityId: replicate.diversityId,
        diversityLabel: replicate.diversityLabel,
        branchLengthScale: replicate.branchLengthScale,
        scenarioId: replicate.scenarioId,
        scenarioLabel: replicate.scenarioLabel,
        approach: approach.approach,
        values: [value],
      });
      else group.values.push(value);
    }
  }
  return Array.from(groups.values(), (group) => {
    const approaches = group.values.map((value) => value.approach);
    const replicates = group.values.map((value) => value.replicate);
    const accuracies = approaches.flatMap((value) => value.accuracy === null ? [] : [value.accuracy]);
    const trueBreakpoints = accuracies.reduce((sum, value) => sum + value.trueCount, 0);
    const predictedBreakpoints = accuracies.reduce((sum, value) => sum + value.predictedCount, 0);
    const truePositive = accuracies.reduce((sum, value) => sum + value.truePositive, 0);
    const falsePositive = accuracies.reduce((sum, value) => sum + value.falsePositive, 0);
    const falseNegative = accuracies.reduce((sum, value) => sum + value.falseNegative, 0);
    const precision = predictedBreakpoints === 0 ? null : truePositive / predictedBreakpoints;
    const recall = trueBreakpoints === 0 ? null : truePositive / trueBreakpoints;
    const f1Denominator = 2 * truePositive + falsePositive + falseNegative;
    const f1 = f1Denominator === 0 ? null : 2 * truePositive / f1Denominator;
    const matchedErrors = accuracies.flatMap((value) => value.matches.map((match) => match.error));
    const intervalValues = accuracies.filter((value) => value.intervalCoverage !== null);
    const topology = approaches.flatMap((value) => value.topologyRf === null ? [] : [value.topologyRf]);
    const timings = approaches.map((value) => value.wallMs);
    const diversity = replicates.map((value) => value.diversitySummary);
    return {
      diversityId: group.diversityId,
      diversityLabel: group.diversityLabel,
      branchLengthScale: group.branchLengthScale,
      scenarioId: group.scenarioId,
      scenarioLabel: group.scenarioLabel,
      approach: group.approach,
      replicates: approaches.length,
      trueBreakpoints,
      predictedBreakpoints,
      truePositive,
      falsePositive,
      falseNegative,
      precision,
      recall,
      f1,
      exactCountRate: accuracies.length === 0 ? null : accuracies.filter((value) => value.exactCount).length / accuracies.length,
      falsePositivesPerReplicate: accuracies.length === 0 ? null : falsePositive / accuracies.length,
      localizationMae: mean(matchedErrors),
      intervalCoverage: mean(intervalValues.map((value) => value.intervalCoverage!)),
      meanIntervalWidth: mean(intervalValues.flatMap((value) => value.meanIntervalWidth === null ? [] : [value.meanIntervalWidth])),
      topologyRf: mean(topology),
      meanWallMs: mean(timings) ?? 0,
      medianWallMs: quantile(timings, 0.5),
      p95WallMs: quantile(timings, 0.95),
      meanFastTreeFreshFits: mean(approaches.map((value) => value.fastTreeFreshFits)) ?? 0,
      meanPairwiseDistance: mean(diversity.map((value) => value.meanPairwiseDistance)) ?? 0,
      meanVariableSiteFraction: mean(diversity.map((value) => value.variableSiteFraction)) ?? 0,
      meanParsimonyInformativeFraction: mean(diversity.map((value) => value.parsimonyInformativeFraction)) ?? 0,
      meanEventsPerTriplet: mean(diversity.map((value) => value.meanEventsPerTriplet)) ?? 0,
      medianEventsPerTriplet: mean(diversity.map((value) => value.medianEventsPerTriplet)) ?? 0,
      eligibleTripletFraction: mean(diversity.map((value) => value.eligibleTripletFraction)) ?? 0,
    };
  });
}

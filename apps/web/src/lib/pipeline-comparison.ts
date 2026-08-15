import type { SavedAnalysis } from "./analysis-store.js";
import type {
  BsrelRunResult,
  CladeShiftRunResult,
  DifFubarRunResult,
  FameRunResult,
  FlavorRunResult,
  FubarRunResult,
  GlobalGammaRunResult,
} from "../types.js";

export type ComparisonUnit = "site" | "branch";
export type ComparisonThresholdDirection = "above" | "below";
export type ComparisonValueFormat = "probability" | "p-value" | "number" | "log-evidence";
export type AgreementMetric = "jaccard" | "overall";

export interface PipelineComparisonRecord {
  readonly analysis: SavedAnalysis;
  readonly datasetName: string;
  readonly sourceNodeId: string;
  readonly sourceLabel: string;
  readonly methodNodeId: string;
  readonly methodLabel: string;
}

export interface ComparisonSignalValue {
  readonly key: string;
  readonly label: string;
  readonly ordinal: number;
  readonly value: number;
}

export interface ComparisonSignal {
  readonly id: string;
  readonly analysisId: string;
  readonly modelId: string;
  readonly methodLabel: string;
  readonly metricId: string;
  readonly metricLabel: string;
  readonly unit: ComparisonUnit;
  readonly values: readonly ComparisonSignalValue[];
  readonly thresholdDirection: ComparisonThresholdDirection;
  readonly defaultThreshold: number;
  readonly thresholdMinimum: number;
  readonly thresholdMaximum: number;
  readonly thresholdStep: number;
  readonly format: ComparisonValueFormat;
}

export interface PipelineComparisonGroup {
  readonly key: string;
  readonly datasetName: string;
  readonly sourceNodeId: string;
  readonly sourceLabel: string;
  readonly allSources: boolean;
  readonly records: readonly PipelineComparisonRecord[];
}

export interface ComparisonTableRow {
  readonly key: string;
  readonly label: string;
  readonly ordinal: number;
  readonly values: Readonly<Record<string, number>>;
}

function numericParameter(analysis: SavedAnalysis, id: string, fallback: number): number {
  const value = analysis.parameters[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function finiteValues<T>(
  rows: readonly T[],
  key: (row: T) => string,
  label: (row: T) => string,
  ordinal: (row: T) => number,
  value: (row: T) => number | null | undefined,
): readonly ComparisonSignalValue[] {
  return rows.flatMap((row) => {
    const current = value(row);
    return current === null || current === undefined || !Number.isFinite(current)
      ? []
      : [{ key: key(row), label: label(row), ordinal: ordinal(row), value: current }];
  });
}

function probabilitySignal(
  record: PipelineComparisonRecord,
  unit: ComparisonUnit,
  metricId: string,
  metricLabel: string,
  values: readonly ComparisonSignalValue[],
  defaultThreshold: number,
): ComparisonSignal {
  return {
    id: `${record.analysis.id}:${unit}:${metricId}`,
    analysisId: record.analysis.id,
    modelId: record.analysis.modelId,
    methodLabel: record.methodLabel,
    metricId,
    metricLabel,
    unit,
    values,
    thresholdDirection: "above",
    defaultThreshold,
    thresholdMinimum: 0,
    thresholdMaximum: 1,
    thresholdStep: 0.01,
    format: "probability",
  };
}

function numberSignal(
  record: PipelineComparisonRecord,
  unit: ComparisonUnit,
  metricId: string,
  metricLabel: string,
  values: readonly ComparisonSignalValue[],
  defaultThreshold: number,
  format: ComparisonValueFormat = "number",
): ComparisonSignal {
  const finite = values.map((entry) => entry.value).filter(Number.isFinite);
  let maximum = Math.max(defaultThreshold, 1);
  let minimum = Math.min(0, defaultThreshold);
  for (const value of finite) {
    maximum = Math.max(maximum, value);
    minimum = Math.min(minimum, value);
  }
  const span = Math.max(1, maximum - minimum);
  return {
    id: `${record.analysis.id}:${unit}:${metricId}`,
    analysisId: record.analysis.id,
    modelId: record.analysis.modelId,
    methodLabel: record.methodLabel,
    metricId,
    metricLabel,
    unit,
    values,
    thresholdDirection: "above",
    defaultThreshold,
    thresholdMinimum: minimum,
    thresholdMaximum: maximum,
    thresholdStep: span / 100,
    format,
  };
}

function siteValues<T extends { readonly site: number }>(rows: readonly T[], value: (row: T) => number): readonly ComparisonSignalValue[] {
  return finiteValues(rows, (row) => String(row.site), (row) => `Codon ${row.site}`, (row) => row.site, value);
}

function branchValues<T extends { readonly branch: number; readonly nodeId: number; readonly name: string }>(rows: readonly T[], value: (row: T) => number | null): readonly ComparisonSignalValue[] {
  return finiteValues(rows, (row) => String(row.nodeId), (row) => row.name || `Branch ${row.branch}`, (row) => row.branch, value);
}

export function extractComparisonSignals(record: PipelineComparisonRecord): readonly ComparisonSignal[] {
  const { analysis } = record;
  if (analysis.modelId === "diffubar") {
    const result = analysis.result as DifFubarRunResult;
    const threshold = numericParameter(analysis, "posteriorThreshold", 0.95);
    return [
      probabilitySignal(record, "site", "max-reported", "Max reported posterior", siteValues(result.sites, (site) => Math.max(site.pOmega1Greater, site.pOmega2Greater, site.pOmega1Positive, site.pOmega2Positive)), threshold),
      probabilitySignal(record, "site", "max-differential", "Max differential posterior", siteValues(result.sites, (site) => Math.max(site.pOmega1Greater, site.pOmega2Greater)), threshold),
      probabilitySignal(record, "site", "group-1-greater", "P(ω₁ > ω₂)", siteValues(result.sites, (site) => site.pOmega1Greater), threshold),
      probabilitySignal(record, "site", "group-2-greater", "P(ω₂ > ω₁)", siteValues(result.sites, (site) => site.pOmega2Greater), threshold),
      probabilitySignal(record, "site", "group-1-positive", "P(ω₁ > 1)", siteValues(result.sites, (site) => site.pOmega1Positive), threshold),
      probabilitySignal(record, "site", "group-2-positive", "P(ω₂ > 1)", siteValues(result.sites, (site) => site.pOmega2Positive), threshold),
    ];
  }
  if (analysis.modelId === "fubar") {
    const result = analysis.result as FubarRunResult;
    const threshold = numericParameter(analysis, "posteriorThreshold", 0.95);
    return [
      probabilitySignal(record, "site", "positive", "Positive posterior", siteValues(result.sites, (site) => site.pPositive), threshold),
      probabilitySignal(record, "site", "purifying", "Purifying posterior", siteValues(result.sites, (site) => site.pPurifying), threshold),
      probabilitySignal(record, "site", "directional-max", "Max directional posterior", siteValues(result.sites, (site) => Math.max(site.pPositive, site.pPurifying)), threshold),
    ];
  }
  if (analysis.modelId === "fame") {
    const result = analysis.result as FameRunResult;
    const threshold = numericParameter(analysis, "posteriorThreshold", 0.9);
    return [
      probabilitySignal(record, "site", "positive", "Positive posterior", siteValues(result.sites, (site) => site.pPositive), threshold),
      numberSignal(record, "site", "bayes-factor", "Empirical Bayes factor", siteValues(result.sites, (site) => site.bayesFactor), 10),
    ];
  }
  if (analysis.modelId === "flavor") {
    const result = analysis.result as FlavorRunResult;
    const threshold = numericParameter(analysis, "posteriorThreshold", 0.9);
    return [
      probabilitySignal(record, "site", "positive", "Positive posterior", siteValues(result.sites, (site) => site.pPositive), threshold),
      probabilitySignal(record, "site", "uncapped", "P(uncapped)", siteValues(result.sites, (site) => site.pUncapped), threshold),
      probabilitySignal(record, "site", "positive-branch-fraction", "Mean positive branch fraction", siteValues(result.sites, (site) => site.meanPositiveBranchFraction), 0.5),
      numberSignal(record, "site", "bayes-factor", "Empirical Bayes factor", siteValues(result.sites, (site) => site.bayesFactor), 10),
    ];
  }
  if (analysis.modelId === "glamma") {
    const result = analysis.result as GlobalGammaRunResult;
    const threshold = numericParameter(analysis, "posteriorThreshold", 0.9);
    return [
      probabilitySignal(record, "site", "maximum-branch-posterior", "Max branch posterior", siteValues(result.sites, (site) => site.maximumBranchPosterior), threshold),
      probabilitySignal(record, "site", "conditional-support", "Conditional support", siteValues(result.sites, (site) => site.conditionalSupport), threshold),
      numberSignal(record, "site", "capped-log-evidence", "Capped log evidence", siteValues(result.sites, (site) => site.cappedLogEvidence), Math.log(10), "log-evidence"),
      probabilitySignal(record, "branch", "maximum-site-posterior", "Max site posterior", branchValues(result.branches, (branch) => branch.maximumSitePosterior), threshold),
      probabilitySignal(record, "branch", "any-site-posterior", "P(any positive site)", branchValues(result.branches, (branch) => branch.anySitePositivePosterior), threshold),
      numberSignal(record, "branch", "activation-log-bf", "Activation log BF", branchValues(result.branches, (branch) => branch.activationLogBayesFactor), Math.log(10), "log-evidence"),
      numberSignal(record, "branch", "capped-log-evidence", "Capped log evidence", branchValues(result.branches, (branch) => branch.cappedLogEvidence), Math.log(10), "log-evidence"),
    ];
  }
  if (analysis.modelId === "clade-shift") {
    const result = analysis.result as CladeShiftRunResult;
    const threshold = numericParameter(analysis, "posteriorThreshold", 0.9);
    return [
      probabilitySignal(record, "site", "shift", "P(any shift)", siteValues(result.sites, (site) => site.pShift), threshold),
      probabilitySignal(record, "site", "relaxation", "P(relaxation)", siteValues(result.sites, (site) => site.pRelaxation), threshold),
      probabilitySignal(record, "site", "intensification", "P(intensification)", siteValues(result.sites, (site) => site.pIntensification), threshold),
      numberSignal(record, "site", "shift-log-bf", "Shift log BF", siteValues(result.sites, (site) => site.logBayesFactor), Math.log(10), "log-evidence"),
      probabilitySignal(record, "branch", "maximum-site-posterior", "Max site posterior", branchValues(result.branches, (branch) => branch.maximumSitePosterior), threshold),
      numberSignal(record, "branch", "expected-shifted-sites", "Expected shifted sites", branchValues(result.branches, (branch) => branch.expectedShiftedSites), 1),
    ];
  }
  if (analysis.modelId === "bsrel") {
    const result = analysis.result as BsrelRunResult;
    const threshold = numericParameter(analysis, "significanceThreshold", 0.05);
    const holmValues = branchValues(result.branches, (branch) => branch.pValueHolm);
    const rawValues = branchValues(result.branches, (branch) => branch.pValue);
    return [
      {
        id: `${analysis.id}:branch:holm-p-value`,
        analysisId: analysis.id,
        modelId: analysis.modelId,
        methodLabel: record.methodLabel,
        metricId: "holm-p-value",
        metricLabel: "Holm-adjusted p-value",
        unit: "branch",
        values: holmValues,
        thresholdDirection: "below",
        defaultThreshold: threshold,
        thresholdMinimum: 0,
        thresholdMaximum: 0.25,
        thresholdStep: 0.005,
        format: "p-value",
      },
      {
        id: `${analysis.id}:branch:raw-p-value`,
        analysisId: analysis.id,
        modelId: analysis.modelId,
        methodLabel: record.methodLabel,
        metricId: "raw-p-value",
        metricLabel: "Raw p-value",
        unit: "branch",
        values: rawValues,
        thresholdDirection: "below",
        defaultThreshold: 0.05,
        thresholdMinimum: 0,
        thresholdMaximum: 0.25,
        thresholdStep: 0.005,
        format: "p-value",
      },
      numberSignal(record, "branch", "likelihood-ratio", "Likelihood ratio", branchValues(result.branches, (branch) => branch.likelihoodRatio), 3.84),
      numberSignal(record, "branch", "mean-omega", "Mean ω", branchValues(result.branches, (branch) => branch.meanOmega), 1),
    ];
  }
  return [];
}

export function groupPipelineComparisons(records: readonly PipelineComparisonRecord[]): readonly PipelineComparisonGroup[] {
  const datasets = new Map<string, PipelineComparisonRecord[]>();
  for (const record of records) {
    datasets.set(record.datasetName, [...(datasets.get(record.datasetName) ?? []), record]);
  }
  const output: PipelineComparisonGroup[] = [];
  for (const [datasetName, datasetRecords] of datasets) {
    const sources = new Map<string, PipelineComparisonRecord[]>();
    for (const record of datasetRecords) sources.set(record.sourceNodeId, [...(sources.get(record.sourceNodeId) ?? []), record]);
    if (sources.size > 1 && datasetRecords.some((record) => record.analysis.modelId !== "bsrel")) output.push({
      key: JSON.stringify([datasetName, "*"]),
      datasetName,
      sourceNodeId: "*",
      sourceLabel: "All source routes",
      allSources: true,
      records: datasetRecords,
    });
    for (const [sourceNodeId, sourceRecords] of sources) output.push({
      key: JSON.stringify([datasetName, sourceNodeId]),
      datasetName,
      sourceNodeId,
      sourceLabel: sourceRecords[0]!.sourceLabel,
      allSources: false,
      records: sourceRecords,
    });
  }
  return output.sort((left, right) => left.datasetName.localeCompare(right.datasetName) || Number(right.allSources) - Number(left.allSources) || left.sourceLabel.localeCompare(right.sourceLabel));
}

export function aggregateComparisonSignals(signals: readonly ComparisonSignal[]): readonly ComparisonTableRow[] {
  const rows = new Map<string, { label: string; ordinal: number; values: Record<string, number> }>();
  for (const signal of signals) {
    for (const entry of signal.values) {
      const row = rows.get(entry.key) ?? { label: entry.label, ordinal: entry.ordinal, values: {} };
      row.values[signal.id] = entry.value;
      rows.set(entry.key, row);
    }
  }
  return [...rows.entries()]
    .map(([key, row]) => ({ key, label: row.label, ordinal: row.ordinal, values: row.values }))
    .sort((left, right) => left.ordinal - right.ordinal || left.label.localeCompare(right.label));
}

export function pairedComparisonValues(left: ComparisonSignal, right: ComparisonSignal): readonly (readonly [number, number])[] {
  const rightValues = new Map(right.values.map((entry) => [entry.key, entry.value]));
  return left.values.flatMap((entry) => {
    const rightValue = rightValues.get(entry.key);
    return rightValue === undefined ? [] : [[entry.value, rightValue] as const];
  });
}

export function pearsonCorrelation(pairs: readonly (readonly [number, number])[]): number | null {
  if (pairs.length < 2) return null;
  const meanX = pairs.reduce((sum, pair) => sum + pair[0], 0) / pairs.length;
  const meanY = pairs.reduce((sum, pair) => sum + pair[1], 0) / pairs.length;
  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;
  for (const [x, y] of pairs) {
    const dx = x - meanX;
    const dy = y - meanY;
    covariance += dx * dy;
    varianceX += dx * dx;
    varianceY += dy * dy;
  }
  const denominator = Math.sqrt(varianceX * varianceY);
  return denominator === 0 ? null : covariance / denominator;
}

function ranks(values: readonly number[]): readonly number[] {
  const indexed = values.map((value, index) => ({ value, index })).sort((left, right) => left.value - right.value || left.index - right.index);
  const output = Array<number>(values.length);
  let start = 0;
  while (start < indexed.length) {
    let end = start + 1;
    while (end < indexed.length && indexed[end]!.value === indexed[start]!.value) end += 1;
    const rank = (start + end - 1) / 2 + 1;
    for (let index = start; index < end; index += 1) output[indexed[index]!.index] = rank;
    start = end;
  }
  return output;
}

export function spearmanCorrelation(pairs: readonly (readonly [number, number])[]): number | null {
  if (pairs.length < 2) return null;
  const xRanks = ranks(pairs.map((pair) => pair[0]));
  const yRanks = ranks(pairs.map((pair) => pair[1]));
  return pearsonCorrelation(xRanks.map((value, index) => [value, yRanks[index]!] as const));
}

export function comparisonSignalCall(signal: ComparisonSignal, value: number, threshold: number): boolean {
  return signal.thresholdDirection === "below" ? value <= threshold : value >= threshold;
}

export function binaryAgreement(
  left: ComparisonSignal,
  right: ComparisonSignal,
  leftThreshold: number,
  rightThreshold: number,
  metric: AgreementMetric,
): { readonly value: number | null; readonly count: number; readonly both: number; readonly either: number } {
  const pairs = pairedComparisonValues(left, right);
  let matches = 0;
  let both = 0;
  let either = 0;
  for (const [leftValue, rightValue] of pairs) {
    const leftCall = comparisonSignalCall(left, leftValue, leftThreshold);
    const rightCall = comparisonSignalCall(right, rightValue, rightThreshold);
    if (leftCall === rightCall) matches += 1;
    if (leftCall && rightCall) both += 1;
    if (leftCall || rightCall) either += 1;
  }
  const value = metric === "overall"
    ? pairs.length === 0 ? null : matches / pairs.length
    : either === 0 ? null : both / either;
  return { value, count: pairs.length, both, either };
}

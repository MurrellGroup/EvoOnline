import type { SimulatedDataset, SimulatorAnalysisResult } from "@phylo-workbench/model-simulator/browser-source";
import type { SavedAnalysis } from "./analysis-store.js";

export interface ComparisonVariable {
  readonly id: string;
  readonly label: string;
  readonly kind: "continuous" | "probability" | "p-value" | "binary";
}

export interface SimulationComparisonRow {
  readonly analysisId: string;
  readonly methodId: string;
  readonly datasetId: string;
  readonly datasetIndex: number;
  readonly site: number;
  readonly truth: Readonly<Record<string, number>>;
  readonly inference: Readonly<Record<string, number>>;
}

const TRUTH_VARIABLES: readonly ComparisonVariable[] = [
  { id: "alpha", label: "True synonymous rate α", kind: "continuous" },
  { id: "dnds", label: "True dN/dS (MG94 ω)", kind: "continuous" },
  { id: "logDnds", label: "True log dN/dS", kind: "continuous" },
  { id: "positive", label: "True positive state (ω > 1)", kind: "binary" },
  { id: "purifying", label: "True purifying state (ω < 1)", kind: "binary" },
  { id: "eventRate", label: "True SCUFF event rate λ", kind: "continuous" },
  { id: "sigma", label: "True SCUFF fitness SD σ", kind: "continuous" },
  { id: "mixingRate", label: "True SCUFF mixing rate θ", kind: "continuous" },
  { id: "scuffOmegaStar", label: "SCUFF Ω(σ) independent-redraw dN/dS", kind: "continuous" },
  { id: "scuffTraceMean", label: "SCUFF diagnostic mean expected dN/dS", kind: "continuous" },
  { id: "scuffTracePositiveFraction", label: "SCUFF diagnostic fraction of time dN/dS > 1", kind: "probability" },
];

const INFERENCE_VARIABLES: Readonly<Record<string, readonly ComparisonVariable[]>> = {
  fubar: [
    { id: "meanAlpha", label: "FUBAR posterior mean α", kind: "continuous" },
    { id: "meanBeta", label: "FUBAR posterior mean β", kind: "continuous" },
    { id: "meanDnds", label: "FUBAR posterior-mean β/α", kind: "continuous" },
    { id: "logMeanDnds", label: "FUBAR log posterior-mean β/α", kind: "continuous" },
    { id: "pPositive", label: "FUBAR P(β > α)", kind: "probability" },
    { id: "pPurifying", label: "FUBAR P(α > β)", kind: "probability" },
    { id: "detectedPositive", label: "FUBAR positive call", kind: "binary" },
    { id: "detectedPurifying", label: "FUBAR purifying call", kind: "binary" },
    { id: "felDnds", label: "Approximate FEL β̂/α̂", kind: "continuous" },
    { id: "felPPositive", label: "Approximate FEL positive p-value", kind: "p-value" },
    { id: "felPPurifying", label: "Approximate FEL purifying p-value", kind: "p-value" },
    { id: "felLrt", label: "Approximate FEL likelihood-ratio statistic", kind: "continuous" },
  ],
  fame: [
    { id: "meanAlpha", label: "FAME posterior mean α", kind: "continuous" },
    { id: "meanOmega1", label: "FAME posterior mean ω₁", kind: "continuous" },
    { id: "meanOmega2", label: "FAME posterior mean ω₂", kind: "continuous" },
    { id: "maximumMeanOmega", label: "FAME max(mean ω₁, mean ω₂)", kind: "continuous" },
    { id: "pPositive", label: "FAME positive-selection posterior", kind: "probability" },
    { id: "bayesFactor", label: "FAME empirical Bayes factor", kind: "continuous" },
    { id: "detectedPositive", label: "FAME positive call", kind: "binary" },
  ],
  flavor: [
    { id: "meanAlpha", label: "FLAVOR posterior mean α", kind: "continuous" },
    { id: "meanDnds", label: "FLAVOR posterior mean branch ω", kind: "continuous" },
    { id: "meanShape", label: "FLAVOR posterior mean Gamma shape", kind: "continuous" },
    { id: "meanOmegaSd", label: "FLAVOR posterior mean ω SD", kind: "continuous" },
    { id: "positiveBranchFraction", label: "FLAVOR mean positive-branch fraction", kind: "probability" },
    { id: "pPositive", label: "FLAVOR positive-selection posterior", kind: "probability" },
    { id: "pUncapped", label: "FLAVOR uncapped-state posterior", kind: "probability" },
    { id: "bayesFactor", label: "FLAVOR empirical Bayes factor", kind: "continuous" },
    { id: "detectedPositive", label: "FLAVOR positive call", kind: "binary" },
  ],
};

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function at(values: unknown, index: number): number | undefined {
  if (!Array.isArray(values) && !ArrayBuffer.isView(values)) return undefined;
  return finite((values as ArrayLike<unknown>)[index]);
}

function put(target: Record<string, number>, key: string, value: number | undefined): void {
  if (value !== undefined) target[key] = value;
}

function truthForSite(dataset: SimulatedDataset, simulation: SimulatorAnalysisResult, index: number): Record<string, number> {
  const truth: Record<string, number> = {};
  const parameters = dataset.siteParameters;
  if (parameters === undefined) return truth;
  const alpha = at(parameters.alpha, index);
  const omega = at(parameters.omega, index);
  put(truth, "alpha", alpha);
  put(truth, "dnds", omega);
  if (omega !== undefined && omega > 0) truth.logDnds = Math.log(omega);
  if (omega !== undefined) {
    truth.positive = omega > 1 ? 1 : 0;
    truth.purifying = omega < 1 ? 1 : 0;
  }
  put(truth, "eventRate", at(parameters.eventRate, index));
  put(truth, "sigma", at(parameters.equilibriumSigma, index));
  put(truth, "mixingRate", at(parameters.mixingRate, index));
  put(truth, "scuffOmegaStar", at(parameters.scuffMaximumExpectedDnds, index));
  if (simulation.scuffDiagnostic !== undefined) {
    truth.scuffTraceMean = simulation.scuffDiagnostic.sampledMeanDnds;
    truth.scuffTracePositiveFraction = simulation.scuffDiagnostic.dnds.filter((value) => value > 1).length / Math.max(1, simulation.scuffDiagnostic.dnds.length);
  }
  return truth;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function inferenceForSite(methodId: string, result: Record<string, unknown>, site: Record<string, unknown>, index: number): Record<string, number> {
  const inference: Record<string, number> = {};
  const meanAlpha = finite(site.meanAlpha);
  put(inference, "meanAlpha", meanAlpha);
  if (methodId === "fubar") {
    const meanBeta = finite(site.meanBeta);
    put(inference, "meanBeta", meanBeta);
    if (meanAlpha !== undefined && meanBeta !== undefined && meanAlpha > 0) {
      inference.meanDnds = meanBeta / meanAlpha;
      inference.logMeanDnds = Math.log(Math.max(Number.MIN_VALUE, meanBeta / meanAlpha));
    }
    put(inference, "pPositive", finite(site.pPositive));
    put(inference, "pPurifying", finite(site.pPurifying));
    inference.detectedPositive = site.selection === "positive" ? 1 : 0;
    inference.detectedPurifying = site.selection === "purifying" ? 1 : 0;
    const approximateFel = record(result.approximateFel);
    const felSites = approximateFel?.sites;
    const fel = Array.isArray(felSites) ? record(felSites[index]) : undefined;
    if (fel !== undefined) {
      const felAlpha = finite(fel.alphaAlternative);
      const felBeta = finite(fel.betaAlternative);
      if (felAlpha !== undefined && felBeta !== undefined && felAlpha > 0) inference.felDnds = felBeta / felAlpha;
      put(inference, "felPPositive", finite(fel.pPositive));
      put(inference, "felPPurifying", finite(fel.pPurifying));
      put(inference, "felLrt", finite(fel.likelihoodRatio));
    }
  } else if (methodId === "fame") {
    const omega1 = finite(site.meanOmega1);
    const omega2 = finite(site.meanOmega2);
    put(inference, "meanOmega1", omega1);
    put(inference, "meanOmega2", omega2);
    if (omega1 !== undefined && omega2 !== undefined) inference.maximumMeanOmega = Math.max(omega1, omega2);
    put(inference, "pPositive", finite(site.pPositive));
    put(inference, "bayesFactor", finite(site.bayesFactor));
    inference.detectedPositive = site.detected === true ? 1 : 0;
  } else if (methodId === "flavor") {
    put(inference, "meanDnds", finite(site.meanOmega));
    put(inference, "meanShape", finite(site.meanShape));
    put(inference, "meanOmegaSd", finite(site.meanOmegaStandardDeviation));
    put(inference, "positiveBranchFraction", finite(site.meanPositiveBranchFraction));
    put(inference, "pPositive", finite(site.pPositive));
    put(inference, "pUncapped", finite(site.pUncapped));
    put(inference, "bayesFactor", finite(site.bayesFactor));
    inference.detectedPositive = site.detected === true ? 1 : 0;
  }
  return inference;
}

export function buildSimulationComparisonRows(simulation: SimulatorAnalysisResult, analyses: readonly SavedAnalysis[]): readonly SimulationComparisonRow[] {
  const datasets = new Map(simulation.datasets.map((dataset, index) => [dataset.id, { dataset, index }]));
  const rows: SimulationComparisonRow[] = [];
  for (const analysis of analyses) {
    const source = analysis.simulationSource;
    if (source === undefined) continue;
    const matched = datasets.get(source.datasetId);
    if (matched === undefined) continue;
    const result = record(analysis.result);
    const sites = result?.sites;
    if (result === undefined || !Array.isArray(sites)) continue;
    for (let index = 0; index < sites.length; index += 1) {
      const site = record(sites[index]);
      if (site === undefined) continue;
      const siteNumber = finite(site.site) ?? index + 1;
      const truth = truthForSite(matched.dataset, simulation, Math.max(0, Math.round(siteNumber) - 1));
      const inference = inferenceForSite(analysis.modelId, result, site, index);
      if (Object.keys(truth).length === 0 || Object.keys(inference).length === 0) continue;
      rows.push({ analysisId: analysis.id, methodId: analysis.modelId, datasetId: matched.dataset.id, datasetIndex: matched.index, site: siteNumber, truth, inference });
    }
  }
  return rows;
}

function present(rows: readonly SimulationComparisonRow[], side: "truth" | "inference", variable: ComparisonVariable): boolean {
  return rows.some((row) => Number.isFinite(row[side][variable.id]));
}

export function availableTruthVariables(rows: readonly SimulationComparisonRow[]): readonly ComparisonVariable[] {
  return TRUTH_VARIABLES.filter((variable) => present(rows, "truth", variable));
}

export function availableInferenceVariables(rows: readonly SimulationComparisonRow[], methodId: string): readonly ComparisonVariable[] {
  return (INFERENCE_VARIABLES[methodId] ?? []).filter((variable) => present(rows, "inference", variable));
}

export interface ConfusionMatrix {
  readonly truePositive: number;
  readonly falsePositive: number;
  readonly falseNegative: number;
  readonly trueNegative: number;
  readonly sensitivity: number;
  readonly specificity: number;
  readonly precision: number;
  readonly accuracy: number;
}

export function thresholdPass(value: number, threshold: number, direction: "at-least" | "at-most"): boolean {
  return direction === "at-least" ? value >= threshold : value <= threshold;
}

export function comparisonConfusionMatrix(rows: readonly SimulationComparisonRow[], truthKey: string, inferenceKey: string, truthThreshold: number, inferenceThreshold: number, truthDirection: "at-least" | "at-most", inferenceDirection: "at-least" | "at-most"): ConfusionMatrix {
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let trueNegative = 0;
  for (const row of rows) {
    const truth = row.truth[truthKey];
    const inference = row.inference[inferenceKey];
    if (!Number.isFinite(truth) || !Number.isFinite(inference)) continue;
    const positive = thresholdPass(truth!, truthThreshold, truthDirection);
    const detected = thresholdPass(inference!, inferenceThreshold, inferenceDirection);
    if (positive && detected) truePositive += 1;
    else if (!positive && detected) falsePositive += 1;
    else if (positive) falseNegative += 1;
    else trueNegative += 1;
  }
  const safe = (numerator: number, denominator: number): number => denominator > 0 ? numerator / denominator : 0;
  const total = truePositive + falsePositive + falseNegative + trueNegative;
  return {
    truePositive,
    falsePositive,
    falseNegative,
    trueNegative,
    sensitivity: safe(truePositive, truePositive + falseNegative),
    specificity: safe(trueNegative, trueNegative + falsePositive),
    precision: safe(truePositive, truePositive + falsePositive),
    accuracy: safe(truePositive + trueNegative, total),
  };
}

export function pearsonCorrelation(rows: readonly SimulationComparisonRow[], truthKey: string, inferenceKey: string): number {
  const pairs = rows.map((row) => [row.truth[truthKey], row.inference[inferenceKey]] as const).filter((pair): pair is readonly [number, number] => Number.isFinite(pair[0]) && Number.isFinite(pair[1]));
  if (pairs.length < 2) return 0;
  const meanX = pairs.reduce((sum, pair) => sum + pair[0], 0) / pairs.length;
  const meanY = pairs.reduce((sum, pair) => sum + pair[1], 0) / pairs.length;
  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;
  for (const [x, y] of pairs) {
    covariance += (x - meanX) * (y - meanY);
    varianceX += (x - meanX) ** 2;
    varianceY += (y - meanY) ** 2;
  }
  return varianceX > 0 && varianceY > 0 ? covariance / Math.sqrt(varianceX * varianceY) : 0;
}

export function suggestedThreshold(variable: ComparisonVariable): { readonly value: number; readonly direction: "at-least" | "at-most" } {
  if (variable.kind === "p-value") return { value: 0.05, direction: "at-most" };
  if (variable.kind === "probability") return { value: 0.95, direction: "at-least" };
  if (variable.kind === "binary") return { value: 0.5, direction: "at-least" };
  if (/dN\/dS|ω|Ω|Omega/i.test(variable.label)) return { value: 1, direction: "at-least" };
  return { value: 0, direction: "at-least" };
}

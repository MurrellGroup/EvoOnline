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
export type ComparisonSignalProvenance = "reported" | "derived";
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
  readonly provenance: ComparisonSignalProvenance;
  readonly description?: string;
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
    provenance: "reported",
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
    provenance: "reported",
  };
}

function pValueSignal(
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
    thresholdDirection: "below",
    defaultThreshold,
    thresholdMinimum: 0,
    thresholdMaximum: 0.25,
    thresholdStep: 0.005,
    format: "p-value",
    provenance: "reported",
  };
}

function derivedSignal(signal: ComparisonSignal, description: string): ComparisonSignal {
  return { ...signal, provenance: "derived", description };
}

function availableSignals(signals: readonly ComparisonSignal[]): readonly ComparisonSignal[] {
  return signals.filter((signal) => signal.values.length > 0);
}

function siteValues<T extends { readonly site: number }>(rows: readonly T[], value: (row: T) => number | null | undefined): readonly ComparisonSignalValue[] {
  return finiteValues(rows, (row) => String(row.site), (row) => `Codon ${row.site}`, (row) => row.site, value);
}

function branchValues<T extends { readonly branch: number; readonly nodeId: number; readonly name: string }>(rows: readonly T[], value: (row: T) => number | null): readonly ComparisonSignalValue[] {
  return finiteValues(rows, (row) => String(row.nodeId), (row) => row.name || `Branch ${row.branch}`, (row) => row.branch, value);
}

function positiveRatio(numerator: number, denominator: number): number | undefined {
  return numerator >= 0 && denominator > 0 ? numerator / denominator : undefined;
}

function logPositive(value: number): number | undefined {
  return value > 0 ? Math.log(value) : undefined;
}

function logRatio(numerator: number, denominator: number): number | undefined {
  const ratio = positiveRatio(numerator, denominator);
  return ratio !== undefined && ratio > 0 ? Math.log(ratio) : undefined;
}

function marginalPosteriorExpectation(
  siteCount: number,
  parameterValues: ArrayLike<number> | undefined,
  masses: ArrayLike<number> | undefined,
  transform: (value: number) => number,
): readonly number[] | undefined {
  if (parameterValues === undefined || masses === undefined || siteCount <= 0 || parameterValues.length === 0 || masses.length !== siteCount * parameterValues.length) return undefined;
  const output = new Array<number>(siteCount).fill(0);
  for (let site = 0; site < siteCount; site += 1) {
    const offset = site * parameterValues.length;
    for (let index = 0; index < parameterValues.length; index += 1) output[site] = output[site]! + masses[offset + index]! * transform(parameterValues[index]!);
  }
  return output;
}

function siteMajorSurfaceExpectation(
  siteCount: number,
  surfaces: ArrayLike<number> | undefined,
  categoryValues: ArrayLike<number>,
): readonly number[] | undefined {
  if (surfaces === undefined || siteCount <= 0 || categoryValues.length === 0 || surfaces.length !== siteCount * categoryValues.length) return undefined;
  const output = new Array<number>(siteCount).fill(0);
  for (let site = 0; site < siteCount; site += 1) {
    const offset = site * categoryValues.length;
    for (let category = 0; category < categoryValues.length; category += 1) output[site] = output[site]! + surfaces[offset + category]! * categoryValues[category]!;
  }
  return output;
}

function famePosteriorMeanDn(result: FameRunResult, group: 1 | 2): readonly number[] | undefined {
  const posterior = result.posterior;
  if (posterior === undefined) return undefined;
  const categoryValues = new Float64Array(posterior.alphaValues.length * posterior.omega1Values.length * posterior.omega2Values.length);
  let category = 0;
  for (const alpha of posterior.alphaValues) {
    for (const omega1 of posterior.omega1Values) {
      for (const omega2 of posterior.omega2Values) {
        categoryValues[category] = alpha * (group === 1 ? omega1 : omega2);
        category += 1;
      }
    }
  }
  return siteMajorSurfaceExpectation(posterior.siteCount, posterior.surfaces, categoryValues);
}

function flavorPosteriorMeanDnParameter(result: FlavorRunResult): readonly number[] | undefined {
  const posterior = result.posterior;
  if (posterior === undefined) return undefined;
  const categoryValues = new Float64Array(2 * posterior.muValues.length * posterior.shapeValues.length * posterior.alphaValues.length);
  let category = 0;
  for (let cap = 0; cap < 2; cap += 1) {
    for (const mu of posterior.muValues) {
      for (let shape = 0; shape < posterior.shapeValues.length; shape += 1) {
        for (const alpha of posterior.alphaValues) {
          categoryValues[category] = alpha * mu;
          category += 1;
        }
      }
    }
  }
  return siteMajorSurfaceExpectation(posterior.siteCount, posterior.surfaces, categoryValues);
}

export function extractComparisonSignals(record: PipelineComparisonRecord): readonly ComparisonSignal[] {
  const { analysis } = record;
  if (analysis.modelId === "diffubar") {
    const result = analysis.result as DifFubarRunResult;
    const threshold = numericParameter(analysis, "posteriorThreshold", 0.95);
    const posterior = result.posteriorMarginals;
    const posteriorMeanLogOmega1 = posterior === undefined ? undefined : marginalPosteriorExpectation(posterior.siteCount, posterior.omegaValues, posterior.omega1, Math.log);
    const posteriorMeanLogOmega2 = posterior === undefined ? undefined : marginalPosteriorExpectation(posterior.siteCount, posterior.omegaValues, posterior.omega2, Math.log);
    return availableSignals([
      derivedSignal(probabilitySignal(record, "site", "max-reported", "Max reported posterior", siteValues(result.sites, (site) => Math.max(site.pOmega1Greater, site.pOmega2Greater, site.pOmega1Positive, site.pOmega2Positive)), threshold), "Maximum of the four reported DifFUBAR posterior probabilities."),
      derivedSignal(probabilitySignal(record, "site", "max-differential", "Max differential posterior", siteValues(result.sites, (site) => Math.max(site.pOmega1Greater, site.pOmega2Greater)), threshold), "Maximum of the two directional differential-selection posteriors."),
      probabilitySignal(record, "site", "group-1-greater", "P(ω₁ > ω₂)", siteValues(result.sites, (site) => site.pOmega1Greater), threshold),
      probabilitySignal(record, "site", "group-2-greater", "P(ω₂ > ω₁)", siteValues(result.sites, (site) => site.pOmega2Greater), threshold),
      probabilitySignal(record, "site", "group-1-positive", "P(ω₁ > 1)", siteValues(result.sites, (site) => site.pOmega1Positive), threshold),
      probabilitySignal(record, "site", "group-2-positive", "P(ω₂ > 1)", siteValues(result.sites, (site) => site.pOmega2Positive), threshold),
      numberSignal(record, "site", "mean-alpha", "Posterior mean dS · E[α]", siteValues(result.sites, (site) => site.meanAlpha), 1),
      numberSignal(record, "site", "mean-omega-1", "Posterior mean ω₁", siteValues(result.sites, (site) => site.meanOmega1), 1),
      numberSignal(record, "site", "mean-omega-2", "Posterior mean ω₂", siteValues(result.sites, (site) => site.meanOmega2), 1),
      derivedSignal(numberSignal(record, "site", "mean-dn-proxy-1", "Mean dN₁ proxy · E[α]E[ω₁]", siteValues(result.sites, (site) => site.meanAlpha * site.meanOmega1), 1), "DifFUBAR retains marginal posterior means, not the joint α–ω posterior; this is E[α] × E[ω₁], not E[αω₁]."),
      derivedSignal(numberSignal(record, "site", "mean-dn-proxy-2", "Mean dN₂ proxy · E[α]E[ω₂]", siteValues(result.sites, (site) => site.meanAlpha * site.meanOmega2), 1), "DifFUBAR retains marginal posterior means, not the joint α–ω posterior; this is E[α] × E[ω₂], not E[αω₂]."),
      derivedSignal(numberSignal(record, "site", "log-mean-rate-ratio-1", "log(E[dN₁]) − log(E[dS])", siteValues(result.sites, (site) => logPositive(site.meanOmega1)), 0), "Log ratio of the marginal-mean dN proxy to posterior mean dS; algebraically log(E[ω₁])."),
      derivedSignal(numberSignal(record, "site", "log-mean-rate-ratio-2", "log(E[dN₂]) − log(E[dS])", siteValues(result.sites, (site) => logPositive(site.meanOmega2)), 0), "Log ratio of the marginal-mean dN proxy to posterior mean dS; algebraically log(E[ω₂])."),
      derivedSignal(numberSignal(record, "site", "exp-log-mean-rate-ratio-1", "exp(log(E[dN₁]) − log(E[dS]))", siteValues(result.sites, (site) => site.meanOmega1), 1), "Exponentiated log ratio of marginal means; equal to E[ω₁]."),
      derivedSignal(numberSignal(record, "site", "exp-log-mean-rate-ratio-2", "exp(log(E[dN₂]) − log(E[dS]))", siteValues(result.sites, (site) => site.meanOmega2), 1), "Exponentiated log ratio of marginal means; equal to E[ω₂]."),
      derivedSignal(numberSignal(record, "site", "posterior-mean-log-ratio-1", "Posterior E[log(dN/dS)] · group 1", siteValues(result.sites, (site) => posteriorMeanLogOmega1?.[site.site - 1]), 0), "Computed exactly from the retained posterior ω₁ marginal because log(dN) − log(dS) = log(ω)."),
      derivedSignal(numberSignal(record, "site", "posterior-mean-log-ratio-2", "Posterior E[log(dN/dS)] · group 2", siteValues(result.sites, (site) => posteriorMeanLogOmega2?.[site.site - 1]), 0), "Computed exactly from the retained posterior ω₂ marginal because log(dN) − log(dS) = log(ω)."),
      derivedSignal(numberSignal(record, "site", "geometric-mean-rate-ratio-1", "exp(E[log(dN/dS)]) · group 1", siteValues(result.sites, (site) => { const value = posteriorMeanLogOmega1?.[site.site - 1]; return value === undefined ? undefined : Math.exp(value); }), 1), "Posterior geometric mean dN/dS for group 1."),
      derivedSignal(numberSignal(record, "site", "geometric-mean-rate-ratio-2", "exp(E[log(dN/dS)]) · group 2", siteValues(result.sites, (site) => { const value = posteriorMeanLogOmega2?.[site.site - 1]; return value === undefined ? undefined : Math.exp(value); }), 1), "Posterior geometric mean dN/dS for group 2."),
      derivedSignal(numberSignal(record, "site", "mean-omega-difference", "Mean ω₂ − mean ω₁", siteValues(result.sites, (site) => site.meanOmega2 - site.meanOmega1), 0), "Difference between the two reported posterior mean ω values."),
      derivedSignal(numberSignal(record, "site", "mean-omega-ratio", "Mean ω₂ / mean ω₁", siteValues(result.sites, (site) => positiveRatio(site.meanOmega2, site.meanOmega1)), 1), "Ratio of the two reported posterior mean ω values."),
    ]);
  }
  if (analysis.modelId === "fubar") {
    const result = analysis.result as FubarRunResult;
    const threshold = numericParameter(analysis, "posteriorThreshold", 0.95);
    const posterior = result.posterior;
    const posteriorMeanLogAlpha = posterior === undefined ? undefined : marginalPosteriorExpectation(posterior.siteCount, posterior.gridValues, posterior.alpha, Math.log);
    const posteriorMeanLogBeta = posterior === undefined ? undefined : marginalPosteriorExpectation(posterior.siteCount, posterior.gridValues, posterior.beta, Math.log);
    const posteriorMeanLogRatio = posteriorMeanLogAlpha?.map((value, index) => posteriorMeanLogBeta === undefined ? Number.NaN : posteriorMeanLogBeta[index]! - value);
    const approximateFel = result.approximateFel?.sites ?? [];
    return availableSignals([
      probabilitySignal(record, "site", "positive", "Positive posterior", siteValues(result.sites, (site) => site.pPositive), threshold),
      probabilitySignal(record, "site", "purifying", "Purifying posterior", siteValues(result.sites, (site) => site.pPurifying), threshold),
      derivedSignal(probabilitySignal(record, "site", "directional-max", "Max directional posterior", siteValues(result.sites, (site) => Math.max(site.pPositive, site.pPurifying)), threshold), "Maximum of the positive- and purifying-selection posteriors."),
      numberSignal(record, "site", "mean-alpha", "Posterior mean dS · E[α]", siteValues(result.sites, (site) => site.meanAlpha), 1),
      numberSignal(record, "site", "mean-beta", "Posterior mean dN · E[β]", siteValues(result.sites, (site) => site.meanBeta), 1),
      derivedSignal(numberSignal(record, "site", "mean-beta-minus-alpha", "Posterior mean dN − dS", siteValues(result.sites, (site) => site.meanBeta - site.meanAlpha), 0), "Difference between the reported posterior mean β and α rate parameters."),
      derivedSignal(numberSignal(record, "site", "log-mean-rate-ratio", "log(E[dN]) − log(E[dS])", siteValues(result.sites, (site) => logRatio(site.meanBeta, site.meanAlpha)), 0), "Log ratio of the two reported posterior mean rate parameters."),
      derivedSignal(numberSignal(record, "site", "exp-log-mean-rate-ratio", "exp(log(E[dN]) − log(E[dS]))", siteValues(result.sites, (site) => positiveRatio(site.meanBeta, site.meanAlpha)), 1), "Ratio E[β] / E[α]; this is a ratio of posterior means, not E[β/α]."),
      derivedSignal(numberSignal(record, "site", "posterior-mean-log-ds", "Posterior E[log dS]", siteValues(result.sites, (site) => posteriorMeanLogAlpha?.[site.site - 1]), 0), "Computed from the retained α posterior marginal."),
      derivedSignal(numberSignal(record, "site", "posterior-mean-log-dn", "Posterior E[log dN]", siteValues(result.sites, (site) => posteriorMeanLogBeta?.[site.site - 1]), 0), "Computed from the retained β posterior marginal."),
      derivedSignal(numberSignal(record, "site", "posterior-mean-log-ratio", "Posterior E[log(dN/dS)]", siteValues(result.sites, (site) => posteriorMeanLogRatio?.[site.site - 1]), 0), "Exact posterior E[log β − log α] from the retained marginals."),
      derivedSignal(numberSignal(record, "site", "geometric-mean-rate-ratio", "exp(E[log(dN/dS)])", siteValues(result.sites, (site) => { const value = posteriorMeanLogRatio?.[site.site - 1]; return value === undefined ? undefined : Math.exp(value); }), 1), "Posterior geometric mean dN/dS."),
      pValueSignal(record, "site", "fel-two-sided-p", "Approx. FEL two-sided p-value", siteValues(approximateFel, (site) => site.pValue), 0.05),
      pValueSignal(record, "site", "fel-positive-p", "Approx. FEL positive p-value", siteValues(approximateFel, (site) => site.pPositive), 0.05),
      pValueSignal(record, "site", "fel-purifying-p", "Approx. FEL purifying p-value", siteValues(approximateFel, (site) => site.pPurifying), 0.05),
      numberSignal(record, "site", "fel-likelihood-ratio", "Approx. FEL likelihood ratio", siteValues(approximateFel, (site) => site.likelihoodRatio), 3.84),
      numberSignal(record, "site", "fel-alpha", "Approx. FEL dS · α̂", siteValues(approximateFel, (site) => site.alphaAlternative), 1),
      numberSignal(record, "site", "fel-beta", "Approx. FEL dN · β̂", siteValues(approximateFel, (site) => site.betaAlternative), 1),
      derivedSignal(numberSignal(record, "site", "fel-log-rate-ratio", "Approx. FEL log(dN/dS)", siteValues(approximateFel, (site) => logRatio(site.betaAlternative, site.alphaAlternative)), 0), "Log of the approximate FEL alternative-model β̂/α̂ ratio."),
      derivedSignal(numberSignal(record, "site", "fel-rate-ratio", "Approx. FEL exp(log(dN/dS))", siteValues(approximateFel, (site) => positiveRatio(site.betaAlternative, site.alphaAlternative)), 1), "Approximate FEL alternative-model β̂/α̂ ratio."),
      numberSignal(record, "site", "fel-null-rate", "Approx. FEL null rate", siteValues(approximateFel, (site) => site.alphaBetaNull), 1),
      numberSignal(record, "site", "fel-alternative-log-likelihood", "Approx. FEL alternative log L", siteValues(approximateFel, (site) => site.logLikelihoodAlternative), 0),
      numberSignal(record, "site", "fel-null-log-likelihood", "Approx. FEL null log L", siteValues(approximateFel, (site) => site.logLikelihoodNull), 0),
      numberSignal(record, "site", "fel-grid-log-likelihood", "Approx. FEL grid max log L", siteValues(approximateFel, (site) => site.gridLogLikelihoodMaximum), 0),
      numberSignal(record, "site", "fel-spline-tension", "Approx. FEL spline tension", siteValues(approximateFel, (site) => site.splineTension), 1),
    ]);
  }
  if (analysis.modelId === "fame") {
    const result = analysis.result as FameRunResult;
    const threshold = numericParameter(analysis, "posteriorThreshold", 0.9);
    const meanDn1 = famePosteriorMeanDn(result, 1);
    const meanDn2 = famePosteriorMeanDn(result, 2);
    const posterior = result.posterior;
    const posteriorMeanLogOmega1 = posterior === undefined ? undefined : marginalPosteriorExpectation(posterior.siteCount, posterior.omega1Values, posterior.omega1, Math.log);
    const posteriorMeanLogOmega2 = posterior === undefined ? undefined : marginalPosteriorExpectation(posterior.siteCount, posterior.omega2Values, posterior.omega2, Math.log);
    return availableSignals([
      probabilitySignal(record, "site", "positive", "Positive posterior", siteValues(result.sites, (site) => site.pPositive), threshold),
      numberSignal(record, "site", "bayes-factor", "Empirical Bayes factor", siteValues(result.sites, (site) => site.bayesFactor), 10),
      numberSignal(record, "site", "mean-alpha", "Posterior mean dS · E[α]", siteValues(result.sites, (site) => site.meanAlpha), 1),
      numberSignal(record, "site", "mean-omega-1", "Posterior mean ω₁", siteValues(result.sites, (site) => site.meanOmega1), 1),
      numberSignal(record, "site", "mean-omega-2", "Posterior mean ω₂", siteValues(result.sites, (site) => site.meanOmega2), 1),
      derivedSignal(numberSignal(record, "site", "mean-dn-1", "Posterior mean dN₁ · E[αω₁]", siteValues(result.sites, (site) => meanDn1?.[site.site - 1]), 1), "Computed exactly from the retained joint α–ω₁–ω₂ posterior surface."),
      derivedSignal(numberSignal(record, "site", "mean-dn-2", "Posterior mean dN₂ · E[αω₂]", siteValues(result.sites, (site) => meanDn2?.[site.site - 1]), 1), "Computed exactly from the retained joint α–ω₁–ω₂ posterior surface."),
      derivedSignal(numberSignal(record, "site", "log-mean-rate-ratio-1", "log(E[dN₁]) − log(E[dS])", siteValues(result.sites, (site) => { const dN = meanDn1?.[site.site - 1]; return dN === undefined ? undefined : logRatio(dN, site.meanAlpha); }), 0), "Log ratio of exact posterior mean αω₁ to posterior mean α."),
      derivedSignal(numberSignal(record, "site", "log-mean-rate-ratio-2", "log(E[dN₂]) − log(E[dS])", siteValues(result.sites, (site) => { const dN = meanDn2?.[site.site - 1]; return dN === undefined ? undefined : logRatio(dN, site.meanAlpha); }), 0), "Log ratio of exact posterior mean αω₂ to posterior mean α."),
      derivedSignal(numberSignal(record, "site", "exp-log-mean-rate-ratio-1", "exp(log(E[dN₁]) − log(E[dS]))", siteValues(result.sites, (site) => { const dN = meanDn1?.[site.site - 1]; return dN === undefined ? undefined : positiveRatio(dN, site.meanAlpha); }), 1), "Ratio E[αω₁] / E[α]."),
      derivedSignal(numberSignal(record, "site", "exp-log-mean-rate-ratio-2", "exp(log(E[dN₂]) − log(E[dS]))", siteValues(result.sites, (site) => { const dN = meanDn2?.[site.site - 1]; return dN === undefined ? undefined : positiveRatio(dN, site.meanAlpha); }), 1), "Ratio E[αω₂] / E[α]."),
      derivedSignal(numberSignal(record, "site", "posterior-mean-log-ratio-1", "Posterior E[log(dN/dS)] · group 1", siteValues(result.sites, (site) => posteriorMeanLogOmega1?.[site.site - 1]), 0), "Exact posterior E[log ω₁] from the retained marginal."),
      derivedSignal(numberSignal(record, "site", "posterior-mean-log-ratio-2", "Posterior E[log(dN/dS)] · group 2", siteValues(result.sites, (site) => posteriorMeanLogOmega2?.[site.site - 1]), 0), "Exact posterior E[log ω₂] from the retained marginal."),
      derivedSignal(numberSignal(record, "site", "geometric-mean-rate-ratio-1", "exp(E[log(dN/dS)]) · group 1", siteValues(result.sites, (site) => { const value = posteriorMeanLogOmega1?.[site.site - 1]; return value === undefined ? undefined : Math.exp(value); }), 1), "Posterior geometric mean ω₁."),
      derivedSignal(numberSignal(record, "site", "geometric-mean-rate-ratio-2", "exp(E[log(dN/dS)]) · group 2", siteValues(result.sites, (site) => { const value = posteriorMeanLogOmega2?.[site.site - 1]; return value === undefined ? undefined : Math.exp(value); }), 1), "Posterior geometric mean ω₂."),
      derivedSignal(numberSignal(record, "site", "mean-omega-difference", "Mean ω₂ − mean ω₁", siteValues(result.sites, (site) => site.meanOmega2 - site.meanOmega1), 0), "Difference between the two reported posterior mean ω values."),
      derivedSignal(numberSignal(record, "site", "mean-omega-ratio", "Mean ω₂ / mean ω₁", siteValues(result.sites, (site) => positiveRatio(site.meanOmega2, site.meanOmega1)), 1), "Ratio of the two reported posterior mean ω values."),
    ]);
  }
  if (analysis.modelId === "flavor") {
    const result = analysis.result as FlavorRunResult;
    const threshold = numericParameter(analysis, "posteriorThreshold", 0.9);
    const meanDnParameter = flavorPosteriorMeanDnParameter(result);
    const posterior = result.posterior;
    const posteriorMeanLogOmega = posterior === undefined ? undefined : marginalPosteriorExpectation(posterior.siteCount, posterior.muValues, posterior.mu, Math.log);
    return availableSignals([
      probabilitySignal(record, "site", "positive", "Positive posterior", siteValues(result.sites, (site) => site.pPositive), threshold),
      probabilitySignal(record, "site", "uncapped", "P(uncapped)", siteValues(result.sites, (site) => site.pUncapped), threshold),
      probabilitySignal(record, "site", "positive-branch-fraction", "Mean positive branch fraction", siteValues(result.sites, (site) => site.meanPositiveBranchFraction), 0.5),
      numberSignal(record, "site", "bayes-factor", "Empirical Bayes factor", siteValues(result.sites, (site) => site.bayesFactor), 10),
      numberSignal(record, "site", "mean-alpha", "Posterior mean dS · E[α]", siteValues(result.sites, (site) => site.meanAlpha), 1),
      numberSignal(record, "site", "mean-omega", "Posterior mean Gamma ω mean", siteValues(result.sites, (site) => site.meanOmega), 1),
      numberSignal(record, "site", "mean-shape", "Posterior mean Gamma shape", siteValues(result.sites, (site) => site.meanShape), 1),
      numberSignal(record, "site", "mean-omega-sd", "Posterior mean ω SD", siteValues(result.sites, (site) => site.meanOmegaStandardDeviation), 1),
      derivedSignal(numberSignal(record, "site", "mean-dn-parameter", "Posterior mean dN parameter · E[αμ]", siteValues(result.sites, (site) => meanDnParameter?.[site.site - 1]), 1), "Exact posterior expectation of α times the Gamma mean parameter μ. For capped states, μ is the underlying Gamma mean rather than the mean after capping ω at 1."),
      derivedSignal(numberSignal(record, "site", "log-mean-rate-ratio", "log(E[αμ]) − log(E[α])", siteValues(result.sites, (site) => { const dN = meanDnParameter?.[site.site - 1]; return dN === undefined ? undefined : logRatio(dN, site.meanAlpha); }), 0), "Log ratio of the posterior mean αμ parameter to posterior mean α."),
      derivedSignal(numberSignal(record, "site", "exp-log-mean-rate-ratio", "exp(log(E[αμ]) − log(E[α]))", siteValues(result.sites, (site) => { const dN = meanDnParameter?.[site.site - 1]; return dN === undefined ? undefined : positiveRatio(dN, site.meanAlpha); }), 1), "Ratio E[αμ] / E[α]."),
      derivedSignal(numberSignal(record, "site", "posterior-mean-log-ratio", "Posterior E[log μ]", siteValues(result.sites, (site) => posteriorMeanLogOmega?.[site.site - 1]), 0), "Computed exactly from the retained posterior marginal for the Gamma ω mean parameter μ."),
      derivedSignal(numberSignal(record, "site", "geometric-mean-rate-ratio", "exp(E[log μ])", siteValues(result.sites, (site) => { const value = posteriorMeanLogOmega?.[site.site - 1]; return value === undefined ? undefined : Math.exp(value); }), 1), "Posterior geometric mean of the Gamma ω mean parameter μ."),
    ]);
  }
  if (analysis.modelId === "glamma") {
    const result = analysis.result as GlobalGammaRunResult;
    const threshold = numericParameter(analysis, "posteriorThreshold", 0.9);
    return availableSignals([
      probabilitySignal(record, "site", "maximum-branch-posterior", "Max branch posterior", siteValues(result.sites, (site) => site.maximumBranchPosterior), threshold),
      probabilitySignal(record, "site", "conditional-support", "Conditional support", siteValues(result.sites, (site) => site.conditionalSupport), threshold),
      numberSignal(record, "site", "capped-log-evidence", "Capped log evidence", siteValues(result.sites, (site) => site.cappedLogEvidence), Math.log(10), "log-evidence"),
      numberSignal(record, "site", "capped-evidence-ratio", "Full/null evidence ratio", siteValues(result.sites, (site) => site.cappedEvidenceRatio), 10),
      numberSignal(record, "site", "expected-positive-branches", "Expected positive branches", siteValues(result.sites, (site) => site.expectedPositiveBranches), 1),
      probabilitySignal(record, "branch", "maximum-site-posterior", "Max site posterior", branchValues(result.branches, (branch) => branch.maximumSitePosterior), threshold),
      probabilitySignal(record, "branch", "any-site-posterior", "P(any positive site)", branchValues(result.branches, (branch) => branch.anySitePositivePosterior), threshold),
      probabilitySignal(record, "branch", "activation-posterior-mean", "Posterior mean activation", branchValues(result.branches, (branch) => branch.activationPosteriorMean), 0.5),
      numberSignal(record, "branch", "activation-log-bf", "Activation log BF", branchValues(result.branches, (branch) => branch.activationLogBayesFactor), Math.log(10), "log-evidence"),
      numberSignal(record, "branch", "activation-bf", "Activation empirical BF", branchValues(result.branches, (branch) => branch.activationBayesFactor), 10),
      numberSignal(record, "branch", "capped-log-evidence", "Capped log evidence", branchValues(result.branches, (branch) => branch.cappedLogEvidence), Math.log(10), "log-evidence"),
      numberSignal(record, "branch", "capped-evidence-ratio", "Full/null evidence ratio", branchValues(result.branches, (branch) => branch.cappedEvidenceRatio), 10),
      numberSignal(record, "branch", "expected-positive-sites", "Expected positive sites", branchValues(result.branches, (branch) => branch.expectedPositiveSites), 1),
      numberSignal(record, "branch", "any-site-log-bf", "Any-site log BF", branchValues(result.branches, (branch) => branch.anySitePositiveLogBayesFactor), Math.log(10), "log-evidence"),
      numberSignal(record, "branch", "branch-length", "Branch length", branchValues(result.branches, (branch) => branch.branchLength), 0.1),
    ]);
  }
  if (analysis.modelId === "clade-shift") {
    const result = analysis.result as CladeShiftRunResult;
    const threshold = numericParameter(analysis, "posteriorThreshold", 0.9);
    return availableSignals([
      probabilitySignal(record, "site", "shift", "P(any shift)", siteValues(result.sites, (site) => site.pShift), threshold),
      probabilitySignal(record, "site", "relaxation", "P(relaxation)", siteValues(result.sites, (site) => site.pRelaxation), threshold),
      probabilitySignal(record, "site", "intensification", "P(intensification)", siteValues(result.sites, (site) => site.pIntensification), threshold),
      numberSignal(record, "site", "shift-log-bf", "Shift log BF", siteValues(result.sites, (site) => site.logBayesFactor), Math.log(10), "log-evidence"),
      numberSignal(record, "site", "relaxation-log-bf", "Relaxation log BF", siteValues(result.sites, (site) => site.relaxationLogBayesFactor), Math.log(10), "log-evidence"),
      numberSignal(record, "site", "intensification-log-bf", "Intensification log BF", siteValues(result.sites, (site) => site.intensificationLogBayesFactor), Math.log(10), "log-evidence"),
      probabilitySignal(record, "site", "map-branch-posterior", "MAP branch posterior", siteValues(result.sites, (site) => site.mapBranchPosterior), threshold),
      numberSignal(record, "site", "map-intensity", "MAP intensity K", siteValues(result.sites, (site) => site.mapIntensity), 1),
      numberSignal(record, "site", "mean-intensity", "Mean K given shift", siteValues(result.sites, (site) => site.meanIntensityGivenShift), 1),
      probabilitySignal(record, "site", "captured-null-mass", "Captured null posterior mass", siteValues(result.sites, (site) => site.capturedNullPosteriorMass), 0.9),
      numberSignal(record, "site", "baseline-mean-alpha", "Baseline posterior mean dS · E[α]", siteValues(result.sites, (site) => site.baselineMeanAlpha), 1),
      numberSignal(record, "site", "baseline-mean-beta", "Baseline posterior mean dN · E[β]", siteValues(result.sites, (site) => site.baselineMeanBeta), 1),
      derivedSignal(numberSignal(record, "site", "baseline-log-mean-rate-ratio", "Baseline log(E[dN]) − log(E[dS])", siteValues(result.sites, (site) => logRatio(site.baselineMeanBeta, site.baselineMeanAlpha)), 0), "Log ratio of the reported baseline posterior mean β and α parameters."),
      derivedSignal(numberSignal(record, "site", "baseline-exp-log-mean-rate-ratio", "Baseline exp(log(E[dN]) − log(E[dS]))", siteValues(result.sites, (site) => positiveRatio(site.baselineMeanBeta, site.baselineMeanAlpha)), 1), "Ratio of the reported baseline posterior means E[β] / E[α]."),
      probabilitySignal(record, "branch", "maximum-site-posterior", "Max site posterior", branchValues(result.branches, (branch) => branch.maximumSitePosterior), threshold),
      numberSignal(record, "branch", "expected-shifted-sites", "Expected shifted sites", branchValues(result.branches, (branch) => branch.expectedShiftedSites), 1),
      numberSignal(record, "branch", "expected-relaxed-sites", "Expected relaxed sites", branchValues(result.branches, (branch) => branch.expectedRelaxedSites), 1),
      numberSignal(record, "branch", "expected-intensified-sites", "Expected intensified sites", branchValues(result.branches, (branch) => branch.expectedIntensifiedSites), 1),
      numberSignal(record, "branch", "descendant-tips", "Descendant tips", branchValues(result.branches, (branch) => branch.descendantTips), 2),
    ]);
  }
  if (analysis.modelId === "bsrel") {
    const result = analysis.result as BsrelRunResult;
    const threshold = numericParameter(analysis, "significanceThreshold", 0.05);
    return availableSignals([
      pValueSignal(record, "branch", "holm-p-value", "Holm-adjusted p-value", branchValues(result.branches, (branch) => branch.pValueHolm), threshold),
      pValueSignal(record, "branch", "raw-p-value", "Raw p-value", branchValues(result.branches, (branch) => branch.pValue), 0.05),
      numberSignal(record, "branch", "likelihood-ratio", "Likelihood ratio", branchValues(result.branches, (branch) => branch.likelihoodRatio), 3.84),
      numberSignal(record, "branch", "mean-omega", "Mean ω", branchValues(result.branches, (branch) => branch.meanOmega), 1),
      numberSignal(record, "branch", "omega-minus", "ω−", branchValues(result.branches, (branch) => branch.omegaMinus), 1),
      probabilitySignal(record, "branch", "weight-minus", "Mixture weight q−", branchValues(result.branches, (branch) => branch.weightMinus), 0.5),
      numberSignal(record, "branch", "omega-neutral", "ωN", branchValues(result.branches, (branch) => branch.omegaNeutral), 1),
      probabilitySignal(record, "branch", "weight-neutral", "Mixture weight qN", branchValues(result.branches, (branch) => branch.weightNeutral), 0.5),
      numberSignal(record, "branch", "omega-positive", "ω+", branchValues(result.branches, (branch) => branch.omegaPositive), 1),
      probabilitySignal(record, "branch", "weight-positive", "Mixture weight q+", branchValues(result.branches, (branch) => branch.weightPositive), 0.5),
      numberSignal(record, "branch", "input-length", "Input branch length", branchValues(result.branches, (branch) => branch.inputLength), 0.1),
      numberSignal(record, "branch", "fitted-length", "Fitted branch length", branchValues(result.branches, (branch) => branch.fittedLength), 0.1),
      numberSignal(record, "branch", "null-log-likelihood", "Null log likelihood", branchValues(result.branches, (branch) => branch.nullLogLikelihood), 0),
    ]);
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

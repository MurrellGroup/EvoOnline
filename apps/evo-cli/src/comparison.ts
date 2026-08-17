import type { SimulatedDataset } from "@phylo-workbench/model-simulator";
import type { ParameterValues } from "@phylo-workbench/model-sdk";
import { rowsToCsv } from "./io.js";

export interface ComparisonRecord {
  readonly id: string;
  readonly dataset: string;
  readonly datasetId?: string;
  readonly nodeId?: string;
  readonly sourceId: string;
  readonly sourceNodeId?: string;
  readonly sourceLabel: string;
  readonly methodId: string;
  readonly methodLabel: string;
  readonly parameters: ParameterValues;
  readonly result: unknown;
  readonly simulationDataset?: SimulatedDataset;
}

export interface SignalValue { readonly key: string; readonly label: string; readonly ordinal: number; readonly value: number }
export interface ComparisonSignal {
  readonly id: string;
  readonly dataset: string;
  readonly sourceLabel: string;
  readonly methodId: string;
  readonly methodLabel: string;
  readonly metricId: string;
  readonly metricLabel: string;
  readonly unit: "site" | "branch";
  readonly values: readonly SignalValue[];
  readonly threshold: number;
  readonly direction: "above" | "below";
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function finite(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : typeof value === "boolean" ? Number(value) : undefined; }
function label(value: string): string { return value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replaceAll(/[-_]+/g, " ").replace(/^./, (match) => match.toUpperCase()); }
function logPositive(value: number): number | undefined { return value > 0 ? Math.log(value) : undefined; }
function ratio(numerator: number, denominator: number): number | undefined { return numerator >= 0 && denominator > 0 ? numerator / denominator : undefined; }

function thresholdFor(recordValue: ComparisonRecord, metric: string): { readonly value: number; readonly direction: "above" | "below" } {
  if (/pvalue|p-value|p value/i.test(metric)) return { value: Number(recordValue.parameters.significanceThreshold ?? 0.05), direction: "below" };
  if (/posterior|probability|ppositive|ppurifying|pshift|prelaxation|pintensification/i.test(metric)) return { value: Number(recordValue.parameters.posteriorThreshold ?? 0.9), direction: "above" };
  if (/bayesfactor|bayes factor|evidence ratio/i.test(metric)) return { value: 10, direction: "above" };
  if (/log.*evidence|log.*bf/i.test(metric)) return { value: Math.log(10), direction: "above" };
  if (/omega|rate ratio|dN\/dS/i.test(metric)) return { value: 1, direction: "above" };
  return { value: 0, direction: "above" };
}

function makeSignal(source: ComparisonRecord, unit: "site" | "branch", metricId: string, metricLabel: string, values: readonly SignalValue[]): ComparisonSignal {
  const threshold = thresholdFor(source, metricId);
  return { id: `${source.id}:${unit}:${metricId}`, dataset: source.dataset, sourceLabel: source.sourceLabel, methodId: source.methodId, methodLabel: source.methodLabel, metricId, metricLabel, unit, values, threshold: threshold.value, direction: threshold.direction };
}

function valuesFromRows(rows: readonly unknown[], value: (row: Record<string, unknown>) => number | undefined): readonly SignalValue[] {
  return rows.flatMap((row, index) => {
    if (!record(row)) return [];
    const current = value(row);
    if (current === undefined || !Number.isFinite(current)) return [];
    const ordinal = Number(row.site ?? row.branch ?? index + 1);
    const key = String(row.nodeId ?? row.site ?? row.branch ?? index + 1);
    const itemLabel = String(row.name ?? (row.site === undefined ? `Branch ${ordinal}` : `Codon ${ordinal}`));
    return [{ key, label: itemLabel, ordinal, value: current }];
  });
}

function indexed(values: ArrayLike<number> | undefined, transform: (value: number, index: number) => number | undefined = (value) => value): readonly SignalValue[] {
  if (values === undefined) return [];
  return Array.from({ length: values.length }, (_, index) => {
    const value = transform(values[index]!, index);
    return value === undefined || !Number.isFinite(value) ? undefined : { key: String(index + 1), label: `Codon ${index + 1}`, ordinal: index + 1, value };
  }).filter((value): value is SignalValue => value !== undefined);
}

function arrayLike(value: unknown): ArrayLike<number> | undefined {
  return Array.isArray(value) || (ArrayBuffer.isView(value) && !(value instanceof DataView)) ? value as ArrayLike<number> : undefined;
}

function addGenericRows(source: ComparisonRecord, result: Record<string, unknown>, key: "sites" | "branches", unit: "site" | "branch", output: ComparisonSignal[]): void {
  const rows = Array.isArray(result[key]) ? result[key] : [];
  const metrics = new Set<string>();
  for (const row of rows) if (record(row)) for (const [field, value] of Object.entries(row)) if (finite(value) !== undefined && !["site", "branch", "nodeId"].includes(field)) metrics.add(field);
  for (const metric of metrics) output.push(makeSignal(source, unit, metric, label(metric), valuesFromRows(rows, (row) => finite(row[metric]))));
}

function marginalExpectation(siteCount: number, parameterValues: ArrayLike<number> | undefined, masses: ArrayLike<number> | undefined, transform: (value: number) => number): readonly number[] | undefined {
  if (parameterValues === undefined || masses === undefined || siteCount <= 0 || parameterValues.length === 0 || masses.length !== siteCount * parameterValues.length) return undefined;
  return Array.from({ length: siteCount }, (_, site) => {
    let total = 0;
    for (let index = 0; index < parameterValues.length; index += 1) total += masses[site * parameterValues.length + index]! * transform(parameterValues[index]!);
    return total;
  });
}

function surfaceExpectation(siteCount: number, surfaces: ArrayLike<number> | undefined, categories: ArrayLike<number>): readonly number[] | undefined {
  if (surfaces === undefined || siteCount <= 0 || categories.length === 0 || surfaces.length !== siteCount * categories.length) return undefined;
  return Array.from({ length: siteCount }, (_, site) => {
    let total = 0;
    for (let category = 0; category < categories.length; category += 1) total += surfaces[site * categories.length + category]! * categories[category]!;
    return total;
  });
}

function addDerived(source: ComparisonRecord, result: Record<string, unknown>, output: ComparisonSignal[]): void {
  const rows = Array.isArray(result.sites) ? result.sites : [];
  const derived = (id: string, metricLabel: string, value: (row: Record<string, unknown>, index: number) => number | undefined): void => {
    output.push(makeSignal(source, "site", id, metricLabel, rows.flatMap((row, index) => {
      if (!record(row)) return [];
      const current = value(row, index);
      return current === undefined || !Number.isFinite(current) ? [] : [{ key: String(row.site ?? index + 1), label: `Codon ${row.site ?? index + 1}`, ordinal: Number(row.site ?? index + 1), value: current }];
    })));
  };
  if (source.methodId === "fubar") {
    derived("posterior-mean-ds", "Posterior mean dS", (row) => finite(row.meanAlpha));
    derived("posterior-mean-dn", "Posterior mean dN", (row) => finite(row.meanBeta));
    derived("log-mean-dn-minus-log-mean-ds", "log(E[dN]) - log(E[dS])", (row) => { const a = finite(row.meanAlpha); const b = finite(row.meanBeta); return a === undefined || b === undefined ? undefined : logPositive(ratio(b, a) ?? -1); });
    derived("exp-log-mean-rate-ratio", "exp(log(E[dN]) - log(E[dS]))", (row) => { const a = finite(row.meanAlpha); const b = finite(row.meanBeta); return a === undefined || b === undefined ? undefined : ratio(b, a); });
    const posterior = record(result.posterior) ? result.posterior : undefined;
    const siteCount = Number(posterior?.siteCount ?? 0);
    const grid = arrayLike(posterior?.gridValues);
    const alphaMass = arrayLike(posterior?.alpha);
    const betaMass = arrayLike(posterior?.beta);
    const meanLogAlpha = marginalExpectation(siteCount, grid, alphaMass, Math.log);
    const meanLogBeta = marginalExpectation(siteCount, grid, betaMass, Math.log);
    if (meanLogAlpha !== undefined && meanLogBeta !== undefined) {
      output.push(makeSignal(source, "site", "posterior-mean-log-rate-ratio", "Posterior E[log(dN) - log(dS)]", indexed(meanLogAlpha, (_value, index) => meanLogBeta[index]! - meanLogAlpha[index]!)));
      output.push(makeSignal(source, "site", "posterior-geometric-mean-rate-ratio", "exp(E[log(dN) - log(dS)])", indexed(meanLogAlpha, (_value, index) => Math.exp(meanLogBeta[index]! - meanLogAlpha[index]!))));
    }
  }
  if (source.methodId === "diffubar") {
    derived("posterior-mean-ds", "Posterior mean dS", (row) => finite(row.meanAlpha));
    for (const group of [1, 2] as const) {
      derived(`posterior-mean-dn-proxy-${group}`, `Posterior mean dN${group} proxy`, (row) => { const alpha = finite(row.meanAlpha); const omega = finite(row[`meanOmega${group}`]); return alpha === undefined || omega === undefined ? undefined : alpha * omega; });
      derived(`log-mean-rate-ratio-${group}`, `log(E[dN${group}]) - log(E[dS])`, (row) => { const omega = finite(row[`meanOmega${group}`]); return omega === undefined ? undefined : logPositive(omega); });
      derived(`exp-log-mean-rate-ratio-${group}`, `exp(log(E[dN${group}]) - log(E[dS]))`, (row) => finite(row[`meanOmega${group}`]));
    }
    const posterior = record(result.posteriorMarginals) ? result.posteriorMarginals : undefined;
    const siteCount = Number(posterior?.siteCount ?? 0);
    const omegaValues = arrayLike(posterior?.omegaValues);
    for (const group of [1, 2] as const) {
      const meanLog = marginalExpectation(siteCount, omegaValues, arrayLike(posterior?.[`omega${group}`]), Math.log);
      if (meanLog !== undefined) {
        output.push(makeSignal(source, "site", `posterior-mean-log-rate-ratio-${group}`, `Posterior E[log(dN/dS)] group ${group}`, indexed(meanLog)));
        output.push(makeSignal(source, "site", `geometric-mean-rate-ratio-${group}`, `exp(E[log(dN/dS)]) group ${group}`, indexed(meanLog, Math.exp)));
      }
    }
  }
  if (source.methodId === "fame" || source.methodId === "flavor") {
    derived("posterior-mean-ds", "Posterior mean dS", (row) => finite(row.meanAlpha));
    const posterior = record(result.posterior) ? result.posterior : undefined;
    const siteCount = Number(posterior?.siteCount ?? 0);
    const alphaValues = arrayLike(posterior?.alphaValues);
    const meanLogAlpha = marginalExpectation(siteCount, alphaValues, arrayLike(posterior?.alpha), Math.log);
    if (source.methodId === "fame") {
      const omega1Values = arrayLike(posterior?.omega1Values);
      const omega2Values = arrayLike(posterior?.omega2Values);
      const surfaces = arrayLike(posterior?.surfaces);
      if (alphaValues !== undefined && omega1Values !== undefined && omega2Values !== undefined) {
        const dn1: number[] = [];
        const dn2: number[] = [];
        for (const alpha of Array.from(alphaValues)) for (const omega1 of Array.from(omega1Values)) for (const omega2 of Array.from(omega2Values)) { dn1.push(alpha * omega1); dn2.push(alpha * omega2); }
        const meanDn1 = surfaceExpectation(siteCount, surfaces, dn1);
        const meanDn2 = surfaceExpectation(siteCount, surfaces, dn2);
        if (meanDn1 !== undefined) output.push(makeSignal(source, "site", "posterior-mean-dn-1", "Posterior mean dN1", indexed(meanDn1)));
        if (meanDn2 !== undefined) output.push(makeSignal(source, "site", "posterior-mean-dn-2", "Posterior mean dN2", indexed(meanDn2)));
        if (meanDn1 !== undefined) {
          derived("log-mean-rate-ratio-1", "log(E[dN1]) - log(E[dS])", (row, index) => { const ds = finite(row.meanAlpha); return ds === undefined ? undefined : logPositive(ratio(meanDn1[index]!, ds) ?? -1); });
          derived("exp-log-mean-rate-ratio-1", "exp(log(E[dN1]) - log(E[dS]))", (row, index) => { const ds = finite(row.meanAlpha); return ds === undefined ? undefined : ratio(meanDn1[index]!, ds); });
        }
        if (meanDn2 !== undefined) {
          derived("log-mean-rate-ratio-2", "log(E[dN2]) - log(E[dS])", (row, index) => { const ds = finite(row.meanAlpha); return ds === undefined ? undefined : logPositive(ratio(meanDn2[index]!, ds) ?? -1); });
          derived("exp-log-mean-rate-ratio-2", "exp(log(E[dN2]) - log(E[dS]))", (row, index) => { const ds = finite(row.meanAlpha); return ds === undefined ? undefined : ratio(meanDn2[index]!, ds); });
        }
      }
      for (const group of [1, 2] as const) {
        const meanLogOmega = marginalExpectation(siteCount, group === 1 ? omega1Values : omega2Values, arrayLike(posterior?.[`omega${group}`]), Math.log);
        if (meanLogOmega !== undefined) output.push(makeSignal(source, "site", `posterior-mean-log-rate-ratio-${group}`, `Posterior E[log(dN/dS)] group ${group}`, indexed(meanLogOmega)));
      }
    } else {
      const muValues = arrayLike(posterior?.muValues);
      const meanLogMu = marginalExpectation(siteCount, muValues, arrayLike(posterior?.mu), Math.log);
      if (meanLogMu !== undefined) {
        output.push(makeSignal(source, "site", "posterior-mean-log-rate-ratio", "Posterior E[log Gamma mean omega]", indexed(meanLogMu)));
        output.push(makeSignal(source, "site", "geometric-mean-rate-ratio", "exp(E[log Gamma mean omega])", indexed(meanLogMu, Math.exp)));
      }
      const shapeValues = arrayLike(posterior?.shapeValues);
      const surfaces = arrayLike(posterior?.surfaces);
      if (alphaValues !== undefined && muValues !== undefined && shapeValues !== undefined) {
        const dnCategories: number[] = [];
        for (let cap = 0; cap < 2; cap += 1) for (const mu of Array.from(muValues)) for (const _shape of Array.from(shapeValues)) for (const alpha of Array.from(alphaValues)) dnCategories.push(alpha * mu);
        const meanDn = surfaceExpectation(siteCount, surfaces, dnCategories);
        if (meanDn !== undefined) {
          output.push(makeSignal(source, "site", "posterior-mean-dn", "Posterior mean dN", indexed(meanDn)));
          derived("log-mean-rate-ratio", "log(E[dN]) - log(E[dS])", (row, index) => { const ds = finite(row.meanAlpha); return ds === undefined ? undefined : logPositive(ratio(meanDn[index]!, ds) ?? -1); });
          derived("exp-log-mean-rate-ratio", "exp(log(E[dN]) - log(E[dS]))", (row, index) => { const ds = finite(row.meanAlpha); return ds === undefined ? undefined : ratio(meanDn[index]!, ds); });
        }
      }
    }
    if (meanLogAlpha !== undefined) output.push(makeSignal(source, "site", "posterior-mean-log-ds", "Posterior E[log dS]", indexed(meanLogAlpha)));
  }
  if (source.methodId === "clade-shift") {
    derived("baseline-posterior-mean-ds", "Baseline posterior mean dS", (row) => finite(row.baselineMeanAlpha));
    derived("baseline-posterior-mean-dn", "Baseline posterior mean dN", (row) => finite(row.baselineMeanBeta));
    derived("baseline-log-mean-rate-ratio", "Baseline log(E[dN]) - log(E[dS])", (row) => { const alpha = finite(row.baselineMeanAlpha); const beta = finite(row.baselineMeanBeta); return alpha === undefined || beta === undefined ? undefined : logPositive(ratio(beta, alpha) ?? -1); });
    derived("baseline-exp-log-mean-rate-ratio", "Baseline exp(log(E[dN]) - log(E[dS]))", (row) => { const alpha = finite(row.baselineMeanAlpha); const beta = finite(row.baselineMeanBeta); return alpha === undefined || beta === undefined ? undefined : ratio(beta, alpha); });
  }
}

function simulatorSignals(source: ComparisonRecord, dataset: SimulatedDataset): readonly ComparisonSignal[] {
  const parameters = dataset.siteParameters;
  if (parameters === undefined) return [];
  const output: ComparisonSignal[] = [];
  const add = (id: string, metricLabel: string, values: ArrayLike<number> | undefined, transform?: (value: number, index: number) => number | undefined): void => {
    if (values !== undefined) output.push(makeSignal(source, "site", id, metricLabel, indexed(values, transform)));
  };
  const omega = parameters.omega ?? parameters.scuffMaximumExpectedDnds;
  const dn = omega === undefined ? undefined : Array.from({ length: Math.min(parameters.alpha.length, omega.length) }, (_, index) => parameters.alpha[index]! * omega[index]!);
  add("true-ds", "True dS", parameters.alpha);
  add("true-dn", "True dN", dn);
  add("true-omega", "True dN/dS", omega);
  add("true-log-ds", "True log(dS)", parameters.alpha, logPositive);
  add("true-log-dn", "True log(dN)", dn, logPositive);
  add("true-log-rate-ratio", "True log(dN) - log(dS)", omega, logPositive);
  add("true-exp-log-rate-ratio", "True exp(log(dN) - log(dS))", omega);
  add("true-event-rate", "True SCUFF event rate", parameters.eventRate);
  add("true-equilibrium-sigma", "True SCUFF equilibrium sigma", parameters.equilibriumSigma);
  add("true-mixing-rate", "True SCUFF mixing rate", parameters.mixingRate);
  add("true-hotspot-weight", "True recombination hotspot weight", dataset.hotspotWeights);
  const breaks = new Array(parameters.alpha.length).fill(0);
  for (const event of dataset.recombinationEvents) for (const breakpoint of event.breakpoints) if (breakpoint >= 1 && breakpoint <= breaks.length) breaks[breakpoint - 1] += 1;
  add("true-breakpoint-count", "True breakpoint-event count", breaks);
  return output;
}

export function extractSignals(source: ComparisonRecord): readonly ComparisonSignal[] {
  if (source.simulationDataset !== undefined) return simulatorSignals(source, source.simulationDataset);
  if (!record(source.result)) return [];
  const output: ComparisonSignal[] = [];
  addGenericRows(source, source.result, "sites", "site", output);
  addGenericRows(source, source.result, "branches", "branch", output);
  if (record(source.result.approximateFel) && Array.isArray(source.result.approximateFel.sites)) {
    const wrapped: ComparisonRecord = { ...source, id: `${source.id}:approximate-fel`, methodLabel: `${source.methodLabel} approximate FEL` };
    addGenericRows(wrapped, { sites: source.result.approximateFel.sites }, "sites", "site", output);
  }
  addDerived(source, source.result, output);
  return output.filter((signal) => signal.values.length > 0);
}

export function megaTableCsv(signals: readonly ComparisonSignal[], unit: "site" | "branch"): string {
  const relevant = signals.filter((signal) => signal.unit === unit);
  const rows = new Map<string, { dataset: string; key: string; label: string; ordinal: number; values: Map<string, number> }>();
  for (const signal of relevant) for (const value of signal.values) {
    const key = `${signal.dataset}\0${value.key}`;
    const row = rows.get(key) ?? { dataset: signal.dataset, key: value.key, label: value.label, ordinal: value.ordinal, values: new Map() };
    row.values.set(signal.id, value.value);
    rows.set(key, row);
  }
  const headers = ["dataset", unit === "site" ? "site" : "branch key", "label", ...relevant.map((signal) => `${signal.methodLabel} via ${signal.sourceLabel} | ${signal.metricLabel}`)];
  const ordered = [...rows.values()].sort((a, b) => a.dataset.localeCompare(b.dataset) || a.ordinal - b.ordinal || a.label.localeCompare(b.label));
  return rowsToCsv(headers, ordered.map((row) => [row.dataset, row.key, row.label, ...relevant.map((signal) => row.values.get(signal.id) ?? "")]));
}

export function defaultPlotSignals(signals: readonly ComparisonSignal[]): readonly ComparisonSignal[] {
  const preference: Readonly<Record<string, readonly string[]>> = {
    simulator: ["true-omega", "true-breakpoint-count"],
    fubar: ["pPositive", "pPurifying", "exp-log-mean-rate-ratio"],
    diffubar: ["pOmega1Greater", "pOmega2Greater"],
    fame: ["pPositive"],
    flavor: ["pPositive"],
    glamma: ["maximumBranchPosterior", "conditionalSupport"],
    "clade-shift": ["pShift"],
  };
  const byRecord = new Map<string, ComparisonSignal[]>();
  for (const signal of signals.filter((value) => value.unit === "site")) byRecord.set(signal.id.split(":site:")[0]!, [...(byRecord.get(signal.id.split(":site:")[0]!) ?? []), signal]);
  return [...byRecord.values()].flatMap((candidates) => {
    const wanted = preference[candidates[0]!.methodId] ?? [];
    return wanted.map((id) => candidates.find((candidate) => candidate.metricId === id)).find((value) => value !== undefined) ?? candidates[0] ?? [];
  });
}

export function pairedValues(left: ComparisonSignal, right: ComparisonSignal): readonly (readonly [number, number])[] {
  const rightValues = new Map(right.values.map((value) => [value.key, value.value]));
  return left.values.flatMap((value) => rightValues.has(value.key) ? [[value.value, rightValues.get(value.key)!] as const] : []);
}

export function pearson(pairs: readonly (readonly [number, number])[]): number | null {
  if (pairs.length < 2) return null;
  const meanX = pairs.reduce((sum, value) => sum + value[0], 0) / pairs.length;
  const meanY = pairs.reduce((sum, value) => sum + value[1], 0) / pairs.length;
  let covariance = 0; let varianceX = 0; let varianceY = 0;
  for (const [x, y] of pairs) { covariance += (x - meanX) * (y - meanY); varianceX += (x - meanX) ** 2; varianceY += (y - meanY) ** 2; }
  const denominator = Math.sqrt(varianceX * varianceY);
  return denominator === 0 ? null : covariance / denominator;
}

function called(signal: ComparisonSignal, value: number): boolean { return signal.direction === "below" ? value <= signal.threshold : value >= signal.threshold; }

export function agreement(left: ComparisonSignal, right: ComparisonSignal): number | null {
  const pairs = pairedValues(left, right);
  let both = 0; let either = 0;
  for (const [a, b] of pairs) { const ca = called(left, a); const cb = called(right, b); if (ca && cb) both += 1; if (ca || cb) either += 1; }
  return either === 0 ? (pairs.length > 0 ? 1 : null) : both / either;
}

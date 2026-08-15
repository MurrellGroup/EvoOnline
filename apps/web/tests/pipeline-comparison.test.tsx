import assert from "node:assert/strict";
import test from "node:test";
import type { SavedAnalysis } from "../src/lib/analysis-store.js";
import {
  aggregateComparisonSignals,
  binaryAgreement,
  comparisonSignalCall,
  extractComparisonSignals,
  groupPipelineComparisons,
  pairedComparisonValues,
  pearsonCorrelation,
  spearmanCorrelation,
  type PipelineComparisonRecord,
} from "../src/lib/pipeline-comparison.js";

function analysis(id: string, modelId: string, result: unknown, parameters: SavedAnalysis["parameters"]): SavedAnalysis {
  return { id, modelId, title: id, createdAt: 1, parameters, result };
}

function record(value: SavedAnalysis, sourceNodeId = "source-a"): PipelineComparisonRecord {
  return {
    analysis: value,
    datasetName: "sample.fasta",
    sourceNodeId,
    sourceLabel: sourceNodeId === "source-a" ? "FSART" : "JEMSPR",
    methodNodeId: `node-${value.id}`,
    methodLabel: value.modelId.toUpperCase(),
  };
}

test("site signals from different methods aggregate by codon", () => {
  const fubar = record(analysis("fubar-a", "fubar", {
    sites: [
      { site: 1, pPositive: 0.1, pPurifying: 0.8 },
      { site: 2, pPositive: 0.5, pPurifying: 0.4 },
      { site: 3, pPositive: 0.9, pPurifying: 0.1 },
    ],
  }, { posteriorThreshold: 0.5 }));
  const flavor = record(analysis("flavor-a", "flavor", {
    sites: [
      { site: 1, pPositive: 0.2, pUncapped: 0.3, meanPositiveBranchFraction: 0.1, bayesFactor: 1 },
      { site: 2, pPositive: 0.6, pUncapped: 0.7, meanPositiveBranchFraction: 0.5, bayesFactor: 10 },
      { site: 3, pPositive: 1, pUncapped: 0.9, meanPositiveBranchFraction: 0.8, bayesFactor: 100 },
    ],
  }, { posteriorThreshold: 0.6 }));
  const fubarSignal = extractComparisonSignals(fubar)[0]!;
  const flavorSignal = extractComparisonSignals(flavor)[0]!;
  const rows = aggregateComparisonSignals([fubarSignal, flavorSignal]);
  assert.equal(rows.length, 3);
  assert.equal(rows[1]?.values[fubarSignal.id], 0.5);
  assert.equal(rows[1]?.values[flavorSignal.id], 0.6);
  const pairs = pairedComparisonValues(fubarSignal, flavorSignal);
  assert.ok(Math.abs((pearsonCorrelation(pairs) ?? 0) - 1) < 1e-12);
  assert.equal(spearmanCorrelation(pairs), 1);
  assert.equal(binaryAgreement(fubarSignal, flavorSignal, 0.5, 0.6, "jaccard").value, 1);
});

test("BS-REL uses its native lower-is-stronger Holm threshold", () => {
  const bsrel = record(analysis("bsrel-a", "bsrel", {
    branches: [
      { branch: 1, nodeId: 11, name: "A", pValueHolm: 0.01, pValue: 0.005, likelihoodRatio: 8, meanOmega: 2 },
      { branch: 2, nodeId: 12, name: "B", pValueHolm: 0.2, pValue: 0.1, likelihoodRatio: 1, meanOmega: 0.8 },
    ],
  }, { significanceThreshold: 0.05 }));
  const signal = extractComparisonSignals(bsrel)[0]!;
  assert.equal(signal.thresholdDirection, "below");
  assert.equal(comparisonSignalCall(signal, 0.01, signal.defaultThreshold), true);
  assert.equal(comparisonSignalCall(signal, 0.2, signal.defaultThreshold), false);
});

test("comparison groups provide an all-route site scope plus source-specific scopes", () => {
  const result = { sites: [{ site: 1, pPositive: 0.8, pPurifying: 0.1 }] };
  const records = [
    record(analysis("first", "fubar", result, { posteriorThreshold: 0.95 }), "source-a"),
    record(analysis("second", "fubar", result, { posteriorThreshold: 0.95 }), "source-b"),
  ];
  const groups = groupPipelineComparisons(records);
  assert.equal(groups.length, 3);
  assert.equal(groups[0]?.allSources, true);
  assert.deepEqual(groups.slice(1).map((group) => group.sourceLabel), ["FSART", "JEMSPR"]);
  assert.ok(groups.slice(1).every((group) => group.records.every((entry) => entry.sourceNodeId === group.sourceNodeId)));
});

test("Spearman correlation uses average ranks for tied values", () => {
  const pairs = [[1, 4], [1, 4], [2, 3], [3, 2]] as const;
  assert.ok((spearmanCorrelation(pairs) ?? 0) < -0.9);
});

test("FUBAR exposes posterior mean rates, log transforms, and the posterior geometric rate ratio", () => {
  const fubar = record(analysis("fubar-rates", "fubar", {
    sites: [{ site: 1, pPositive: 0.9, pPurifying: 0.05, meanAlpha: 2, meanBeta: 4 }],
    posterior: {
      siteCount: 1,
      gridSize: 2,
      gridValues: new Float64Array([1, 4]),
      surfaces: new Float32Array(4),
      alpha: new Float32Array([0.5, 0.5]),
      beta: new Float32Array([0.25, 0.75]),
    },
  }, { posteriorThreshold: 0.95 }));
  const signals = extractComparisonSignals(fubar);
  const value = (metricId: string): number => signals.find((signal) => signal.metricId === metricId)?.values[0]?.value ?? Number.NaN;
  assert.equal(value("mean-alpha"), 2);
  assert.equal(value("mean-beta"), 4);
  assert.ok(Math.abs(value("log-mean-rate-ratio") - Math.log(2)) < 1e-12);
  assert.equal(value("exp-log-mean-rate-ratio"), 2);
  assert.ok(Math.abs(value("posterior-mean-log-ratio") - Math.log(2) / 2) < 1e-7);
  assert.ok(Math.abs(value("geometric-mean-rate-ratio") - Math.sqrt(2)) < 1e-7);
});

test("FAME computes exact posterior mean dN values from its retained joint surface", () => {
  const fame = record(analysis("fame-rates", "fame", {
    sites: [{ site: 1, pPositive: 0.8, bayesFactor: 12, meanAlpha: 1.7, meanOmega1: 0.5, meanOmega2: 1.6 }],
    posterior: {
      siteCount: 1,
      alphaValues: new Float64Array([1, 2]),
      omega1Values: new Float64Array([0.5]),
      omega2Values: new Float64Array([1, 2]),
      surfaces: new Float32Array([0.1, 0.2, 0.3, 0.4]),
      alpha: new Float32Array([0.3, 0.7]),
      omega1: new Float32Array([1]),
      omega2: new Float32Array([0.4, 0.6]),
    },
  }, { posteriorThreshold: 0.9 }));
  const signals = extractComparisonSignals(fame);
  const value = (metricId: string): number => signals.find((signal) => signal.metricId === metricId)?.values[0]?.value ?? Number.NaN;
  assert.ok(Math.abs(value("mean-dn-1") - 0.85) < 1e-7);
  assert.ok(Math.abs(value("mean-dn-2") - 2.7) < 1e-7);
  assert.ok(Math.abs(value("exp-log-mean-rate-ratio-2") - 2.7 / 1.7) < 1e-7);
  assert.ok(Math.abs(value("posterior-mean-log-ratio-2") - 0.6 * Math.log(2)) < 1e-7);
  assert.equal(signals.find((signal) => signal.metricId === "mean-dn-2")?.provenance, "derived");
});

test("FLAVOR exposes its reported quantities and posterior alpha-times-mu expectation", () => {
  const flavor = record(analysis("flavor-rates", "flavor", {
    sites: [{ site: 1, pPositive: 0.7, pUncapped: 0.6, bayesFactor: 8, meanAlpha: 1.5, meanOmega: 1.25, meanShape: 1, meanOmegaStandardDeviation: 1.25, meanPositiveBranchFraction: 0.4 }],
    posterior: {
      siteCount: 1,
      muValues: new Float64Array([0.5, 2]),
      shapeValues: new Float64Array([1]),
      alphaValues: new Float64Array([1, 2]),
      surfaces: new Float32Array(8).fill(0.125),
      mu: new Float32Array([0.5, 0.5]),
      shape: new Float32Array([1]),
      alpha: new Float32Array([0.5, 0.5]),
      capState: new Float32Array([0.5, 0.5]),
    },
  }, { posteriorThreshold: 0.9 }));
  const signals = extractComparisonSignals(flavor);
  const value = (metricId: string): number => signals.find((signal) => signal.metricId === metricId)?.values[0]?.value ?? Number.NaN;
  assert.ok(Math.abs(value("mean-dn-parameter") - 1.875) < 1e-7);
  assert.ok(Math.abs(value("exp-log-mean-rate-ratio") - 1.25) < 1e-7);
  assert.ok(Math.abs(value("posterior-mean-log-ratio")) < 1e-7);
  assert.equal(value("mean-omega-sd"), 1.25);
});

test("DifFUBAR labels marginal-mean dN proxies without claiming a joint expectation", () => {
  const diffubar = record(analysis("diffubar-rates", "diffubar", {
    sites: [{ site: 1, pOmega1Greater: 0.2, pOmega2Greater: 0.8, pOmega1Positive: 0.1, pOmega2Positive: 0.9, meanAlpha: 2, meanOmega1: 0.5, meanOmega2: 3 }],
  }, { posteriorThreshold: 0.95 }));
  const signal = extractComparisonSignals(diffubar).find((candidate) => candidate.metricId === "mean-dn-proxy-2");
  assert.equal(signal?.values[0]?.value, 6);
  assert.equal(signal?.provenance, "derived");
  assert.match(signal?.description ?? "", /not E\[αω₂\]/u);
});

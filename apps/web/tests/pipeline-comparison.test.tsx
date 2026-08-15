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

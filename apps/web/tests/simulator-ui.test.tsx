import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_SIMULATOR_CONFIG, encodeSimulatorConfig, runSimulator } from "@phylo-workbench/model-simulator/browser-source";
import { SimulatorSetup } from "../src/components/simulator/SimulatorSetup.js";
import { SimulatorResultsView } from "../src/components/simulator/SimulatorResultsView.js";
import { ScuffDiagnostics } from "../src/components/simulator/ScuffDiagnostics.js";
import { createStoredZip } from "../src/lib/file-download.js";
import { buildSimulationComparisonRows, comparisonConfusionMatrix } from "../src/lib/simulation-comparison.js";
import type { SavedAnalysis } from "../src/lib/analysis-store.js";

test("simulator setup exposes editable demography, non-uniform codon, SCUFF and recombination controls", () => {
  const html = renderToStaticMarkup(<SimulatorSetup parameters={{ simulatorConfig: encodeSimulatorConfig(DEFAULT_SIMULATOR_CONFIG) }} onChange={() => undefined} />);
  assert.match(html, /Effective population size/);
  assert.match(html, /Sampling intensity/);
  assert.match(html, /Empirical influenza GTR/);
  assert.match(html, /SCUFF/);
  assert.match(html, /Events occur inside branches/);
  assert.match(html, /Carrier-tree oversampling/);
});

test("SCUFF parameter diagnostics expose the paper-style dN/dS trajectory and SVG exports", () => {
  const html = renderToStaticMarkup(<ScuffDiagnostics diagnostic={{
    times: [0, 1],
    fitness: Array.from({ length: 40 }, (_, index) => Math.sin(index)),
    codonFrequencies: [1, 1],
    codons: ["AAA"],
    aminoAcids: ["K"],
    dnds: [0.7, 4.2],
    maximumExpectedDnds: 3.1,
    sampledMeanDnds: 2.45,
  }} config={{
    engine: "scuff", sites: 10, geneticCodeId: 1, gtr: DEFAULT_SIMULATOR_CONFIG.codon.gtr,
    alpha: { kind: "fixed", mean: 1 }, eventRate: { kind: "fixed", mean: 4 }, equilibriumSigma: { kind: "fixed", mean: 3.5 }, mixingRate: { kind: "fixed", mean: 1 }, burninTime: 1, diagnosticTime: 1,
  }} />);
  assert.match(html, /paper Figures 3–4/);
  assert.match(html, /Instantaneous expected dN\/dS/);
  assert.match(html, /Ω\(σ\)/);
  assert.ok((html.match(/>SVG</g) ?? []).length >= 3);
});

test("simulator result renderer includes export, truth, tree-alignment, and batch handoff layers", async () => {
  const result = await runSimulator({ ...DEFAULT_SIMULATOR_CONFIG, tree: { ...DEFAULT_SIMULATOR_CONFIG.tree, observedTips: 6, initialTips: 6, replicates: 1 }, codon: { ...DEFAULT_SIMULATOR_CONFIG.codon, sites: 12 } });
  const html = renderToStaticMarkup(<SimulatorResultsView result={result} />);
  assert.match(html, /Download all/);
  assert.match(html, /Reusable tree \+ alignment viewer/);
  assert.match(html, /Realized site parameters/);
  assert.match(html, /Batch into a codon selection method/);
  assert.match(html, /Load into EvoOnline workspace/);
  assert.match(html, /Inference against simulation truth/);
  assert.match(html, /No linked inference results yet/);
});

test("simulator truth studio links persisted site inference, flexible quantities, confusion accuracy, and SVG", async () => {
  const result = await runSimulator({
    ...DEFAULT_SIMULATOR_CONFIG,
    tree: { ...DEFAULT_SIMULATOR_CONFIG.tree, observedTips: 6, initialTips: 6, replicates: 1 },
    codon: { ...DEFAULT_SIMULATOR_CONFIG.codon, sites: 8, omega: { kind: "fixed", mean: 1.8 } },
  });
  const dataset = result.datasets[0]!;
  const analysis: SavedAnalysis = {
    id: "inference-1",
    modelId: "fubar",
    title: "FUBAR simulation 1",
    createdAt: 1,
    parameters: {},
    result: {
      sites: Array.from({ length: 8 }, (_, index) => ({ site: index + 1, meanAlpha: 1, meanBeta: 1.7 + index / 50, pPositive: 0.98, pPurifying: 0.01, selection: "positive" })),
    },
    simulationSource: { simulationAnalysisId: "simulation-1", datasetId: dataset.id, datasetIndex: 0 },
  };
  const rows = buildSimulationComparisonRows(result, [analysis]);
  assert.equal(rows.length, 8);
  const matrix = comparisonConfusionMatrix(rows, "positive", "detectedPositive", 0.5, 0.5, "at-least", "at-least");
  assert.deepEqual([matrix.truePositive, matrix.falsePositive, matrix.falseNegative, matrix.trueNegative], [8, 0, 0, 0]);
  const html = renderToStaticMarkup(<SimulatorResultsView result={result} inferenceAnalyses={[analysis]} />);
  assert.match(html, /Truth vs inference/);
  assert.match(html, /All simulated datasets/);
  assert.match(html, /Confusion matrix/);
  assert.match(html, /FUBAR posterior-mean β\/α/);
  assert.match(html, /Export SVG/);
});

test("dependency-free export writer emits a valid stored ZIP envelope", async () => {
  const bytes = new Uint8Array(await createStoredZip([{ name: "a.txt", data: "alpha" }, { name: "b.txt", data: "beta" }]).arrayBuffer());
  assert.deepEqual(Array.from(bytes.slice(0, 4)), [0x50, 0x4b, 0x03, 0x04]);
  assert.deepEqual(Array.from(bytes.slice(-22, -18)), [0x50, 0x4b, 0x05, 0x06]);
});

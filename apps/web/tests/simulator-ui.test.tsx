import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_SIMULATOR_CONFIG, encodeSimulatorConfig, runSimulator } from "@phylo-workbench/model-simulator/browser-source";
import { SimulatorSetup } from "../src/components/simulator/SimulatorSetup.js";
import { SimulatorResultsView } from "../src/components/simulator/SimulatorResultsView.js";
import { createStoredZip } from "../src/lib/file-download.js";

test("simulator setup exposes editable demography, non-uniform codon, SCUFF and recombination controls", () => {
  const html = renderToStaticMarkup(<SimulatorSetup parameters={{ simulatorConfig: encodeSimulatorConfig(DEFAULT_SIMULATOR_CONFIG) }} onChange={() => undefined} />);
  assert.match(html, /Effective population size/);
  assert.match(html, /Sampling intensity/);
  assert.match(html, /Empirical influenza GTR/);
  assert.match(html, /SCUFF/);
  assert.match(html, /Events occur inside branches/);
  assert.match(html, /Carrier-tree oversampling/);
});

test("simulator result renderer includes export, truth, tree-alignment, and batch handoff layers", async () => {
  const result = await runSimulator({ ...DEFAULT_SIMULATOR_CONFIG, tree: { ...DEFAULT_SIMULATOR_CONFIG.tree, observedTips: 6, initialTips: 6, replicates: 1 }, codon: { ...DEFAULT_SIMULATOR_CONFIG.codon, sites: 12 } });
  const html = renderToStaticMarkup(<SimulatorResultsView result={result} />);
  assert.match(html, /Download all/);
  assert.match(html, /Reusable tree \+ alignment viewer/);
  assert.match(html, /Realized site parameters/);
  assert.match(html, /Batch into a codon selection method/);
  assert.match(html, /Load into EvoOnline workspace/);
});

test("dependency-free export writer emits a valid stored ZIP envelope", async () => {
  const bytes = new Uint8Array(await createStoredZip([{ name: "a.txt", data: "alpha" }, { name: "b.txt", data: "beta" }]).arrayBuffer());
  assert.deepEqual(Array.from(bytes.slice(0, 4)), [0x50, 0x4b, 0x03, 0x04]);
  assert.deepEqual(Array.from(bytes.slice(-22, -18)), [0x50, 0x4b, 0x05, 0x06]);
});

import assert from "node:assert/strict";
import test from "node:test";
import { simulateCoalescentTree } from "../src/coalescent.js";
import { FLU_DEMO_GTR, simulateCodonAlignment } from "../src/codon.js";
import { createCurveEvaluator } from "../src/curves.js";
import { runSimulator } from "../src/pipeline.js";
import { simulateRecombination } from "../src/recombination.js";
import { Random } from "../src/random.js";
import type { RecombinationConfig, TreeSimulationConfig } from "../src/types.js";

const constantTree: TreeSimulationConfig = {
  preset: "constant",
  observedTips: 12,
  initialTips: 12,
  replicates: 1,
  ploidy: 1,
  horizon: 20,
  branchScale: 0.01,
  population: { space: "log", points: [{ time: 0, value: 50 }, { time: 20, value: 50 }] },
  sampling: { space: "linear", points: [{ time: 0, value: 0 }, { time: 20, value: 0 }] },
  hazardBins: 1024,
};

test("editable PCHIP curves interpolate every control exactly without monotone overshoot", () => {
  const curve = { space: "log" as const, points: [{ time: 0, value: 100 }, { time: 2, value: 30 }, { time: 7, value: 4 }, { time: 10, value: 2 }] };
  const evaluate = createCurveEvaluator(curve);
  for (const point of curve.points) assert.ok(Math.abs(evaluate(point.time) - point.value) < 1e-11);
  let previous = evaluate(0);
  for (let index = 1; index <= 1000; index += 1) { const value = evaluate(index / 100); assert.ok(value <= previous + 1e-12 && value >= 2 - 1e-12); previous = value; }
});

test("constant-Ne coalescent has the analytic Kingman mean MRCA time", () => {
  const replicates = 2500;
  let mean = 0;
  for (let index = 0; index < replicates; index += 1) mean += simulateCoalescentTree(constantTree, new Random(index + 1)).height / replicates;
  const expected = 2 * 50 * (1 - 1 / constantTree.observedTips);
  assert.ok(Math.abs(mean - expected) / expected < 0.035, `mean ${mean}, expected ${expected}`);
});

test("diploid-individual Ne doubles the haploid genealogy time scale", () => {
  const replicates = 1500;
  let haploid = 0;
  let diploid = 0;
  for (let index = 0; index < replicates; index += 1) {
    haploid += simulateCoalescentTree(constantTree, new Random(index + 19)).height;
    diploid += simulateCoalescentTree({ ...constantTree, ploidy: 2 }, new Random(index + 19)).height;
  }
  assert.ok(Math.abs(diploid / haploid - 2) < 1e-10);
});

test("branch-interior recombination composes events without losing taxa or time validity", () => {
  const carrier = simulateCoalescentTree({ ...constantTree, observedTips: 30, initialTips: 30 }, new Random(8), 30);
  const config: RecombinationConfig = {
    enabled: true, eventRate: 0.01, mode: "template-switching", meanBreakpoints: 6, meanTractCodons: 30,
    hotspotMode: "random", hotspotCount: 3, hotspotWidth: 6, hotspotIntensity: 10, manualHotspots: [], carrierOversample: 1,
  };
  const names = new Set(carrier.tips.map((tip) => carrier.nodes[tip]!.name!));
  const result = simulateRecombination(carrier, names, 240, config, new Random(91));
  assert.ok(result.events.length >= 2, "fixture should exercise event composition");
  assert.equal(result.localTrees[0]!.startCodon, 1);
  assert.equal(result.localTrees.at(-1)!.endCodon, 240);
  for (const local of result.localTrees) {
    assert.equal(local.tree.tips.length, 30);
    assert.equal(new Set(local.tree.tips.map((tip) => local.tree.nodes[tip]!.name)).size, 30);
    for (const node of local.tree.nodes) if (node.parent !== null) assert.ok(local.tree.nodes[node.parent]!.time > node.time);
  }
});

test("non-uniform MG94 simulator is deterministic and produces measurable diversity", () => {
  const tree = simulateCoalescentTree({ ...constantTree, observedTips: 16, initialTips: 16, branchScale: 0.025 }, new Random(3), 16);
  const local = [{ startCodon: 1, endCodon: 120, tree, activeEventIds: [] }];
  const config = { engine: "mg94" as const, sites: 120, geneticCodeId: 1 as const, gtr: FLU_DEMO_GTR, alpha: { kind: "gamma" as const, mean: 1, shape: 2 }, omega: { kind: "fixed" as const, mean: 0.7 } };
  const first = simulateCodonAlignment(local, config, new Random(77));
  const second = simulateCodonAlignment(local, config, new Random(77));
  assert.deepEqual(first.sequences, second.sequences);
  assert.ok(new Set(first.sequences).size > 1);
});

test("SCUFF simulation retains the per-site independent-redraw expected dN/dS truth", () => {
  const tree = simulateCoalescentTree({ ...constantTree, observedTips: 6, initialTips: 6, branchScale: 0.01 }, new Random(4), 6);
  const config = {
    engine: "scuff" as const,
    sites: 7,
    geneticCodeId: 1 as const,
    gtr: FLU_DEMO_GTR,
    alpha: { kind: "fixed" as const, mean: 1 },
    eventRate: { kind: "fixed" as const, mean: 4 },
    equilibriumSigma: { kind: "gamma" as const, mean: 3.5, shape: 5 },
    mixingRate: { kind: "fixed" as const, mean: 1 },
    burninTime: 0.2,
    diagnosticTime: 0.5,
  };
  const alignment = simulateCodonAlignment([{ startCodon: 1, endCodon: 7, tree, activeEventIds: [] }], config, new Random(88));
  const sigma = alignment.siteParameters.equilibriumSigma!;
  const expected = alignment.siteParameters.scuffMaximumExpectedDnds!;
  assert.equal(expected.length, config.sites);
  expected.forEach((value, index) => assert.ok(Math.abs(value - Math.sqrt(sigma[index]! ** 2 + Math.PI) / Math.sqrt(Math.PI)) < 1e-12));
});

test("full pipeline retains hidden carrier lineages and emits reproducible truth", async () => {
  const result = await runSimulator({
    seed: 42,
    simulateAlignment: true,
    tree: { ...constantTree, observedTips: 10, initialTips: 10, replicates: 2, branchScale: 0.02 },
    codon: { engine: "mg94", sites: 45, geneticCodeId: 1, gtr: FLU_DEMO_GTR, alpha: { kind: "fixed", mean: 1 }, omega: { kind: "fixed", mean: 0.7 } },
    recombination: { enabled: true, eventRate: 0.006, mode: "single-tract", meanBreakpoints: 2, meanTractCodons: 12, hotspotMode: "none", hotspotCount: 0, hotspotWidth: 5, hotspotIntensity: 0, manualHotspots: [], carrierOversample: 2 },
  });
  assert.equal(result.datasets.length, 2);
  for (const dataset of result.datasets) {
    assert.equal(dataset.names.length, 10);
    assert.equal(dataset.sequences?.[0]?.length, 135);
    assert.equal(dataset.carrierTree?.tips.length, 20);
    assert.equal(dataset.localTrees[0]?.startCodon, 1);
    assert.equal(dataset.localTrees.at(-1)?.endCodon, 45);
  }
});

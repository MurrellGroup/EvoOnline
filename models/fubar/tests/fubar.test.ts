import assert from "node:assert/strict";
import test from "node:test";
import { createAlignmentArtifact, createTreeArtifact } from "@phylo-workbench/domain";
import { WasmBackend, parseNewick } from "@phylo-workbench/model-diffubar";
import { createFubarGrid } from "../src/model/grid.js";
import { postprocessFubar, postprocessFubarAllocations } from "../src/posterior/postprocess.js";
import { fubarPlugin } from "../src/plugin.js";

test("FUBAR grid matches the CodonMolecularEvolution 20-point transform and ordering", () => {
  const grid = createFubarGrid();
  assert.equal(grid.values.length, 20);
  assert.equal(grid.categoryCount, 400);
  assert.ok(Math.abs(grid.values[0]! - (10 ** (1 / 6.578947368421053 - 1.502) - 0.0423174293933042)) < 1e-15);
  assert.ok(Math.abs(grid.values[19]! - (10 ** (20 / 6.578947368421053 - 1.502) - 0.0423174293933042)) < 1e-12);
  assert.equal(grid.alphaIndex[0], 0);
  assert.equal(grid.betaIndex[0], 0);
  assert.equal(grid.alphaIndex[20], 1);
  assert.equal(grid.betaIndex[20], 0);
  // Shared engine stores omega=beta/alpha, so alpha*omega recovers beta.
  assert.ok(Math.abs(grid.categories[2 * 19]! * grid.categories[2 * 19 + 1]! - grid.values[19]!) < 1e-12);
});

test("fused Dirichlet EM recovers analytical pseudocount weights", async () => {
  const conditionals = Float64Array.of(
    1, 0,
    0, 0,
    0, 0,
    0, 1,
  );
  const fit = await new WasmBackend().fitMixtureWeights(conditionals, 4, 2, {
    iterations: 100,
    concentration: 0.5,
    tolerance: 1e-14,
  });
  assert.ok(fit.completedIterations <= 3);
  const expected = [0.375, 0.125, 0.125, 0.375];
  for (let index = 0; index < expected.length; index += 1) assert.ok(Math.abs(fit.theta[index]! - expected[index]!) < 1e-12);
});

test("Dirichlet EM publishes real batched iteration and likelihood progress", async () => {
  const updates: Array<{ current: number | undefined; metricValue: number | undefined }> = [];
  const fit = await new WasmBackend().fitMixtureWeights(Float64Array.of(1, 0.2, 0.2, 1), 2, 2, {
    iterations: 130,
    concentration: 0.5,
    tolerance: 0,
    onProgress: (_fraction, detail) => updates.push({ current: detail?.current, metricValue: detail?.metricValue }),
  });
  assert.equal(fit.completedIterations, 130);
  assert.ok(updates.some((update) => update.current === 64 && Number.isFinite(update.metricValue)));
  assert.ok(updates.some((update) => update.current === 128 && Number.isFinite(update.metricValue)));
  assert.equal(updates.at(-1)?.current, 130);
});

test("site postprocessing distinguishes positive and purifying selection and retains surfaces", () => {
  const grid = createFubarGrid(2);
  const siteCount = 2;
  const conditionals = new Float64Array(grid.categoryCount * siteCount);
  // alpha index 0, beta index 1: positive at site 1.
  conditionals[1 * siteCount] = 1;
  // alpha index 1, beta index 0: purifying at site 2.
  conditionals[2 * siteCount + 1] = 1;
  const output = postprocessFubar(conditionals, new Float64Array(grid.categoryCount).fill(0.25), grid, siteCount, 0.95);
  assert.equal(output.sites[0]!.pPositive, 1);
  assert.equal(output.sites[0]!.selection, "positive");
  assert.equal(output.sites[1]!.pPurifying, 1);
  assert.equal(output.sites[1]!.selection, "purifying");
  assert.equal(output.posterior.surfaces.length, 8);
  assert.equal(output.posterior.alpha.length, 4);
  assert.equal(output.posterior.beta.length, 4);
});

test("exact Gibbs sampling retains reproducible alpha-beta allocations and posterior surfaces", async () => {
  const grid = createFubarGrid(2);
  const siteCount = 2;
  const conditionals = new Float64Array(grid.categoryCount * siteCount);
  conditionals[1 * siteCount] = 1;
  conditionals[2 * siteCount + 1] = 1;
  const options = { iterations: 800, burnin: 100, concentration: 0.5, seed: 2468, trackAllocations: true } as const;
  const first = await new WasmBackend().sampleAlphaBeta(conditionals, grid.categories, grid.categoryCount, siteCount, options);
  const second = await new WasmBackend().sampleAlphaBeta(conditionals, grid.categories, grid.categoryCount, siteCount, options);
  assert.deepEqual(first.theta, second.theta);
  assert.deepEqual(first.allocations, second.allocations);
  assert.equal(first.positive[0], 1);
  assert.equal(first.purifying[1], 1);
  assert.ok(first.allocations !== undefined);
  const output = postprocessFubarAllocations(first.allocations, first.retainedIterations, grid, siteCount, 0.95);
  assert.equal(output.sites[0]!.selection, "positive");
  assert.equal(output.sites[1]!.selection, "purifying");
  assert.equal(output.posterior.surfaces[1], 1);
  assert.equal(output.posterior.surfaces[grid.categoryCount + 2], 1);
});

test("FUBAR plugin accepts an ordinary untagged tree and defaults to parallel WASM", async () => {
  const fasta = ">a\nAAACCC\n>b\nAAAGGG\n>c\nCCCGGG\n>d\nTTTGGG\n";
  const newick = "((a:0.1,b:0.1):0.1,(c:0.1,d:0.1):0.1);";
  const alignment = await createAlignmentArtifact("tiny.fasta", fasta);
  const tree = await createTreeArtifact("tiny.nwk", newick, "upload");
  assert.equal(fubarPlugin.defaultParameters().backend, "wasm-parallel");
  assert.equal(fubarPlugin.defaultParameters().gridPoints, 20);
  assert.equal(fubarPlugin.defaultParameters().inferenceMethod, "dirichlet-em");
  assert.deepEqual(fubarPlugin.validate({ alignment, tree }), { ready: true, issues: [] });
  assert.equal(parseNewick(newick).classCount, 1);
});

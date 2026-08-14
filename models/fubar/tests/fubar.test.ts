import assert from "node:assert/strict";
import test from "node:test";
import { createAlignmentArtifact, createTreeArtifact } from "@phylo-workbench/domain";
import { WasmBackend, codonEquilibriumFromF3x4, countF3x4, parseFasta, parseNewick, type ProgressDetail } from "@phylo-workbench/model-diffubar";
import { createFubarGrid } from "../src/model/grid.js";
import { analyzeApproximateFel, approximateFelResultsToCsv } from "../src/fel/approximate-fel.js";
import { ExactBicubicLogLikelihoodSpline } from "../src/fel/exact-bicubic.js";
import { postprocessFubar, postprocessFubarAllocations } from "../src/posterior/postprocess.js";
import { fubarPlugin } from "../src/plugin.js";
import { analyzeFubar } from "../src/pipeline.js";

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

test("approximate FEL spline is nodal-exact and reproduces a quadratic log-likelihood surface", () => {
  const size = 8;
  const values = new Float64Array(size * size);
  const expected = (alpha: number, beta: number): number => (
    3 + 0.7 * alpha - 0.11 * alpha * alpha - 0.5 * beta - 0.08 * beta * beta + 0.13 * alpha * beta
  );
  for (let alpha = 0; alpha < size; alpha += 1) {
    for (let beta = 0; beta < size; beta += 1) values[alpha * size + beta] = expected(alpha, beta);
  }
  const spline = new ExactBicubicLogLikelihoodSpline(values, size);
  assert.equal(spline.audit.tension, 1);
  assert.ok(spline.audit.maximumNodeError <= 1e-13);
  for (const [alpha, beta] of [[0.2, 0.3], [2.75, 4.4], [6.8, 0.6], [1.1, 6.7]] as const) {
    assert.ok(Math.abs(spline.evaluate(alpha, beta) - expected(alpha, beta)) < 2e-12);
  }
});

test("approximate FEL recovers global and alpha=beta optima with directional p-values", () => {
  const size = 20;
  const grid = createFubarGrid(size);
  const siteCount = 3;
  const logs = new Float64Array(grid.categoryCount * siteCount);
  const surfaces = [
    { alpha: 6.4, beta: 12.2, sigmaAlpha: 1.7, sigmaBeta: 2.1 },
    { alpha: 13.1, beta: 5.7, sigmaAlpha: 2.3, sigmaBeta: 1.5 },
    { alpha: 9.25, beta: 9.25, sigmaAlpha: 1.8, sigmaBeta: 1.8 },
  ] as const;
  for (let alpha = 0; alpha < size; alpha += 1) {
    for (let beta = 0; beta < size; beta += 1) {
      const category = alpha * size + beta;
      for (let site = 0; site < siteCount; site += 1) {
        const target = surfaces[site]!;
        logs[category * siteCount + site] = -(
          (alpha - target.alpha) ** 2 / (2 * target.sigmaAlpha ** 2)
          + (beta - target.beta) ** 2 / (2 * target.sigmaBeta ** 2)
        );
      }
    }
  }
  const updates: number[] = [];
  const result = analyzeApproximateFel(logs, grid, siteCount, {
    onProgress: (_fraction, detail) => updates.push(detail?.current ?? 0),
  });
  const positive = result.sites[0]!;
  const purifying = result.sites[1]!;
  const neutral = result.sites[2]!;
  assert.ok(Math.abs(positive.alphaCoordinate - surfaces[0]!.alpha) < 1e-8);
  assert.ok(Math.abs(positive.betaCoordinate - surfaces[0]!.beta) < 1e-8);
  const positiveTarget = surfaces[0]!;
  const alphaWeight = 1 / positiveTarget.sigmaAlpha ** 2;
  const betaWeight = 1 / positiveTarget.sigmaBeta ** 2;
  const expectedNullCoordinate = (positiveTarget.alpha * alphaWeight + positiveTarget.beta * betaWeight) / (alphaWeight + betaWeight);
  const expectedNullLogLikelihood = -(
    (expectedNullCoordinate - positiveTarget.alpha) ** 2 / (2 * positiveTarget.sigmaAlpha ** 2)
    + (expectedNullCoordinate - positiveTarget.beta) ** 2 / (2 * positiveTarget.sigmaBeta ** 2)
  );
  assert.ok(Math.abs(positive.nullCoordinate - expectedNullCoordinate) < 1e-8);
  assert.ok(Math.abs(positive.likelihoodRatio + 2 * expectedNullLogLikelihood) < 1e-8);
  assert.ok(Math.abs(positive.pValue - 0.0318190571) < 1e-7);
  assert.equal(positive.direction, "positive");
  assert.ok(positive.pPositive < positive.pValue);
  assert.ok(positive.pPurifying > 0.5);
  assert.ok(Math.abs(purifying.alphaCoordinate - surfaces[1]!.alpha) < 1e-8);
  assert.ok(Math.abs(purifying.betaCoordinate - surfaces[1]!.beta) < 1e-8);
  assert.equal(purifying.direction, "purifying");
  assert.ok(purifying.pPurifying < purifying.pValue);
  assert.ok(purifying.pPositive > 0.5);
  assert.equal(neutral.direction, "none");
  assert.ok(neutral.likelihoodRatio < 1e-10);
  assert.equal(neutral.pValue, 1);
  assert.deepEqual(updates, [1, 2, 3]);
  assert.equal(result.relativeLogLikelihoods.length, siteCount * grid.categoryCount);
  assert.ok(result.diagnostics.maximumNodeError <= 1e-12);
  const csv = approximateFelResultsToCsv(result);
  assert.match(csv, /FEL p-value \(positive\)/);
  assert.match(csv, /positive_selected/);
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

test("FUBAR reports runtime compilation separately and keeps fused likelihood work visibly active", async () => {
  const fasta = ">a\nTGATGA\n>b\nTGATGG\n";
  const alignment = parseFasta(fasta);
  const f3x4 = countF3x4(alignment);
  const updates: Array<{ readonly stage: string; readonly fraction: number; readonly detail?: ProgressDetail }> = [];
  await analyzeFubar(fasta, "(a:0.1,b:0.1);", {
    geneticCode: 2,
    backend: "wasm",
    gridPoints: 2,
    iterations: 4,
    fittedModel: {
      geneticCodeId: 2,
      gtrRates: Float64Array.of(1, 1, 1, 1, 1, 1),
      f3x4,
      codonEquilibrium: codonEquilibriumFromF3x4(f3x4, 2),
      globalAlpha: 1,
      globalBeta: 1,
      logLikelihood: 0,
      fitKind: "provided",
    },
    onStage: (stage, fraction, detail) => updates.push({ stage, fraction, ...(detail === undefined ? {} : { detail }) }),
  }).then((result) => {
    assert.equal(result.diagnostics.geneticCodeId, 2);
    assert.equal(result.diagnostics.codonStates, 60);
  });
  const runtime = updates.filter((update) => update.stage === "runtime-initialization");
  assert.ok(runtime.length >= 2);
  assert.match(runtime[0]!.detail?.message ?? "", /compil/i);
  assert.equal(runtime.at(-1)?.fraction, 1);
  assert.ok(updates.some((update) => update.stage === "conditional-likelihoods" && update.detail?.indeterminate === true));
  assert.ok(updates.some((update) => update.stage === "dirichlet-em" && update.detail?.current !== undefined));
});

test("FUBAR evaluates fixed-relative recombination trees as one joint site analysis", async () => {
  const fasta = ">a\nATGAAA\n>b\nATGAAG\n>c\nATAAAA\n";
  const alignment = parseFasta(fasta);
  const f3x4 = countF3x4(alignment);
  const fittedModel = {
    geneticCodeId: 1 as const,
    gtrRates: Float64Array.of(1, 1, 1, 1, 1, 1),
    f3x4,
    codonEquilibrium: codonEquilibriumFromF3x4(f3x4),
    globalAlpha: 1,
    globalBeta: 1,
    logLikelihood: 0,
    fitKind: "provided" as const,
  };
  const result = await analyzeFubar(fasta, "((a:0.1,b:0.1):0.1,c:0.2);", {
    backend: "wasm", gridPoints: 2, iterations: 3, fittedModel,
    recombinationTrees: {
      schemaVersion: 1, sourceMethod: "fsart", branchLengthSource: "segment-ml", branchScalePolicy: "fixed-relative", codonAssignment: "middle-nucleotide",
      segments: [
        { startCodon: 1, endCodon: 1, tree: "((a:0.1,b:0.1):0.1,c:0.2);" },
        { startCodon: 2, endCodon: 2, tree: "((a:0.2,c:0.1):0.1,b:0.15);" },
      ],
    },
  });
  assert.equal(result.sites.length, 2);
  assert.equal(result.diagnostics.regionalTrees, 2);
  assert.equal(result.diagnostics.branchScalePolicy, "fixed-relative");
  assert.equal(result.diagnostics.branchLengthSource, "segment-ml");
  assert.equal(result.diagnostics.codonAssignment, "middle-nucleotide");
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
  assert.equal(fubarPlugin.defaultParameters().approximateFel, false);
  assert.deepEqual(fubarPlugin.validate({ alignment, tree }), { ready: true, issues: [] });
  assert.equal(parseNewick(newick).classCount, 1);
});

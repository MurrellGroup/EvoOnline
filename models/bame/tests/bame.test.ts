import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  WasmBackend,
  ParallelWasmBackend,
  buildModelBank,
  codonEquilibriumFromF3x4,
  compileTree,
  countF3x4,
  encodeCodonTips,
  parseFasta,
  parseNewick,
  parseTaggedNewick,
  type BranchMixtureOperators,
  type DifFUBARGrid,
} from "@phylo-workbench/model-diffubar";
import {
  createFameGrid,
  createFlavorGrid,
  gammaQuantile,
  gammaSlices,
  gammaMeanSlices,
  thresholdGammaSlices,
  gaussLegendreUnit,
} from "../src/index.js";

test("FAME and FLAVOR default grids exactly retain the MixtureModels branch dimensions", () => {
  const fame = createFameGrid();
  assert.deepEqual([fame.alphaValues.length, fame.omega1Values.length, fame.omega2Values.length], [15, 15, 15]);
  assert.equal(fame.categoryCount, 3375);
  assert.ok(Math.abs(fame.omega1Values.at(-1)! - 1) < 1e-14);
  assert.ok(Math.abs(fame.alphaValues.at(-1)! - 8.933960537241305) < 1e-12);

  const flavor = createFlavorGrid();
  assert.deepEqual([flavor.muValues.length, flavor.shapeValues.length, flavor.alphaValues.length], [16, 14, 15]);
  assert.equal(flavor.categoryCount, 6720);
  assert.equal(flavor.capped.filter((value) => value === 0).length, 3360);
  assert.equal(flavor.capped.filter((value) => value === 1).length, 3360);

  const fastFame = createFameGrid("fast");
  const fastFlavor = createFlavorGrid(12, "fast");
  assert.equal(fastFame.categoryCount, 512);
  assert.equal(fastFlavor.categoryCount, 896);
});

test("Gamma quantiles cover FLAVOR's extreme shape grid without underflow artifacts", () => {
  const fixtures = [
    [0.05, 0.025, 5.31566188991436e-33],
    [0.05, 0.975, 0.5671737617538583],
    [0.5, 0.025, 0.0004910345585876278],
    [0.5, 0.975, 2.511943093657444],
    [1, 0.5, 0.6931471805599455],
    [5, 0.025, 1.6234863901184207],
    [20, 0.975, 29.67085357158559],
  ] as const;
  for (const [shape, probability, expected] of fixtures) {
    const actual = gammaQuantile(shape, probability);
    assert.ok(Math.abs(actual - expected) <= Math.max(1e-45, Math.abs(expected) * 2e-12), `${shape}, ${probability}: ${actual}`);
  }
  const slices = gammaSlices(3, 0.05, 20);
  assert.ok(slices[0]! > 0 && slices[0]! < 1e-30);
  assert.ok(slices.every((value, index) => index === 0 || value > slices[index - 1]!));
});

test("threshold-aware Gamma quadrature preserves the continuous omega>1 tail", () => {
  const quadrature = thresholdGammaSlices(0.7, 9.7, 8);
  const representedTail = quadrature.weights.reduce((sum, weight, index) => sum + (quadrature.positiveMask[index] ? weight : 0), 0);
  assert.ok(quadrature.values.some((value) => value < 1));
  assert.ok(quadrature.values.some((value) => value > 1));
  assert.ok(Math.abs(representedTail - quadrature.positiveProbability) < 2e-14);
  assert.ok(Math.abs(quadrature.weights.reduce((sum, value) => sum + value, 0) - 1) < 2e-14);
  const representedMean = quadrature.weights.reduce((sum, weight, index) => sum + weight * quadrature.values[index]!, 0);
  assert.ok(Math.abs(representedMean - 0.7) < 2e-12);
});

test("site-wise alpha Gamma categories retain an exact mean of one", () => {
  for (const shape of [0.16, 0.5, 1, 4, 10]) {
    const values = gammaMeanSlices(1, shape, 4);
    assert.ok(values.every((value, index) => value > 0 && (index === 0 || value > values[index - 1]!)));
    assert.ok(Math.abs(values.reduce((sum, value) => sum + value, 0) / values.length - 1) < 2e-12);
  }
});

test("Global-Gamma messages integrate omega on branches inside each site-level alpha category", async () => {
  const alignment = parseFasta(">a\nATGAAA\n>b\nATGAAG\n");
  const tree = parseNewick("(a:0.1,b:0.2);");
  const f3x4 = countF3x4(alignment);
  const equilibrium = codonEquilibriumFromF3x4(f3x4);
  const omegaValues = Float64Array.of(0.25, 3);
  const atomicGrid: DifFUBARGrid = {
    alpha: Float64Array.of(1), omega: Float64Array.of(0.25, 3, 1), backgroundOmega: new Float64Array(0),
    categories: Float64Array.of(1, 0.25, 1, 3, 1, 1), categoryCount: 3, parameterCount: 2, hasBackground: false,
  };
  const atomicModels = buildModelBank(atomicGrid, tree, Float64Array.of(1, 1, 1, 1, 1, 1), f3x4);
  const backend = new WasmBackend();
  const messageRequest = {
    tree: {
      parent: Int32Array.of(-1, 0, 0),
      childOffsets: Uint32Array.of(0, 2, 2, 2),
      children: Uint32Array.of(1, 2),
      tipForNode: Int32Array.of(-1, 0, 1),
      edgeForNode: Int32Array.of(-1, 0, 1),
      nodeForEdge: Uint32Array.of(1, 2),
      postorder: Uint32Array.of(1, 2, 0),
      preorder: Uint32Array.of(0, 1, 2),
      root: 0, nodeCount: 3, edgeCount: 2, tipCount: 2,
    },
    tipStates: encodeCodonTips(alignment, tree),
    siteCount: alignment.codonSites,
    branchLengths: Float64Array.of(0.1, 0.2),
    omegaModels: atomicModels.gridModels.slice(0, 2),
    omegaWeights: Float64Array.of(0.4, 0.6),
    positiveMask: Uint8Array.of(0, 1),
    neutralModel: atomicModels.gridModels[2]!,
    alphaValues: Float64Array.of(0.5, 1.5),
    alphaWeights: Float64Array.of(0.3, 0.7),
    models: atomicModels,
    equilibrium,
  } as const;
  const messages = await backend.evaluateGlobalGammaMessages(messageRequest);

  const taggedTree = parseTaggedNewick("(a{G1}:0.1,b{G2}:0.2);");
  const assignmentWeights = [0.16, 0.24, 0.24, 0.36];
  const alphaValues = [0.5, 1.5];
  const alphaWeights = [0.3, 0.7];
  const categories: number[] = [];
  const cappedCategories: number[] = [];
  for (const alpha of alphaValues) {
    for (const first of omegaValues) for (const second of omegaValues) {
      categories.push(alpha, first, second);
      cappedCategories.push(alpha, Math.min(1, first), second);
    }
  }
  const explicitGrid = (values: number[]): DifFUBARGrid => ({
    alpha: Float64Array.from(alphaValues), omega: omegaValues, backgroundOmega: new Float64Array(0),
    categories: Float64Array.from(values), categoryCount: 8, parameterCount: 3, hasBackground: false,
  });
  const fullGrid = explicitGrid(categories);
  const cappedGrid = explicitGrid(cappedCategories);
  const fullModels = buildModelBank(fullGrid, taggedTree, Float64Array.of(1, 1, 1, 1, 1, 1), f3x4);
  const cappedModels = buildModelBank(cappedGrid, taggedTree, Float64Array.of(1, 1, 1, 1, 1, 1), f3x4);
  const full = await backend.evaluate({ tree: compileTree(taggedTree), tipStates: encodeCodonTips(alignment, taggedTree), siteCount: 2, grid: fullGrid, models: fullModels, equilibrium });
  const capped = await backend.evaluate({ tree: compileTree(taggedTree), tipStates: encodeCodonTips(alignment, taggedTree), siteCount: 2, grid: cappedGrid, models: cappedModels, equilibrium });
  const logSum = (terms: readonly number[]): number => {
    const maximum = Math.max(...terms);
    return maximum + Math.log(terms.reduce((sum, value) => sum + Math.exp(value - maximum), 0));
  };
  for (let site = 0; site < 2; site += 1) {
    const fullTerms: number[] = [];
    const cappedTerms: number[] = [];
    const positiveTerms: number[] = [];
    for (let alpha = 0; alpha < 2; alpha += 1) {
      for (let assignment = 0; assignment < 4; assignment += 1) {
        const category = alpha * 4 + assignment;
        const logWeight = Math.log(alphaWeights[alpha]!) + Math.log(assignmentWeights[assignment]!);
        fullTerms.push(logWeight + full.logLikelihoods[category * 2 + site]!);
        cappedTerms.push(logWeight + capped.logLikelihoods[category * 2 + site]!);
        if (assignment >= 2) positiveTerms.push(logWeight + full.logLikelihoods[category * 2 + site]!);
      }
    }
    assert.ok(Math.abs(messages.siteLogLikelihoods[site]! - logSum(fullTerms)) < 4e-10);
    assert.ok(Math.abs(messages.cappedEdgeLogLikelihoods[site]! - logSum(cappedTerms)) < 4e-10);
    assert.ok(Math.abs(messages.positiveEdgeLogLikelihoods[site]! - logSum(positiveTerms)) < 4e-10);
  }

  // Force the site-partitioned worker path and require it to splice all three
  // edge-major result blocks back together without changing a bit.
  const repeatedSiteCount = 64;
  const repeatedTips = new Uint8Array(tree.tips.length * repeatedSiteCount);
  for (let tip = 0; tip < tree.tips.length; tip += 1) {
    for (let site = 0; site < repeatedSiteCount; site += 1) {
      repeatedTips[tip * repeatedSiteCount + site] = messageRequest.tipStates[tip * messageRequest.siteCount + site % messageRequest.siteCount]!;
    }
  }
  const repeatedRequest = { ...messageRequest, tipStates: repeatedTips, siteCount: repeatedSiteCount };
  const serialRepeated = await backend.evaluateGlobalGammaMessages(repeatedRequest);
  const parallelBackend = new ParallelWasmBackend(2, 0);
  try {
    const parallelRepeated = await parallelBackend.evaluateGlobalGammaMessages(repeatedRequest);
    assert.equal(parallelRepeated.backend, "wasm-parallel");
    assert.deepEqual(parallelRepeated.siteLogLikelihoods, serialRepeated.siteLogLikelihoods);
    assert.deepEqual(parallelRepeated.cappedEdgeLogLikelihoods, serialRepeated.cappedEdgeLogLikelihoods);
    assert.deepEqual(parallelRepeated.positiveEdgeLogLikelihoods, serialRepeated.positiveEdgeLogLikelihoods);
  } finally {
    await parallelBackend.dispose();
  }
});

test("Gauss-Legendre weight quadrature is normalized and integrates low-order polynomials", () => {
  const rule = gaussLegendreUnit(8);
  const total = rule.weights.reduce((sum, value) => sum + value, 0);
  const first = rule.weights.reduce((sum, value, index) => sum + value * rule.nodes[index]!, 0);
  const seventh = rule.weights.reduce((sum, value, index) => sum + value * rule.nodes[index]! ** 7, 0);
  assert.ok(Math.abs(total - 1) < 1e-14);
  assert.ok(Math.abs(first - 0.5) < 1e-14);
  assert.ok(Math.abs(seventh - 0.125) < 1e-14);
});

test("fused branch-mixture collapse matches explicit atomic likelihood algebra", async () => {
  const alignmentText = await readFile(new URL("../../../examples/diffubar-demo.fasta", import.meta.url), "utf8");
  const taggedTree = await readFile(new URL("../../../examples/diffubar-demo.nwk", import.meta.url), "utf8");
  const alignment = parseFasta(alignmentText);
  const tree = parseNewick(taggedTree.replaceAll(/\{[^}]+\}/g, ""));
  const f3x4 = countF3x4(alignment);
  const equilibrium = codonEquilibriumFromF3x4(f3x4);
  const grid: DifFUBARGrid = {
    alpha: Float64Array.of(1), omega: Float64Array.of(0.25, 3), backgroundOmega: new Float64Array(0),
    categories: Float64Array.of(1, 0.25, 1, 3), categoryCount: 2, parameterCount: 2, hasBackground: false,
  };
  const models = buildModelBank(grid, tree, Float64Array.of(1, 1, 1, 1, 1, 1), f3x4);
  const compiled = compileTree(tree);
  const tips = encodeCodonTips(alignment, tree);
  const backend = new WasmBackend();
  const atomic = await backend.evaluate({ tree: compiled, tipStates: tips, siteCount: alignment.codonSites, grid, models, equilibrium });

  const collapsedGrid: DifFUBARGrid = {
    alpha: Float64Array.of(1), omega: Float64Array.of(1), backgroundOmega: new Float64Array(0),
    categories: Float64Array.of(1, 1), categoryCount: 1, parameterCount: 2, hasBackground: false,
  };
  const baseOperators = {
    operatorCount: 2,
    operatorOffsets: Uint32Array.of(0, 1, 2),
    componentModels: Uint32Array.of(models.gridModels[0]!, models.gridModels[1]!),
    componentWeights: Float64Array.of(1, 1),
    operatorScales: Float64Array.of(1, 1),
    operatorsPerCategory: 2,
    collapseWeights: Float64Array.of(0.25, 0.75),
  } as const;
  const likelihoodOperators: BranchMixtureOperators = { ...baseOperators, collapseMode: "log-mean-likelihood" };
  const marginalized = await backend.evaluateBranchMixture({ tree: compiled, tipStates: tips, siteCount: alignment.codonSites, grid: collapsedGrid, models, operators: likelihoodOperators, equilibrium });
  const draftOperators: BranchMixtureOperators = { ...baseOperators, collapseMode: "mean-log-likelihood" };
  const draft = await backend.evaluateBranchMixture({ tree: compiled, tipStates: tips, siteCount: alignment.codonSites, grid: collapsedGrid, models, operators: draftOperators, equilibrium });

  // The runtime switches to a transition-matrix streaming kernel for site-rich
  // alignments. Tile the demo sites past that threshold and require the dense
  // path to reproduce every sparse-kernel likelihood exactly.
  const repeats = 6;
  const denseSiteCount = alignment.codonSites * repeats;
  const denseTips = new Uint8Array(tree.tips.length * denseSiteCount);
  for (let tip = 0; tip < tree.tips.length; tip += 1) {
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      denseTips.set(
        tips.subarray(tip * alignment.codonSites, (tip + 1) * alignment.codonSites),
        tip * denseSiteCount + repeat * alignment.codonSites,
      );
    }
  }
  const dense = await backend.evaluateBranchMixture({
    tree: compiled,
    tipStates: denseTips,
    siteCount: denseSiteCount,
    grid: collapsedGrid,
    models,
    operators: likelihoodOperators,
    equilibrium,
  });

  for (let site = 0; site < alignment.codonSites; site += 1) {
    const left = atomic.logLikelihoods[site]!;
    const right = atomic.logLikelihoods[alignment.codonSites + site]!;
    const maximum = Math.max(left + Math.log(0.25), right + Math.log(0.75));
    const expectedMarginal = maximum + Math.log(Math.exp(left + Math.log(0.25) - maximum) + Math.exp(right + Math.log(0.75) - maximum));
    assert.ok(Math.abs(marginalized.logLikelihoods[site]! - expectedMarginal) < 2e-11);
    assert.ok(Math.abs(draft.logLikelihoods[site]! - (0.25 * left + 0.75 * right)) < 2e-11);
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      assert.ok(Math.abs(dense.logLikelihoods[repeat * alignment.codonSites + site]! - expectedMarginal) < 2e-11);
    }
  }
});

test("FLAVOR Julia-grid interpolation is exact at table nodes and partitions whole alpha blocks", async () => {
  const alignment = parseFasta(">a\nATGAAA\n>b\nATGAAG\n");
  const tree = parseNewick("(a:0.001,b:0.001);");
  const f3x4 = countF3x4(alignment);
  const equilibrium = codonEquilibriumFromF3x4(f3x4);
  const atomicGrid: DifFUBARGrid = {
    alpha: Float64Array.of(1), omega: Float64Array.of(0.2, 2.5), backgroundOmega: new Float64Array(0),
    categories: Float64Array.of(1, 0.2, 1, 2.5), categoryCount: 2, parameterCount: 2, hasBackground: false,
  };
  const models = buildModelBank(atomicGrid, tree, Float64Array.of(1, 1, 1, 1, 1, 1), f3x4);
  const first = models.gridModels[0]!;
  const second = models.gridModels[1]!;
  const grid: DifFUBARGrid = {
    alpha: Float64Array.of(1, 2), omega: Float64Array.of(1), backgroundOmega: new Float64Array(0),
    categories: Float64Array.from([
      1, 0.5, 1, 0,
      2, 0.5, 1, 0,
      1, 1.5, 1, 1,
      2, 1.5, 1, 1,
    ]),
    categoryCount: 4, parameterCount: 4, hasBackground: false,
  };
  const operators: BranchMixtureOperators = {
    operatorCount: 4,
    operatorOffsets: Uint32Array.of(0, 2, 4, 6, 8),
    componentModels: Uint32Array.of(first, second, first, second, first, second, first, second),
    componentWeights: Float64Array.of(0.4, 0.6, 0.4, 0.6, 0.7, 0.3, 0.7, 0.3),
    operatorScales: Float64Array.of(1, 2, 1, 2),
    operatorsPerCategory: 1,
    collapseWeights: Float64Array.of(1, 1, 1, 1),
    collapseMode: "log-mean-likelihood",
  };
  const request = {
    tree: compileTree(tree),
    tipStates: encodeCodonTips(alignment, tree),
    siteCount: alignment.codonSites,
    grid,
    models,
    operators,
    equilibrium,
  } as const;
  const serialBackend = new WasmBackend();
  const direct = await serialBackend.evaluateBranchMixture(request);
  const interpolated = await serialBackend.evaluateFlavorInterpolated({ ...request, alphaCount: 2 });
  for (let index = 0; index < direct.logLikelihoods.length; index += 1) {
    assert.ok(Math.abs(interpolated.logLikelihoods[index]! - direct.logLikelihoods[index]!) < 3e-11);
  }
  const offGridTree = parseNewick("(a:0.137,b:0.083);");
  const offGridRequest = {
    ...request,
    tree: compileTree(offGridTree),
    tipStates: encodeCodonTips(alignment, offGridTree),
  };
  const offGridDirect = await serialBackend.evaluateBranchMixture(offGridRequest);
  const offGridInterpolated = await serialBackend.evaluateFlavorInterpolated({ ...offGridRequest, alphaCount: 2 });
  let maximumInterpolationDifference = 0;
  for (let index = 0; index < offGridDirect.logLikelihoods.length; index += 1) {
    assert.ok(Number.isFinite(offGridInterpolated.logLikelihoods[index]!));
    maximumInterpolationDifference = Math.max(
      maximumInterpolationDifference,
      Math.abs(offGridInterpolated.logLikelihoods[index]! - offGridDirect.logLikelihoods[index]!),
    );
  }
  assert.ok(maximumInterpolationDifference < 2e-3, `off-grid log-likelihood difference ${maximumInterpolationDifference}`);
  const parallelBackend = new ParallelWasmBackend(2, 0);
  try {
    const parallel = await parallelBackend.evaluateFlavorInterpolated({ ...request, alphaCount: 2 });
    assert.equal(parallel.backend, "wasm-parallel");
    assert.deepEqual(parallel.logLikelihoods, interpolated.logLikelihoods);
  } finally {
    await parallelBackend.dispose();
  }
});

test("a mixed transition on every branch equals the explicit latent branch-state expansion", async () => {
  const alignment = parseFasta(">a\nATGAAA\n>b\nATGAAG\n");
  const tree = parseTaggedNewick("(a{G1}:0.11,b{G2}:0.17);");
  const f3x4 = countF3x4(alignment);
  const equilibrium = codonEquilibriumFromF3x4(f3x4);
  const explicitGrid: DifFUBARGrid = {
    alpha: Float64Array.of(1),
    omega: Float64Array.of(0.25, 3),
    backgroundOmega: new Float64Array(0),
    categories: Float64Array.of(
      1, 0.25, 0.25,
      1, 0.25, 3,
      1, 3, 0.25,
      1, 3, 3,
    ),
    categoryCount: 4,
    parameterCount: 3,
    hasBackground: false,
  };
  const models = buildModelBank(explicitGrid, tree, Float64Array.of(1, 1, 1, 1, 1, 1), f3x4);
  const compiled = compileTree(tree);
  const tips = encodeCodonTips(alignment, tree);
  const mixtureTree = parseNewick("(a:0.11,b:0.17);");
  const mixtureCompiled = compileTree(mixtureTree);
  const mixtureTips = encodeCodonTips(alignment, mixtureTree);
  const backend = new WasmBackend();
  const explicit = await backend.evaluate({ tree: compiled, tipStates: tips, siteCount: 2, grid: explicitGrid, models, equilibrium });
  const collapsedGrid: DifFUBARGrid = {
    alpha: Float64Array.of(1), omega: Float64Array.of(1), backgroundOmega: new Float64Array(0),
    categories: Float64Array.of(1, 1, 1), categoryCount: 1, parameterCount: 3, hasBackground: false,
  };
  const firstModel = models.gridModels[0]!;
  const secondModel = models.gridModels[3]!;
  const operators: BranchMixtureOperators = {
    operatorCount: 1,
    operatorOffsets: Uint32Array.of(0, 2),
    componentModels: Uint32Array.of(firstModel, secondModel),
    componentWeights: Float64Array.of(0.3, 0.7),
    operatorScales: Float64Array.of(1),
    operatorsPerCategory: 1,
    collapseWeights: Float64Array.of(1),
    collapseMode: "log-mean-likelihood",
  };
  const mixed = await backend.evaluateBranchMixture({ tree: mixtureCompiled, tipStates: mixtureTips, siteCount: 2, grid: collapsedGrid, models, operators, equilibrium });
  const assignmentWeights = [0.09, 0.21, 0.21, 0.49];
  for (let site = 0; site < 2; site += 1) {
    const terms = assignmentWeights.map((weight, category) => Math.log(weight) + explicit.logLikelihoods[category * 2 + site]!);
    const maximum = Math.max(...terms);
    const expected = maximum + Math.log(terms.reduce((sum, value) => sum + Math.exp(value - maximum), 0));
    assert.ok(Math.abs(mixed.logLikelihoods[site]! - expected) < 3e-11);
  }
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseFasta } from "../src/io/fasta.js";
import { parseTaggedNewick } from "../src/io/newick.js";
import { compileTree } from "../src/tree/compiler.js";
import { createDifFUBARGrid } from "../src/model/grid.js";
import {
  buildModelBank,
  codonEquilibriumFromF3x4,
  countF3x4,
  encodeCodonTips,
} from "../src/model/genetic-code.js";
import { WasmBackend } from "../src/backends/wasm.js";
import { ParallelWasmBackend } from "../src/backends/wasm-parallel.js";
import type { ProgressDetail } from "../src/types.js";

describe("WASM backend", () => {
  it("returns the analytical zero-length likelihood", async () => {
    const alignment = parseFasta(">a\nATG\n>b\nATG\n");
    const tree = parseTaggedNewick("(a{G1}:0,b{G2}:0);");
    const compiled = compileTree(tree);
    const grid = createDifFUBARGrid(false, 1, 1);
    const f3x4 = countF3x4(alignment);
    const equilibrium = codonEquilibriumFromF3x4(f3x4);
    const models = buildModelBank(grid, tree, Float64Array.of(1, 1, 1, 1, 1, 1), f3x4);
    const result = await new WasmBackend().evaluate({
      tree: compiled,
      tipStates: encodeCodonTips(alignment, tree),
      siteCount: 1,
      grid,
      models,
      equilibrium,
    });
    assert.equal(result.logLikelihoods.length, grid.categoryCount);
    for (const value of result.logLikelihoods) assert.ok(Math.abs(value) < 1e-12);
  });

  it("matches an independent SciPy dense-expm fixture", async () => {
    const alignment = parseFasta(">a\nAAA\n>b\nCCC\n>c\nGGG\n>d\nTTT\n");
    const tree = parseTaggedNewick("(a{G1}:0.1,b{G1}:0.2,c{G2}:0.15,d{G2}:0.05);");
    const grid = createDifFUBARGrid(false, 1, 1);
    const f3x4 = countF3x4(alignment);
    const equilibrium = codonEquilibriumFromF3x4(f3x4);
    const result = await new WasmBackend().evaluate({
      tree: compileTree(tree),
      tipStates: encodeCodonTips(alignment, tree),
      siteCount: 1,
      grid,
      models: buildModelBank(grid, tree, Float64Array.of(1, 1, 1, 1, 1, 1), f3x4),
      equilibrium,
      poissonTerms: 24,
      maxLambdaPerStep: 1,
    });
    const expected = [
      -101.25145623236678, -85.40632525546066, -84.42243432906899, -73.6126859693708,
      -60.05609652391976, -44.3999213370479, -43.49931944716555, -32.94870278607026,
    ];
    for (let i = 0; i < expected.length; i += 1) assert.ok(Math.abs(result.logLikelihoods[i]! - expected[i]!) < 2e-12);
  });

  it("reassembles site-partitioned worker likelihoods exactly", async () => {
    const codons = "AAA".repeat(100);
    const alignment = parseFasta(`>a\n${codons}\n>b\n${codons}\n`);
    const tree = parseTaggedNewick("(a{G1}:0.01,b{G2}:0.02);");
    const grid = createDifFUBARGrid(false, 6, 6);
    const f3x4 = countF3x4(alignment);
    const request = {
      tree: compileTree(tree),
      tipStates: encodeCodonTips(alignment, tree),
      siteCount: alignment.codonSites,
      grid,
      models: buildModelBank(grid, tree, Float64Array.of(1, 1, 1, 1, 1, 1), f3x4),
      equilibrium: codonEquilibriumFromF3x4(f3x4),
    } as const;
    const serial = await new WasmBackend().evaluate(request);
    const parallelBackend = new ParallelWasmBackend(2);
    const progress: Array<{ readonly fraction: number; readonly detail?: ProgressDetail }> = [];
    try {
      const parallel = await parallelBackend.evaluate({
        ...request,
        onProgress: (fraction, detail) => progress.push({ fraction, ...(detail === undefined ? {} : { detail }) }),
      });
      assert.equal(parallel.backend, "wasm-parallel");
      assert.deepEqual(parallel.logLikelihoods, serial.logLikelihoods);
      assert.ok(progress.some((update) => update.detail?.indeterminate === true));
      assert.equal(progress[1]?.detail?.indeterminate, true, "the worker pool must remain visibly active while its first fused block runs");
      assert.ok(progress.some((update) => update.fraction > 0 && update.fraction < 1));
      assert.equal(progress.at(-1)?.detail?.current, alignment.codonSites * grid.categoryCount);
      assert.match(progress.at(-1)?.detail?.message ?? "", /site blocks complete/);
    } finally {
      await parallelBackend.dispose();
    }
  });

  it("keeps hierarchical subtree caching identical to the flat program", async () => {
    const alignment = parseFasta(">a\nAAACCC\n>b\nAAAGGG\n>c\nCCCGGG\n>d\nTTTGGG\n");
    const tree = parseTaggedNewick("((a{G1}:0.1,b{G1}:0.2){G1}:0.03,(c{G2}:0.15,d{G2}:0.05){G2}:0.04);");
    const compiled = compileTree(tree);
    assert.ok(compiled.cachedMainOps !== undefined);
    const flat = {
      ops: compiled.ops,
      edgeLengths: compiled.edgeLengths,
      rootSlot: compiled.rootSlot,
      slotCount: compiled.slotCount,
      tipCount: compiled.tipCount,
      classCount: compiled.classCount,
      registerNumber: compiled.registerNumber,
    };
    const grid = createDifFUBARGrid(false, 1, 1);
    const f3x4 = countF3x4(alignment);
    const common = {
      tipStates: encodeCodonTips(alignment, tree),
      siteCount: alignment.codonSites,
      grid,
      models: buildModelBank(grid, tree, Float64Array.of(1, 1, 1, 1, 1, 1), f3x4),
      equilibrium: codonEquilibriumFromF3x4(f3x4),
      poissonTerms: 24,
      maxLambdaPerStep: 1,
    } as const;
    const backend = new WasmBackend();
    const [cached, uncached] = await Promise.all([
      backend.evaluate({ tree: compiled, ...common }),
      backend.evaluate({ tree: flat, ...common }),
    ]);
    for (let index = 0; index < cached.logLikelihoods.length; index += 1) {
      assert.ok(Math.abs(cached.logLikelihoods[index]! - uncached.logLikelihoods[index]!) < 2e-12);
    }
  });

  it("runs the reference-semantic Gibbs transitions deterministically", async () => {
    const backend = new WasmBackend();
    const conditionals = Float64Array.of(
      1, 0,
      0, 1,
    );
    const categories = Float64Array.of(
      1, 2, 0.5,
      1, 0.5, 2,
    );
    const result = await backend.sample(conditionals, categories, 2, 2, 3, {
      iterations: 80,
      burnin: 20,
      concentration: 0.1,
      seed: 7,
      samplerMode: "reference",
      trackAllocations: true,
    });
    assert.equal(result.sites[0]!.pOmega1Greater, 1);
    assert.equal(result.sites[1]!.pOmega2Greater, 1);
    assert.equal(result.allocations?.length, 4);
    assert.ok(Math.abs(result.theta.reduce((sum, value) => sum + value, 0) - 1) < 1e-12);
  });

  it("keeps sparse-cutoff Gibbs identical when no positive likelihood is removed", async () => {
    const backend = new WasmBackend();
    const conditionals = Float64Array.of(
      1, 0.3, 0.6,
      0.7, 1, 0.4,
      0.2, 0.5, 1,
    );
    const categories = Float64Array.of(
      1, 2, 0.5,
      1, 0.5, 2,
      0.5, 1, 1,
    );
    const settings = {
      iterations: 120,
      burnin: 20,
      concentration: 0.1,
      seed: 91,
      samplerMode: "reference",
      trackAllocations: true,
    } as const;
    const dense = await backend.sample(conditionals, categories, 3, 3, 3, settings);
    const sparse = await backend.sample(conditionals, categories, 3, 3, 3, { ...settings, likelihoodCutoff: 1e-15 });
    assert.deepEqual(sparse.theta, dense.theta);
    assert.deepEqual(sparse.allocations, dense.allocations);
    assert.deepEqual(sparse.sites, dense.sites);
  });

  it("samples the exact categorical posterior with the fast rejection kernel", async () => {
    const result = await new WasmBackend().sample(
      Float64Array.of(1, 0.25),
      Float64Array.of(1, 2, 0.5, 1, 0.5, 2),
      2,
      1,
      3,
      {
        iterations: 50_000,
        burnin: 1_000,
        concentration: 0.1,
        seed: 808,
        samplerMode: "fast-exact",
      },
    );
    // With one site and a symmetric Dirichlet prior, the marginal allocation
    // probability is L1 / (L1 + L2) = 0.8.
    assert.ok(Math.abs(result.sites[0]!.pOmega1Greater - 0.8) < 0.02);
  });
});

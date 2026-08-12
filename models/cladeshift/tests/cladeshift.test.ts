import assert from "node:assert/strict";
import test from "node:test";
import { analyzeCladeShift, selectionIntensityOmega, summarizeCladeShift } from "../src/index.js";
import { compressNullPosterior } from "../src/posterior.js";
import { parseNewick } from "@phylo-workbench/model-diffubar";

test("selection-intensity transform contracts or expands log omega without reversing extreme categories", () => {
  assert.ok(selectionIntensityOmega(0.2, 0.5) > 0.2);
  assert.ok(selectionIntensityOmega(3, 0.5) < 3);
  assert.ok(selectionIntensityOmega(0.2, 2) < 0.2);
  assert.ok(selectionIntensityOmega(3, 2) > 3);
  assert.ok(Math.abs(selectionIntensityOmega(100, 2) - 100) < 1e-10);
  assert.equal(selectionIntensityOmega(1, 0.4), 1);
});

test("null posterior compression retains and renormalizes each site's largest categories", () => {
  const compressed = compressNullPosterior({
    siteCount: 2,
    gridSize: 2,
    gridValues: Float64Array.of(0.1, 1),
    surfaces: Float32Array.of(0.05, 0.7, 0.2, 0.05, 0.4, 0.1, 0.3, 0.2),
    alpha: new Float32Array(4),
    beta: new Float32Array(4),
  }, 2);
  assert.deepEqual([...compressed.categories], [1, 2, 0, 2]);
  assert.ok(Math.abs(compressed.capturedMass[0]! - 0.9) < 1e-6);
  assert.ok(Math.abs(compressed.weights[0]! + compressed.weights[1]! - 1) < 1e-12);
  assert.ok(Math.abs(compressed.weights[2]! + compressed.weights[3]! - 1) < 1e-12);
});

test("adaptive null compression stops at its mass target and zero-pads only the rectangular ABI", () => {
  const compressed = compressNullPosterior({
    siteCount: 2,
    gridSize: 2,
    gridValues: Float64Array.of(0.1, 1),
    surfaces: Float32Array.of(0.7, 0.2, 0.08, 0.02, 0.4, 0.3, 0.2, 0.1),
    alpha: new Float32Array(4),
    beta: new Float32Array(4),
  }, 4, 0.8);
  assert.deepEqual([...compressed.retainedCounts], [2, 3]);
  assert.equal(compressed.componentCount, 3);
  assert.equal(compressed.weights[2], 0);
  assert.ok(compressed.capturedMass[0]! >= 0.8 && compressed.capturedMass[1]! >= 0.8);
  assert.ok(Math.abs(compressed.weights[0]! + compressed.weights[1]! - 1) < 1e-12);
  assert.ok(Math.abs(compressed.weights[3]! + compressed.weights[4]! + compressed.weights[5]! - 1) < 1e-12);
});

test("fixed priors penalize the all-clade search and recover a strong relaxation location", () => {
  const tree = parseNewick("((a:0.1,b:0.1)n:0.2,c:0.3)root;");
  const edgeNodes = tree.nodes.filter((node) => node !== tree.root);
  const candidateBranches = Uint32Array.of(0, 1);
  const summary = summarizeCladeShift({
    // layout [site, intensity, candidate]: K=.5 strongly supports edge 2; K=2 does not.
    logLikelihoodRatios: Float64Array.of(0, Math.log(2_000), 0, 0),
    intensities: Float64Array.of(0.5, 2),
    candidateBranches,
    edgeNodes,
    nodeForEdge: Uint32Array.of(1, 2, 3, 4),
    descendantTips: Uint32Array.of(2, 1, 1, 1),
    capturedMass: Float64Array.of(0.98),
    baselineSites: [{ site: 1, pPositive: 0.01, pPurifying: 0.95, meanAlpha: 0.8, meanBeta: 0.2, selection: "purifying" }],
    shiftPrior: 0.2,
    threshold: 0.9,
  });
  assert.ok(summary.sites[0]!.pRelaxation > 0.95);
  assert.equal(summary.sites[0]!.mapBranch, 2);
  assert.equal(summary.sites[0]!.direction, "relaxation");
  assert.ok(summary.posterior.branchPosterior[1]! > summary.posterior.branchPosterior[0]!);
});

test("small end-to-end CladeShift analysis returns auditable posterior products", async () => {
  const fasta = ">a\nATGAAAGCTTTCGGA\n>b\nATGAAGGCTTTCGGA\n>c\nATGAAAGCCTTTGGA\n>d\nATGAAGGCTTTTGGT\n";
  const tree = "(((a{old-foreground}:0.08,b{old-foreground}:0.11)n{old-foreground}:0.17,c:0.13)m:0.21,d:0.19)root;";
  const result = await analyzeCladeShift(fasta, tree, {
    backend: "wasm",
    gridPoints: 8,
    posteriorComponents: 2,
    intensityPreset: "fast",
    inferenceIterations: 100,
  });
  assert.equal(result.method, "clade-shift");
  assert.equal(result.sites.length, 5);
  assert.equal(result.posterior.branchPosterior.length, result.sites.length * result.branches.length);
  assert.ok(result.branches.every((branch) => !branch.name.includes("{")));
  assert.equal(result.diagnostics.cladeAlgorithm, "baseline-outside-plus-shifted-subtree-inside");
  assert.ok(result.diagnostics.minimumCapturedPosteriorMass > 0);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  WasmBackend,
  ParallelWasmBackend,
  codonEquilibriumFromF3x4,
  countF3x4,
  encodeCodonTips,
  parseFasta,
  parseNewick,
  type FittedModel,
} from "@phylo-workbench/model-diffubar";
import { BsrelLikelihood } from "../src/fit/likelihood.js";
import type { DecodedBranchModel } from "../src/model/parameters.js";
import { analyzeBsrel } from "../src/pipeline.js";
import { bsrelPValue, holmBonferroni } from "../src/statistics.js";
import { compileBsrelTree } from "../src/tree/messages.js";

const fastaText = await readFile(new URL("../../../examples/diffubar-demo.fasta", import.meta.url), "utf8");
const taggedTreeText = await readFile(new URL("../../../examples/diffubar-demo.nwk", import.meta.url), "utf8");
const treeText = taggedTreeText.replaceAll(/\{[^}]+\}/g, "");
const alignment = parseFasta(fastaText);
const tree = parseNewick(treeText);
const f3x4 = countF3x4(alignment);
const fittedModel: FittedModel = {
  gtrRates: new Float64Array(6).fill(1),
  f3x4,
  codonEquilibrium: codonEquilibriumFromF3x4(f3x4),
  globalAlpha: 1,
  globalBeta: 1,
  logLikelihood: Number.NaN,
  fitKind: "provided",
};

function branchModel(length: number, positive = 2): DecodedBranchModel {
  return {
    omegaMinus: 0.1,
    omegaNeutral: 0.8,
    omegaPositive: positive,
    weightMinus: 0.65,
    weightNeutral: 0.25,
    weightPositive: 0.1,
    length: Math.max(1e-6, length),
  };
}

test("every all-to-all local branch replacement equals a full re-prune", async () => {
  const compiled = compileBsrelTree(tree);
  const models = compiled.edgeNodes.map((node) => branchModel(node.branchLength));
  const likelihood = new BsrelLikelihood(
    new WasmBackend(),
    compiled,
    tree,
    encodeCodonTips(alignment, tree),
    alignment.codonSites,
    fittedModel,
  );
  const candidates = models.map((model, edge) => ({
    edge,
    model: {
      ...model,
      omegaPositive: 3.5 + edge * 0.2,
      weightMinus: 0.57,
      weightNeutral: 0.25,
      weightPositive: 0.18,
      length: model.length * (1.05 + edge * 0.01),
    },
  }));
  const local = await likelihood.evaluate(models, candidates);
  const unchanged = await likelihood.evaluate(models, [{ edge: 0, model: models[0]! }]);
  assert.ok(Math.abs(local.objectives[0]! - unchanged.objectives[1]!) < 1e-8);
  for (let edge = 0; edge < models.length; edge += 1) {
    const fullModels = [...models];
    fullModels[edge] = candidates[edge]!.model;
    const full = await likelihood.evaluate(fullModels);
    assert.ok(Math.abs(local.objectives[edge + 1]! - full.objectives[0]!) < 2e-8, `edge ${edge}: ${local.objectives[edge + 1]} vs ${full.objectives[0]}`);
  }
});

test("site-parallel all-message workers sum the same local objectives", async () => {
  const repeatedFasta = fastaText.replaceAll(/(^>[^\n]+\n)([^>]+)/gm, (_match, header: string, sequence: string) => {
    const clean = sequence.replaceAll(/\s+/g, "");
    return `${header}${clean.repeat(3)}\n`;
  });
  const repeatedAlignment = parseFasta(repeatedFasta);
  const repeatedF3x4 = countF3x4(repeatedAlignment);
  const repeatedFit: FittedModel = {
    ...fittedModel,
    f3x4: repeatedF3x4,
    codonEquilibrium: codonEquilibriumFromF3x4(repeatedF3x4),
  };
  const compiled = compileBsrelTree(tree);
  const models = compiled.edgeNodes.map((node) => branchModel(node.branchLength));
  const changed = { ...models[1]!, omegaPositive: 6.5 };
  const single = new BsrelLikelihood(new WasmBackend(), compiled, tree, encodeCodonTips(repeatedAlignment, tree), repeatedAlignment.codonSites, repeatedFit);
  const pool = new ParallelWasmBackend(2, 0);
  const parallel = new BsrelLikelihood(pool, compiled, tree, encodeCodonTips(repeatedAlignment, tree), repeatedAlignment.codonSites, repeatedFit);
  try {
    const expected = await single.evaluate(models, [{ edge: 1, model: changed }]);
    const observed = await parallel.evaluate(models, [{ edge: 1, model: changed }]);
    assert.ok(Math.abs(expected.objectives[0]! - observed.objectives[0]!) < 2e-8);
    assert.ok(Math.abs(expected.objectives[1]! - observed.objectives[1]!) < 2e-8);
    assert.equal(observed.backend, "wasm-parallel");
  } finally {
    await pool.dispose();
  }
});

test("fixed three-rate calibration and Holm correction are monotone", () => {
  assert.equal(bsrelPValue(0), 0.5);
  assert.ok(bsrelPValue(4) < bsrelPValue(1));
  const adjusted = holmBonferroni([0.01, 0.03, 0.2]);
  assert.deepEqual([...adjusted].map((value) => Number(value.toFixed(6))), [0.03, 0.06, 0.2]);
});

test("small fixed-complexity BS-REL analysis returns branch tests", async () => {
  const progress: Array<{ readonly stage: string; readonly fraction: number; readonly indeterminate: boolean }> = [];
  const result = await analyzeBsrel(fastaText, treeText, {
    backend: "wasm",
    fittedModel,
    alternativeIterations: 2,
    nullIterations: 2,
    maximumOmega: 50,
    onStage: (stage, fraction, detail) => progress.push({ stage, fraction, indeterminate: detail?.indeterminate === true }),
  });
  assert.equal(result.branches.length, tree.nodes.length - 1);
  assert.equal(result.diagnostics.testedBranches, result.branches.length);
  assert.equal(result.diagnostics.lrtCalibration, "0.50*chi2_0 + 0.05*chi2_1 + 0.45*chi2_2");
  assert.ok(Number.isFinite(result.alternativeLogLikelihood));
  assert.ok(result.branches.every((branch) => branch.pValueHolm !== null));
  assert.ok(result.branches.every((branch) => branch.likelihoodRatio === null || branch.likelihoodRatio >= 0));
  assert.ok(result.branches.every((branch) => branch.likelihoodRatio !== 0 || branch.pValue === 0.5));
  assert.ok(progress.some((event) => event.stage === "branch-alternative" && event.indeterminate));
  assert.ok(progress.some((event) => event.stage === "branch-alternative" && event.fraction > 0));
  assert.ok(progress.some((event) => event.stage === "branch-nulls" && event.indeterminate));
  assert.ok(progress.some((event) => event.stage === "branch-nulls" && event.fraction > 0));
});

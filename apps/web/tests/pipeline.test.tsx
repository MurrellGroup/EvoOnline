import assert from "node:assert/strict";
import test from "node:test";
import {
  decodePipelineShare,
  encodePipelineShare,
  matchPipelineTrees,
  parsePipelineDefinition,
  pipelineNodeStage,
  pipelineNodesCompatible,
  sortPipelineNodes,
  stringifyPipelineDefinition,
  type PipelineDefinition,
  type PipelineNode,
} from "../src/lib/pipeline.js";
import { createSimulationTruthRecombinationBundle } from "../src/lib/recombination-bundle.js";
import type { RecombinationCodonTreeSet } from "@phylo-workbench/model-diffubar/browser-source";
import type { SimulatedDataset } from "@phylo-workbench/model-simulator/browser-source";

interface NamedFile {
  readonly name: string;
  readonly webkitRelativePath?: string;
}

test("user trees match FASTA inputs by exact case-insensitive filename stem", () => {
  const files: NamedFile[] = [
    { name: "alpha.fasta", webkitRelativePath: "batch/alpha.fasta" },
    { name: "ALPHA.nwk", webkitRelativePath: "batch/trees/ALPHA.nwk" },
    { name: "beta.fa", webkitRelativePath: "batch/beta.fa" },
    { name: "unrelated.tree", webkitRelativePath: "batch/trees/unrelated.tree" },
  ];
  const matches = matchPipelineTrees(files);
  assert.equal(matches.length, 2);
  assert.equal(matches[0]?.status, "matched");
  assert.equal(matches[0]?.tree?.name, "ALPHA.nwk");
  assert.equal(matches[1]?.status, "missing");
});

test("duplicate matching tree stems are reported as ambiguous instead of selected silently", () => {
  const matches = matchPipelineTrees<NamedFile>([
    { name: "sample.fasta" },
    { name: "sample.nwk" },
    { name: "sample.tree" },
  ]);
  assert.equal(matches[0]?.status, "ambiguous");
  assert.deepEqual(matches[0]?.candidates.map((file) => file.name), ["sample.nwk", "sample.tree"]);
  assert.equal(matches[0]?.tree, undefined);
});

test("pipeline JSON and share links preserve method order and parameter values", () => {
  const definition: PipelineDefinition = {
    schemaVersion: 1,
    id: "pipeline-test",
    name: "Recombination then selection",
    execution: { maxCpus: 6 },
    nodes: [
      { id: "fasttree", kind: "fasttree", parameters: { model: "gtr", fastest: false } },
      { id: "fsart", kind: "model", modelId: "fsart", parameters: { window: 24 } },
      { id: "fubar", kind: "model", modelId: "fubar", parameters: { posteriorThreshold: 0.95 } },
    ],
  };
  assert.deepEqual(parsePipelineDefinition(stringifyPipelineDefinition(definition)), definition);
  assert.deepEqual(decodePipelineShare(encodePipelineShare(definition)), definition);
});

test("pipeline parser rejects invalid CPU budgets", () => {
  assert.throws(() => parsePipelineDefinition(JSON.stringify({
    schemaVersion: 1,
    id: "invalid-cpus",
    name: "Invalid CPU budget",
    execution: { maxCpus: 0 },
    nodes: [],
  })), /positive integer/u);
});

test("pipeline parser rejects a model component without a model id", () => {
  assert.throws(() => parsePipelineDefinition(JSON.stringify({
    schemaVersion: 1,
    id: "invalid",
    name: "Invalid",
    nodes: [{ id: "node", kind: "model", parameters: {} }],
  })), /no method identifier/u);
});

test("selection methods are terminal peers and never feed one another", () => {
  const fubar: PipelineNode = { id: "fubar", kind: "model", modelId: "fubar", parameters: {} };
  const diffubar: PipelineNode = { id: "diffubar", kind: "model", modelId: "diffubar", parameters: {} };
  assert.equal(pipelineNodeStage(fubar), "selection");
  assert.equal(pipelineNodeStage(diffubar), "selection");
  assert.equal(pipelineNodesCompatible(fubar, diffubar), false);
  assert.equal(pipelineNodesCompatible(diffubar, fubar), false);
});

test("typed source compatibility rejects scientifically invalid routes", () => {
  const fasttree: PipelineNode = { id: "fasttree", kind: "fasttree", parameters: {} };
  const userTrees: PipelineNode = { id: "user-trees", kind: "user-trees", parameters: {} };
  const fsart: PipelineNode = { id: "fsart", kind: "model", modelId: "fsart", parameters: {} };
  const fubar: PipelineNode = { id: "fubar", kind: "model", modelId: "fubar", parameters: {} };
  const diffubar: PipelineNode = { id: "diffubar", kind: "model", modelId: "diffubar", parameters: {} };
  const bsrel: PipelineNode = { id: "bsrel", kind: "model", modelId: "bsrel", parameters: {} };

  assert.equal(pipelineNodesCompatible(fasttree, fubar), true);
  assert.equal(pipelineNodesCompatible(fasttree, diffubar), false);
  assert.equal(pipelineNodesCompatible(userTrees, diffubar), true);
  assert.equal(pipelineNodesCompatible(fsart, fubar), true);
  assert.equal(pipelineNodesCompatible(fsart, bsrel), false);
  assert.equal(pipelineNodesCompatible(fasttree, fsart), false);
});

test("Simulator is an input and True tree is a simulator-truth source, not an inferred method", () => {
  const simulator: PipelineNode = { id: "simulator", kind: "model", modelId: "simulator", parameters: { simulatorConfig: "{}" } };
  const trueTree: PipelineNode = { id: "truth", kind: "true-tree", parameters: {} };
  const fasttree: PipelineNode = { id: "fasttree", kind: "fasttree", parameters: {} };
  const fubar: PipelineNode = { id: "fubar", kind: "model", modelId: "fubar", parameters: {} };
  const diffubar: PipelineNode = { id: "diffubar", kind: "model", modelId: "diffubar", parameters: {} };
  assert.equal(pipelineNodeStage(simulator), "input");
  assert.equal(pipelineNodeStage(trueTree), "source");
  assert.equal(pipelineNodesCompatible(trueTree, fubar), true);
  assert.equal(pipelineNodesCompatible(trueTree, diffubar), false);
  assert.deepEqual(sortPipelineNodes([fubar, trueTree, simulator, fasttree]).map((node) => node.id), ["simulator", "truth", "fasttree", "fubar"]);
});

test("pipeline stages sort sources and terminal methods without chaining peers", () => {
  const nodes: readonly PipelineNode[] = [
    { id: "fubar", kind: "model", modelId: "fubar", parameters: {} },
    { id: "fsart", kind: "model", modelId: "fsart", parameters: {} },
    { id: "diffubar", kind: "model", modelId: "diffubar", parameters: {} },
    { id: "user-trees", kind: "user-trees", parameters: {} },
  ];
  assert.deepEqual(sortPipelineNodes(nodes).map((node) => node.id), ["fsart", "user-trees", "fubar", "diffubar"]);
});

test("True tree bundles retain the exact simulator carrier genealogy and recombination events", () => {
  const treeSet: RecombinationCodonTreeSet = {
    schemaVersion: 1,
    sourceMethod: "simulation-truth",
    branchLengthSource: "method-final-trees",
    branchScalePolicy: "fixed-relative",
    codonAssignment: "middle-nucleotide",
    segments: [{ startCodon: 1, endCodon: 2, tree: "(A:1,B:1);" }],
  };
  const dataset = {
    id: "sim-1",
    seed: 1,
    tree: { newick: "(A:1,B:1);" },
    carrierTree: { newick: "((A:1,B:1):1,C:2);" },
    localTrees: [{ startCodon: 1, endCodon: 2, tree: { newick: "(A:1,B:1);" }, activeEventIds: [9] }],
    recombinationEvents: [{ id: 9, age: 1, recipientBranch: 1, donorBranch: 2, intervals: [{ startCodon: 1, endCodon: 1 }], breakpoints: [1], visibleAfterSubsampling: true }],
    hotspotWeights: [1],
    names: ["A", "B"],
    diagnostics: {},
  } as unknown as SimulatedDataset;
  const bundle = createSimulationTruthRecombinationBundle(dataset, treeSet, 6, 2);
  assert.equal(bundle.representation, "spr-history");
  assert.equal(bundle.history.kind, "spr-history");
  assert.equal(bundle.history.masterTree, dataset.carrierTree?.newick);
  assert.deepEqual(bundle.history.eventOccurrences, dataset.recombinationEvents);
});

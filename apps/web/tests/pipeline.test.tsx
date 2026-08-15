import assert from "node:assert/strict";
import test from "node:test";
import {
  decodePipelineShare,
  encodePipelineShare,
  matchPipelineTrees,
  parsePipelineDefinition,
  stringifyPipelineDefinition,
  type PipelineDefinition,
} from "../src/lib/pipeline.js";

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
    nodes: [
      { id: "fasttree", kind: "fasttree", parameters: { model: "gtr", fastest: false } },
      { id: "fsart", kind: "model", modelId: "fsart", parameters: { window: 24 } },
      { id: "fubar", kind: "model", modelId: "fubar", parameters: { posteriorThreshold: 0.95 } },
    ],
  };
  assert.deepEqual(parsePipelineDefinition(stringifyPipelineDefinition(definition)), definition);
  assert.deepEqual(decodePipelineShare(encodePipelineShare(definition)), definition);
});

test("pipeline parser rejects a model component without a model id", () => {
  assert.throws(() => parsePipelineDefinition(JSON.stringify({
    schemaVersion: 1,
    id: "invalid",
    name: "Invalid",
    nodes: [{ id: "node", kind: "model", parameters: {} }],
  })), /no method identifier/u);
});

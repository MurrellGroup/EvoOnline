import assert from "node:assert/strict";
import test from "node:test";
import { compatibleSources, nodeStage, parsePipelineDefinition } from "../src/pipeline.js";

test("browser schema-v1 pipelines retain parallel source and selection routes", () => {
  const definition = parsePipelineDefinition(JSON.stringify({
    schemaVersion: 1,
    id: "parallel",
    name: "Simulation truth and inference",
    nodes: [
      { id: "sim", kind: "model", modelId: "simulator", parameters: {} },
      { id: "truth", kind: "true-tree", parameters: {} },
      { id: "fast", kind: "fasttree", parameters: {} },
      { id: "fubar", kind: "model", modelId: "fubar", parameters: {} },
      { id: "flavor", kind: "model", modelId: "flavor", parameters: {} },
    ],
  }));
  assert.deepEqual(definition.nodes.map(nodeStage), ["input", "source", "source", "selection", "selection"]);
  const fubar = definition.nodes.find((node) => node.id === "fubar")!;
  assert.deepEqual(compatibleSources(fubar, definition.nodes).map((node) => node.id), ["truth", "fast"]);
});

test("a selection method without a compatible tree source is rejected", () => {
  assert.throws(() => parsePipelineDefinition(JSON.stringify({
    schemaVersion: 1,
    id: "invalid",
    name: "Invalid",
    nodes: [{ id: "fubar", kind: "model", modelId: "fubar", parameters: {} }],
  })), /no compatible tree-producing source/i);
});

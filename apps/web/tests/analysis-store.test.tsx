import assert from "node:assert/strict";
import test from "node:test";
import { deleteSavedAnalysis, listSavedAnalyses, saveAnalysis, type SavedAnalysis } from "../src/lib/analysis-store.js";

test("analysis persistence retains typed-array results across method switches", async () => {
  const id = `test-${Date.now()}-${Math.random()}`;
  const analysis: SavedAnalysis = {
    id,
    modelId: "fubar",
    title: "FUBAR · test.fasta",
    createdAt: Date.now(),
    parameters: { gridPoints: 2 },
    alignment: {
      id: "alignment-test", kind: "alignment", name: "test.fasta", sha256: "abc", createdAt: new Date().toISOString(),
      text: ">a\nATG\n>b\nATG\n", records: [{ name: "a", description: "", sequence: "ATG" }, { name: "b", description: "", sequence: "ATG" }],
      taxa: 2, sites: 3, aligned: true, divisibleByThree: true, alphabet: "nucleotide",
    },
    result: { posterior: Float32Array.of(0.25, 0.75) },
  };
  await saveAnalysis(analysis);
  const restored = (await listSavedAnalyses()).find((candidate) => candidate.id === id);
  assert.ok(restored);
  assert.deepEqual((restored.result as { posterior: Float32Array }).posterior, Float32Array.of(0.25, 0.75));
  await deleteSavedAnalysis(id);
  assert.equal((await listSavedAnalyses()).some((candidate) => candidate.id === id), false);
});

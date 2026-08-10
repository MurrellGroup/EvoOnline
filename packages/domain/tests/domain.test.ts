import assert from "node:assert/strict";
import test from "node:test";
import { createAlignmentArtifact, extractNewickTags, parseFastaRecords } from "../src/index.js";

test("inspects aligned codon FASTA", async () => {
  const artifact = await createAlignmentArtifact("tiny.fasta", ">a\nATGAAA\n>b\nATGAAG\n");
  assert.equal(artifact.taxa, 2);
  assert.equal(artifact.sites, 6);
  assert.equal(artifact.aligned, true);
  assert.equal(artifact.divisibleByThree, true);
  assert.equal(artifact.alphabet, "nucleotide");
});

test("rejects duplicate identifiers", () => {
  assert.throws(() => parseFastaRecords(">a\nAAA\n>a\nAAA\n"), /Duplicate/);
});

test("extracts stable tag names", () => {
  assert.deepEqual(extractNewickTags("(a{G2}:1,b{G1}:1){G1};"), ["G1", "G2"]);
});

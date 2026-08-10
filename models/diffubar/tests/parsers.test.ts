import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseFasta } from "../src/io/fasta.js";
import { parseTaggedNewick } from "../src/io/newick.js";
import { compileTree } from "../src/tree/compiler.js";

describe("input parsers", () => {
  it("parses and validates aligned codon FASTA", () => {
    const alignment = parseFasta(">a comment\nATG GCT\n>b\natggcc\n");
    assert.deepEqual(alignment.names, ["a", "b"]);
    assert.deepEqual(alignment.sequences, ["ATGGCT", "ATGGCC"]);
    assert.equal(alignment.codonSites, 2);
  });

  it("maps two tags and an untagged background", () => {
    const parsed = parseTaggedNewick("((a{G1}:0.1,b{G1}:0.2){G1}:0.3,c{G2}:0.4,d:0.5);");
    assert.deepEqual(parsed.tags, ["{G1}", "{G2}"]);
    assert.equal(parsed.hasBackground, true);
    assert.equal(parsed.classCount, 3);
    assert.deepEqual(parsed.tips.map((tip) => tip.name), ["a", "b", "c", "d"]);
    assert.deepEqual(parsed.tips.map((tip) => tip.branchClass), [0, 0, 1, 2]);
    const compiled = compileTree(parsed);
    assert.ok(compiled.registerNumber <= 3);
    assert.equal(compiled.ops.length % 4, 0);
  });

  it("converts FigTree color annotations in NEXUS", () => {
    const parsed = parseTaggedNewick(`#NEXUS
begin trees;
tree t = [&R] (a[&!color=#ff0000]:0.1,b[&!color=#0000ff]:0.2);
end;`);
    assert.equal(parsed.hasBackground, false);
    assert.deepEqual(parsed.tips.map((tip) => tip.branchClass), [0, 1]);
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import { createAlignmentArtifact, createTreeArtifact } from "@phylo-workbench/domain";
import { difFubarPlugin } from "../src/plugin.js";

const fasta = ">a description\nATGGCT\n>b\nATGGCC\n>c\nATGGCA\n>d\nATGGCG\n";
const newick = "((a{G1}:0.1,b{G1}:0.1){G1}:0.1,(c{G2}:0.1,d{G2}:0.1){G2}:0.1);";

test("plugin manifest drives defaults and accepts an analysis-ready workspace", async () => {
  const alignment = await createAlignmentArtifact("tiny.fasta", fasta);
  const tree = await createTreeArtifact("tiny.nwk", newick, "upload");
  assert.equal(difFubarPlugin.manifest.id, "diffubar");
  assert.equal(difFubarPlugin.defaultParameters().iterations, 2500);
  assert.deepEqual(difFubarPlugin.validate({ alignment, tree }), { ready: true, issues: [] });
});

test("plugin reports tree/alignment identifier disagreement", async () => {
  const alignment = await createAlignmentArtifact("tiny.fasta", fasta);
  const tree = await createTreeArtifact("tiny.nwk", newick.replace("d{G2}", "other{G2}"), "upload");
  const validation = difFubarPlugin.validate({ alignment, tree });
  assert.equal(validation.ready, false);
  assert.ok(validation.issues.some((issue) => issue.code === "TIP_NAME_MISMATCH"));
});

test("plugin prepares FigTree-colored NEXUS for the branch tagger", () => {
  const nexus = "#NEXUS\nbegin trees;\ntree TREE1 = [&R] (a[&!color=#ff0000]:0.1,b[&!color=#0000ff]:0.1);\nend;";
  const prepared = difFubarPlugin.prepareTreeInput?.(nexus);
  assert.match(prepared ?? "", /a\{G1\}/);
  assert.match(prepared ?? "", /b\{G2\}/);
});

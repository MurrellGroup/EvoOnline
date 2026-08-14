import assert from "node:assert/strict";
import test from "node:test";
import {
  insertSegmentConditionals,
  parseFasta,
  prepareRecombinationCodonTrees,
} from "../src/index.js";

test("segmented tree contracts cover every codon exactly once and preserve category-major layout", () => {
  const alignment = parseFasta(">a\nATGAAAAAG\n>b\nATGAAGAAG\n>c\nATAAAAAAA\n");
  const segments = prepareRecombinationCodonTrees(alignment, {
    schemaVersion: 1, sourceMethod: "fsart", branchLengthSource: "segment-ml", branchScalePolicy: "fixed-relative", codonAssignment: "middle-nucleotide",
    segments: [
      { startCodon: 1, endCodon: 1, tree: "((a:0.1,b:0.1):0.1,c:0.2);" },
      { startCodon: 2, endCodon: 3, tree: "((a:0.1,c:0.1):0.1,b:0.2);" },
    ],
  });
  assert.deepEqual(segments.map((segment) => [segment.startCodon, segment.endCodon, segment.alignment.codonSites]), [[1, 1, 1], [2, 3, 2]]);
  const target = new Float64Array(2 * 3);
  insertSegmentConditionals(target, Float64Array.of(10, 11, 20, 21), 2, 3, segments[1]!);
  assert.deepEqual(target, Float64Array.of(0, 10, 11, 0, 20, 21));
});

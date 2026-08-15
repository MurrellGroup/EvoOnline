import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RecombinationCodonTreeSet } from "@phylo-workbench/model-diffubar/browser-source";
import { RecombinationTreeMiniature, recombinationModeInfo } from "../src/components/RecombinationTreeSummary.js";
import {
  createProjectedRecombinationBundle,
  parseRecombinationTreeBundle,
  serializeRecombinationTreeBundle,
} from "../src/lib/recombination-bundle.js";

// Vite uses the automatic JSX runtime in the application build, while the
// direct Node/tsx test transform expects the classic React global.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

const independentTrees: RecombinationCodonTreeSet = {
  schemaVersion: 1,
  sourceMethod: "fsart",
  branchLengthSource: "segment-ml",
  branchScalePolicy: "fixed-relative",
  codonAssignment: "middle-nucleotide",
  segments: [
    { startCodon: 1, endCodon: 2, sourceNucleotideStart: 1, sourceNucleotideEnd: 6, tree: "((A:0.1,B:0.1):0.2,C:0.3);" },
    { startCodon: 3, endCodon: 4, sourceNucleotideStart: 7, sourceNucleotideEnd: 12, tree: "((A:0.1,C:0.1):0.2,B:0.3);" },
  ],
};

test("portable regional bundle round-trips its complete likelihood partition", () => {
  const original = createProjectedRecombinationBundle(independentTrees, 12, 3);
  const restored = parseRecombinationTreeBundle(serializeRecombinationTreeBundle(original), 4);
  assert.equal(restored.representation, "independent-regional-trees");
  assert.equal(restored.history.kind, "independent-regional-trees");
  assert.deepEqual(restored.codonTreeSet, independentTrees);
  assert.deepEqual(restored.breakpoints, [{ afterCodon: 2, afterNucleotide: 6 }]);
  assert.equal(recombinationModeInfo(restored).title, "Independent regional phylogenies");
});

test("legacy JEMSPR projections stay explicitly SPR-derived without inventing an event tape", () => {
  const linked: RecombinationCodonTreeSet = { ...independentTrees, sourceMethod: "jemspr", branchLengthSource: "jemspr-linked-ml" };
  const bundle = createProjectedRecombinationBundle(linked, 12, 3);
  assert.equal(bundle.representation, "spr-history");
  assert.equal(bundle.history.kind, "spr-history");
  if (bundle.history.kind !== "spr-history") return;
  assert.equal(bundle.history.sprModel, "flattened-regional-projection");
  assert.match(bundle.history.note ?? "", /legacy downstream tree partition/i);
});

test("imports reject an alignment-length mismatch", () => {
  const bundle = createProjectedRecombinationBundle(independentTrees, 12, 3);
  assert.throws(() => parseRecombinationTreeBundle(serializeRecombinationTreeBundle(bundle), 5), /covers 4 codons|contains 4 codons/);
});

test("compact schematic labels representation and breakpoint coordinates", () => {
  const bundle = createProjectedRecombinationBundle(independentTrees, 12, 3);
  const markup = renderToStaticMarkup(<RecombinationTreeMiniature bundle={bundle} />);
  assert.match(markup, /Independent regional tree partition/);
  assert.match(markup, />6<\/text>/);
  assert.match(markup, /R1/);
  assert.match(markup, /R2/);
});

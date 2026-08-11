import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReferenceMapFigure, type ReferenceMapFigureSettings } from "../src/features/reference-map/ReferenceMapFigure.js";
import { alignProfileToReference } from "../src/features/reference-map/reference-align.js";
import { buildDifFubarReferenceEvidence, buildFubarReferenceEvidence, DIFFUBAR_REFERENCE_HYPOTHESES, FUBAR_REFERENCE_HYPOTHESES } from "../src/features/reference-map/reference-hypotheses.js";
import { buildAlignmentMapColumns, buildReferenceDetectionMarks, buildReferenceMapColumns, insertionSuffix } from "../src/features/reference-map/reference-numbering.js";
import { parseReferenceSequence } from "../src/features/reference-map/reference-sequence.js";
import type { ReferenceAlignmentResult, ReferenceHypothesis } from "../src/features/reference-map/types.js";
import { buildAminoAcidProfile } from "../src/features/structure-mapping/sequence-profile.js";
import type { ProfileAlignment } from "../src/features/structure-mapping/types.js";

const PROFILE_FASTA = `>one
GCTTGTGATGAATTT
>two
GCTTGTGATGAATTT
`;

function alignmentFixture(): ProfileAlignment {
  return {
    chainId: "reference",
    score: 12,
    scorePerMappedResidue: 6,
    identity: 1,
    coverage: 0.4,
    mappedResidues: 2,
    siteToResidue: Int32Array.of(0, -1, -1, -1, 1),
    profileIndices: Int32Array.of(0, 1, 2, 3, 4),
    residueIndices: Int32Array.of(0, -1, -1, -1, 1),
    alignedProfile: "ACDEF",
    alignedChain: "A---F",
    matchLine: "|   |",
  };
}

test("reference parser auto-detects coding nucleotide and preserves protein input", () => {
  const nucleotide = parseReferenceSequence(">NC_000001 example\nATGAAAACC\n", "reference.fna", "auto");
  assert.equal(nucleotide.kind, "nucleotide");
  assert.equal(nucleotide.sequence, "MKT");
  assert.equal(nucleotide.sourceLength, 9);
  assert.equal(nucleotide.name, "NC_000001 example");

  const protein = parseReferenceSequence(">protein\nMK-TX*\n", "reference.faa", "protein");
  assert.equal(protein.kind, "protein");
  assert.equal(protein.sequence, "MKTX");
});

test("global profile alignment retains insertions on both sides", () => {
  const profile = buildAminoAcidProfile(`>one\nGCTTGTGAT\n`); // ACD
  const aligned = alignProfileToReference(profile, "AED", -1, -0.2);
  assert.equal(aligned.profileIndices.length, aligned.residueIndices.length);
  assert.equal(Array.from(aligned.profileIndices).includes(-1), true, "reference-only insertion is retained");
  assert.equal(Array.from(aligned.residueIndices).includes(-1), true, "profile-only insertion is retained");
  assert.equal(aligned.alignedProfile.replaceAll("-", ""), "ACD");
  assert.equal(aligned.alignedChain.replaceAll("-", ""), "AED");
});

test("reference numbering assigns alphabetic insertion suffixes without advancing the reference", () => {
  assert.equal(insertionSuffix(1), "A");
  assert.equal(insertionSuffix(3), "C");
  assert.equal(insertionSuffix(27), "AA");
  const columns = buildReferenceMapColumns(alignmentFixture(), 76);
  assert.deepEqual(columns.map((column) => column.coordinateLabel), ["76", "76A", "76B", "76C", "77"]);
  const marks = buildReferenceDetectionMarks(columns, [
    { site: 4, probabilities: { first: 0.99, second: 0.96 } },
  ], new Set(["first", "second"]), 0.95);
  assert.deepEqual(marks.map((mark) => [mark.hypothesisId, mark.coordinateLabel]), [["first", "76C"], ["second", "76C"]]);
});

test("alignment-only mode uses ordinary codon coordinates without requiring a reference", () => {
  const columns = buildAlignmentMapColumns(4);
  assert.deepEqual(columns.map((column) => column.coordinateLabel), ["1", "2", "3", "4"]);
  assert.deepEqual(columns.map((column) => column.profileSite), [1, 2, 3, 4]);
});

test("model adapters expose every posterior hypothesis as independently selectable evidence", () => {
  assert.deepEqual(DIFFUBAR_REFERENCE_HYPOTHESES.map((hypothesis) => hypothesis.id), ["omega1-greater", "omega2-greater", "omega1-positive", "omega2-positive"]);
  assert.deepEqual(FUBAR_REFERENCE_HYPOTHESES.map((hypothesis) => hypothesis.id), ["positive", "purifying"]);
  const difFubarEvidence = buildDifFubarReferenceEvidence({ sites: [{ site: 7, pOmega1Greater: 0.91, pOmega2Greater: 0.12, pOmega1Positive: 0.82, pOmega2Positive: 0.33, meanAlpha: 0.4, meanOmega1: 1.8, meanOmega2: 0.7 }] });
  assert.deepEqual(difFubarEvidence[0], { site: 7, probabilities: { "omega1-greater": 0.91, "omega2-greater": 0.12, "omega1-positive": 0.82, "omega2-positive": 0.33 } });
  const fubarEvidence = buildFubarReferenceEvidence({ sites: [{ site: 9, pPositive: 0.97, pPurifying: 0.02, meanAlpha: 0.4, meanBeta: 2.1, selection: "positive" }] });
  assert.deepEqual(fubarEvidence[0], { site: 9, probabilities: { positive: 0.97, purifying: 0.02 } });
});

test("reference figure places the pure reference above the profile and separates hypothesis lanes", () => {
  const profile = buildAminoAcidProfile(PROFILE_FASTA);
  const result: ReferenceAlignmentResult = {
    profile,
    reference: { name: "Reference strain", sequence: "AF", kind: "protein", sourceLength: 2 },
    alignment: alignmentFixture(),
  };
  const hypotheses: readonly ReferenceHypothesis[] = [
    { id: "first", label: "P(first)", shortLabel: "First", color: "#e64b50" },
    { id: "second", label: "P(second)", shortLabel: "Second", color: "#5148e5" },
  ];
  const settings: ReferenceMapFigureSettings = {
    title: "Reference-coordinate selection map",
    referenceLabel: "Reference",
    profileLabel: "AA profile",
    referenceStart: 76,
    startSite: 1,
    endSite: 5,
    threshold: 0.95,
    columnWidth: 16,
    logoHeight: 54,
    referenceHeight: 28,
    numberFontSize: 8,
    tickInterval: 10,
    showDetectionLabels: true,
    showGridlines: true,
    highlightDifferences: false,
    hypothesisColors: { first: "#e64b50", second: "#5148e5" },
    hypothesisLabels: { first: "First", second: "Second" },
  };
  const markup = renderToStaticMarkup(<ReferenceMapFigure
    profile={profile}
    referenceResult={result}
    evidenceSites={[{ site: 4, probabilities: { first: 0.99, second: 0.98 } }]}
    hypotheses={hypotheses}
    selectedHypothesisIds={new Set(["first", "second"])}
    settings={settings}
  />);
  assert.equal(markup.indexOf(">Reference</text>") < markup.indexOf(">AA profile</text>"), true);
  assert.equal((markup.match(/data-hypothesis=/g) ?? []).length, 2);
  assert.equal((markup.match(/data-coordinate="76C"/g) ?? []).length, 2);
  assert.match(markup, /rotate\(-90\)/);
  assert.match(markup, /data-reference-map="true"/);
  assert.equal(markup.includes("foreignObject"), false);
});

test("selection profile figure renders fully without a reference and labels alignment codons", () => {
  const profile = buildAminoAcidProfile(PROFILE_FASTA);
  const hypotheses: readonly ReferenceHypothesis[] = [
    { id: "first", label: "P(first)", shortLabel: "First", color: "#e64b50" },
  ];
  const settings: ReferenceMapFigureSettings = {
    title: "Alignment selection map",
    referenceLabel: "Reference",
    profileLabel: "AA profile",
    referenceStart: 1,
    startSite: 1,
    endSite: profile.columns.length,
    threshold: 0.95,
    columnWidth: 16,
    logoHeight: 54,
    referenceHeight: 28,
    numberFontSize: 8,
    tickInterval: 10,
    showDetectionLabels: true,
    showGridlines: true,
    highlightDifferences: false,
    hypothesisColors: { first: "#e64b50" },
    hypothesisLabels: { first: "First" },
  };
  const markup = renderToStaticMarkup(<ReferenceMapFigure
    profile={profile}
    evidenceSites={[{ site: 3, probabilities: { first: 0.99 } }]}
    hypotheses={hypotheses}
    selectedHypothesisIds={new Set(["first"])}
    settings={settings}
  />);
  assert.match(markup, /data-coordinate-mode="alignment"/);
  assert.match(markup, /data-coordinate="3"/);
  assert.match(markup, />Alignment codon<\/text>/);
  assert.equal(markup.includes(">Reference</text>"), false);
});

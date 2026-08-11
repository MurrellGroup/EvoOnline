import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { filterFubarSites, FubarResultsView } from "../src/components/FubarResultsView.js";
import { AMINO_ACID_GLYPHS } from "../src/features/structure-mapping/amino-acid-glyphs.js";
import { layoutLogoSegments, ProfileChainAlignmentPanel, profileLetterColor, rawLogoLetters } from "../src/features/structure-mapping/ProfileChainAlignment.js";
import { groupSurfaceViews, viewsForRepresentation } from "../src/features/structure-mapping/MolstarStructureViewer.js";
import { effectiveRepresentations, normalizeSurfaceOpacity, updateChainMode } from "../src/features/structure-mapping/StructureMappingPanel.js";
import { alignProfileToChain } from "../src/features/structure-mapping/profile-align.js";
import { buildAminoAcidProfile } from "../src/features/structure-mapping/sequence-profile.js";
import { parseMmcifChains, parsePdbChains } from "../src/features/structure-mapping/structure-parser.js";
import type { StructureChainView, StructureColorMode } from "../src/features/structure-mapping/types.js";
import type { FubarRunResult } from "../src/types.js";

const FASTA = `>one
ATGAAAACT
>two
ATGAAGACT
`;

test("translated codon columns form an amino-acid profile and locally map to a structure chain", () => {
  const profile = buildAminoAcidProfile(FASTA);
  assert.equal(profile.columns.map((column) => column.consensus).join(""), "MKT");
  assert.equal(profile.columns[1]?.validCount, 2);
  const chain = {
    id: "A::A",
    label: "A",
    sequence: "GMKTA",
    residues: Array.from("GMKTA", (aminoAcid, index) => ({
      chainId: "A",
      authChainId: "A",
      labelSeqId: index + 1,
      authSeqId: index + 10,
      insertionCode: "",
      compId: aminoAcid,
      aminoAcid,
    })),
  } as const;
  const alignment = alignProfileToChain(profile, chain);
  assert.equal(alignment.mappedResidues, 3);
  assert.equal(alignment.identity, 1);
  assert.deepEqual(Array.from(alignment.siteToResidue), [1, 2, 3]);
  assert.deepEqual(Array.from(alignment.profileIndices), [0, 1, 2]);
  assert.deepEqual(Array.from(alignment.residueIndices), [1, 2, 3]);
  assert.equal(alignment.alignedProfile, "MKT");
  assert.equal(alignment.alignedChain, "MKT");
});

test("raw profile-logo mass retains gaps in its denominator", () => {
  const profile = buildAminoAcidProfile(`>observed\nGCT\n>gap\n---\n`);
  const letters = rawLogoLetters(profile.columns[0]!, profile.sequenceCount);
  assert.deepEqual(letters.map((letter) => letter.aminoAcid), ["A"]);
  assert.equal(letters[0]?.mass, 0.5);
  assert.equal(letters.reduce((sum, letter) => sum + letter.mass, 0), 0.5);
});

test("stacked logo glyphs exactly share the same vertical envelope as one pure glyph", () => {
  assert.equal(Object.keys(AMINO_ACID_GLYPHS).join(""), "ARNDCQEGHILKMFPSTWYV");
  const pure = layoutLogoSegments([{ aminoAcid: "A", mass: 1 }], 1, 48);
  const mixed = layoutLogoSegments([{ aminoAcid: "A", mass: 0.5 }, { aminoAcid: "R", mass: 0.3 }, { aminoAcid: "G", mass: 0.2 }], 1, 48);
  assert.deepEqual(pure, [{ aminoAcid: "A", mass: 1, y: 1, height: 48 }]);
  assert.equal(mixed.reduce((sum, segment) => sum + segment.height, 0), 48);
  assert.equal(Math.min(...mixed.map((segment) => segment.y)), 1);
  assert.equal(Math.max(...mixed.map((segment) => segment.y + segment.height)), 49);
  for (let index = 1; index < mixed.length; index += 1) assert.equal(mixed[index]!.y + mixed[index]!.height, mixed[index - 1]!.y);
  assert.equal(profileLetterColor("A", "A", true), "#dce2df");
  assert.notEqual(profileLetterColor("R", "A", true), "#dce2df");
});

test("chain checkboxes implement mapped, context, and hidden modes", () => {
  assert.equal(updateChainMode("hidden", "show", true), "context");
  assert.equal(updateChainMode("context", "map", true), "mapped");
  assert.equal(updateChainMode("hidden", "map", true), "mapped");
  assert.equal(updateChainMode("mapped", "map", false), "context");
  assert.equal(updateChainMode("mapped", "show", false), "hidden");
});

test("a global surface-opacity override leaves saved per-chain settings intact", () => {
  const perChain = { cartoon: true, atoms: false, surface: true, surfaceOpacity: 0.35 } as const;
  assert.equal(effectiveRepresentations(perChain, undefined), perChain);
  assert.deepEqual(effectiveRepresentations(perChain, 0.8), { ...perChain, surfaceOpacity: 0.8 });
  assert.equal(normalizeSurfaceOpacity(-0.2), 0);
  assert.equal(normalizeSurfaceOpacity(1.4), 1);
  assert.equal(normalizeSurfaceOpacity(0.333), 0.33);
});

test("profile alignment panels render every mapped chain with raw occupancy", () => {
  const profile = buildAminoAcidProfile(FASTA);
  const makeChain = (id: string, label: string) => ({
    id,
    label,
    sequence: "MKT",
    residues: Array.from("MKT", (aminoAcid, index) => ({
      chainId: label,
      authChainId: label,
      labelSeqId: index + 1,
      authSeqId: index + 1,
      insertionCode: "",
      compId: aminoAcid,
      aminoAcid,
    })),
  });
  const views: StructureChainView[] = [makeChain("A::A", "A"), makeChain("B::B", "B")].map((chain) => ({
    chain,
    alignment: alignProfileToChain(profile, chain),
    mode: "mapped",
    representations: { cartoon: chain.label === "A", atoms: false, surface: chain.label === "B", surfaceOpacity: chain.label === "A" ? 0.35 : 0.8 },
  }));
  const colorMode: StructureColorMode = {
    id: "detected",
    label: "Detected",
    description: "Detected sites",
    color: (site) => site.detected ? "#ef5350" : "#dce3df",
    valueLabel: (site) => site.detected ? "detected" : "not detected",
    legend: [],
  };
  const markup = renderToStaticMarkup(<ProfileChainAlignmentPanel profile={profile} chainViews={views} sites={[{ site: 2, detected: true, direction: "positive", values: {} }]} colorMode={colorMode} />);
  assert.match(markup, /Chain A/);
  assert.match(markup, /Chain B/);
  assert.match(markup, /raw frequency · no entropy scaling/);
  assert.match(markup, /data-occupancy="1\.000000"/);
  assert.match(markup, /Scrollable full profile alignment/);
  assert.match(markup, /Horizontal scale/);
  assert.match(markup, /Highlight differences/);
  assert.equal(/Previous|Next|60 columns/.test(markup), false);
  assert.equal((markup.match(/profile-chain-alignment__chain-letter/g) ?? []).length, 6);
  assert.match(markup, /<path d="M/);
  assert.deepEqual(viewsForRepresentation(views, "cartoon").map((view) => view.chain.label), ["A"]);
  assert.deepEqual(viewsForRepresentation(views, "surface").map((view) => view.chain.label), ["B"]);
  const twoSurfaces = views.map((view) => ({ ...view, representations: { ...view.representations, surface: true } }));
  assert.deepEqual(groupSurfaceViews(twoSurfaces).map((group) => [group.opacity, group.views.map((view) => view.chain.label)]), [[0.35, ["A"]], [0.8, ["B"]]]);
  const sharedOpacity = twoSurfaces.map((view) => ({ ...view, representations: { ...view.representations, surfaceOpacity: 0.55 } }));
  assert.deepEqual(groupSurfaceViews(sharedOpacity).map((group) => [group.opacity, group.views.map((view) => view.chain.label)]), [[0.55, ["A", "B"]]]);
});

test("PDB and mmCIF parsers retain coordinate residue identifiers", () => {
  const pdb = [
    "ATOM      1  CA  MET A  10      11.000  12.000  13.000  1.00 20.00           C  ",
    "ATOM      2  CA  LYS A  11A     12.000  13.000  14.000  1.00 20.00           C  ",
    "ATOM      3  CA  GLY B   1      13.000  14.000  15.000  1.00 20.00           C  ",
  ].join("\n");
  const pdbChains = parsePdbChains(pdb);
  assert.equal(pdbChains.length, 2);
  assert.equal(pdbChains[0]?.sequence, "MK");
  assert.equal(pdbChains[0]?.residues[1]?.insertionCode, "A");

  const cif = `data_demo
loop_
_atom_site.group_PDB
_atom_site.id
_atom_site.type_symbol
_atom_site.label_atom_id
_atom_site.label_alt_id
_atom_site.label_comp_id
_atom_site.label_asym_id
_atom_site.label_seq_id
_atom_site.auth_asym_id
_atom_site.auth_seq_id
_atom_site.pdbx_PDB_ins_code
_atom_site.pdbx_PDB_model_num
ATOM 1 C CA . MET X 1 A 10 ? 1
ATOM 2 C CA . LYS X 2 A 11 A 1
#
`;
  const cifChains = parseMmcifChains(cif);
  assert.equal(cifChains.length, 1);
  assert.equal(cifChains[0]?.sequence, "MK");
  assert.equal(cifChains[0]?.residues[0]?.chainId, "X");
  assert.equal(cifChains[0]?.residues[0]?.authChainId, "A");
  assert.equal(cifChains[0]?.residues[1]?.labelSeqId, 2);
});

test("FUBAR results expose positive and purifying visibility controls by default", () => {
  const result: FubarRunResult = {
    sites: [
      { site: 1, pPositive: 0.98, pPurifying: 0.01, meanAlpha: 0.3, meanBeta: 2.1, selection: "positive" },
      { site: 2, pPositive: 0.02, pPurifying: 0.97, meanAlpha: 2.2, meanBeta: 0.4, selection: "purifying" },
    ],
    positiveSites: [1],
    purifyingSites: [2],
    posterior: {
      siteCount: 2,
      gridSize: 2,
      gridValues: Float64Array.of(0.1, 2),
      surfaces: Float32Array.of(0.05, 0.85, 0.05, 0.05, 0.05, 0.05, 0.85, 0.05),
      alpha: Float32Array.of(0.9, 0.1, 0.1, 0.9),
      beta: Float32Array.of(0.1, 0.9, 0.9, 0.1),
    },
    backend: "wasm-parallel",
    timings: { totalMs: 25 },
    diagnostics: { taxa: 2, codonSites: 2, categories: 4, treeRegisterNumber: 2, precision: "f64", inferenceMethod: "dirichlet-em", inferenceIterations: 12, inferenceBurnin: 0, inferenceLogLikelihood: -2.3 },
    tree: "(one:0.1,two:0.1);",
    csv: "Codon Sites\n1\n2\n",
  };
  const markup = renderToStaticMarkup(<FubarResultsView result={result} threshold={0.95} alignment={FASTA} />);
  assert.match(markup, /Show selection directions/);
  assert.match(markup, /Positive selection/);
  assert.match(markup, /Purifying selection/);
  assert.equal((markup.match(/type="checkbox" checked=""/g) ?? []).length >= 2, true);
  assert.match(markup, /Map selection onto a protein structure/);
  assert.match(markup, /Align selection results to a reference sequence/);
  assert.deepEqual(filterFubarSites(result.sites, new Set([1]), new Set([2]), false, true, false).map((site) => site.site), [1]);
  assert.deepEqual(filterFubarSites(result.sites, new Set([1]), new Set([2]), false, false, true).map((site) => site.site), [2]);
  assert.deepEqual(filterFubarSites(result.sites, new Set([1]), new Set([2]), false, true, true).map((site) => site.site), [1, 2]);
});

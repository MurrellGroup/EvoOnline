import assert from "node:assert/strict";
import test from "node:test";
import React, { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DEFAULT_LABELS,
  DifFubarVisualizations,
  PosteriorMarginalFigure,
} from "../src/components/DifFubarVisualizations.js";
import type { DifFubarRunResult } from "../src/types.js";
import { FubarVisualizations } from "../src/components/FubarVisualizations.js";
import { PhylogramFigure } from "../src/components/PhylogramFigure.js";
import type { FubarRunResult } from "../src/types.js";
import { ApproximateFelResults, approximateFelCall } from "../src/components/ApproximateFelResults.js";
import { normalizeCommittedNumberDraft } from "../src/components/CommittedNumberInput.js";
import { BsrelResultsView } from "../src/components/BsrelResultsView.js";
import type { BsrelRunResult } from "../src/types.js";
import { BameVisualizations } from "../src/components/BameVisualizations.js";
import type { FameRunResult, FlavorRunResult } from "../src/types.js";
import { GlobalGammaResultsView } from "../src/components/GlobalGammaResultsView.js";
import type { GlobalGammaRunResult } from "../src/types.js";
import { CladeShiftResultsView } from "../src/components/CladeShiftResultsView.js";
import type { CladeShiftRunResult } from "../src/types.js";
import { FsartResultsView } from "../src/components/FsartResultsView.js";
import { MosaicSprResultsView } from "../src/components/MosaicSprResultsView.js";
import { JemsprResultsView } from "../src/components/JemsprResultsView.js";
import { alignComparisonTrees, countOrderCrossings } from "../src/lib/tree-comparison.js";
import type { FsartAnalysisResult } from "@phylo-workbench/model-fsart/browser-source";
import type { MosaicSprAnalysisResult } from "@phylo-workbench/model-mosaicspr/browser-source";
import { analyzeJemspr } from "@phylo-workbench/model-jemspr/browser-source";
import { modelRegistry } from "../src/model-registry.js";
import { createRecombinationCodonTreeSet } from "../src/lib/recombination-handoff.js";
import { displayMaskPath, layoutPolishedSprTree, parseJemsprSwitchingNetwork } from "../src/lib/jemspr-visual.js";
import { displayNetwork } from "@phylo-workbench/model-jemspr/browser-source";

// The application build uses Vite's automatic JSX runtime; tsx's direct Node
// test transform still emits the classic global for several legacy fixtures.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("generic recombination handoff assigns breakpoint-crossing codons by their middle nucleotide", () => {
  const first = "((a:0.1,b:0.1):0.1,c:0.2);";
  const second = "((a:0.2,c:0.1):0.1,b:0.2);";
  const treeSet = createRecombinationCodonTreeSet("future-recombination-detector", "segment-ml", [
    { start: 1, end: 4, tree: first },
    { start: 5, end: 9, tree: second },
  ], 9);
  assert.deepEqual(treeSet.segments.map((segment) => [segment.startCodon, segment.endCodon, segment.tree]), [[1, 1, first], [2, 3, second]]);
  assert.equal(treeSet.sourceMethod, "future-recombination-detector");
  assert.equal(treeSet.branchScalePolicy, "fixed-relative");
});

test("FSART and MosaicSPR are separately registered methods with non-overlapping SPR controls", () => {
  const fsart = modelRegistry.find((entry) => entry.plugin.manifest.id === "fsart");
  const mosaic = modelRegistry.find((entry) => entry.plugin.manifest.id === "mosaic-spr");
  assert.ok(fsart);
  assert.ok(mosaic);
  assert.notEqual(fsart.plugin, mosaic.plugin);
  assert.equal(fsart.plugin.manifest.parameters.some((parameter) => parameter.id === "maximumSprStates"), false);
  assert.equal(mosaic.plugin.manifest.parameters.some((parameter) => parameter.id === "maximumSprStates"), true);
});

test("JEMSPR is a third independent alignment-only method with no proposal/FastTree-topology controls and an explicit linked-ML stage", () => {
  const jemspr = modelRegistry.find((entry) => entry.plugin.manifest.id === "jemspr");
  assert.ok(jemspr);
  assert.deepEqual(jemspr.plugin.manifest.inputSlots.map((slot) => slot.id), ["alignment"]);
  assert.equal(jemspr.plugin.manifest.parameters.some((parameter) => /triplet|fasttree|proposal/i.test(parameter.id)), false);
  assert.ok(jemspr.plugin.manifest.parameters.some((parameter) => parameter.id === "overlapCap"));
  assert.ok(jemspr.plugin.manifest.parameters.some((parameter) => parameter.id === "maximumReticulations"));
  assert.ok(jemspr.plugin.manifest.parameters.some((parameter) => parameter.id === "linkedLikelihood"));
  assert.ok(jemspr.plugin.manifest.parameters.some((parameter) => parameter.id === "likelihoodRefinement"));
});

test("deferred number fields accept replacement text and validate only when committed", () => {
  assert.equal(normalizeCommittedNumberDraft("", 17, 1, 100), 17);
  assert.equal(normalizeCommittedNumberDraft("42", 17, 1, 100), 42);
  assert.equal(normalizeCommittedNumberDraft("999", 17, 1, 100), 100);
  assert.equal(normalizeCommittedNumberDraft("4.9", 17, 1, 100), 4);
});

test("linked FSART trees are rerooted and flipped to eliminate avoidable taxon crossings", () => {
  const aligned = alignComparisonTrees([
    "(((a:1,b:1):1,c:1):1,(d:1,e:1):1);",
    "((e:1,d:1):1,(c:1,(b:1,a:1):1):1);",
  ]);
  assert.equal(aligned.length, 2);
  assert.equal(countOrderCrossings(aligned[0]!.tipOrder, aligned[1]!.tipOrder), 0);
  assert.deepEqual(aligned[0]!.tipOrder.slice().sort(), ["a", "b", "c", "d", "e"]);
  assert.ok(aligned.every((layout) => layout.rerootedOn.length === 2));
  assert.throws(() => alignComparisonTrees(["((a,b),c);", "((a,b),d);"]), /same uniquely named taxa/);
});

test("FSART renders consensus proposals, triplet topology evidence, topology HMM, and Viterbi trees as SVG", () => {
  const trace = {
    positions: Uint32Array.of(2, 5, 8, 11, 14, 17, 20, 23),
    observations: Uint8Array.of(0, 0, 0, 0, 1, 1, 1, 1),
    mapStates: Uint8Array.of(0, 0, 0, 0, 1, 1, 1, 1),
    switchPosterior: Float32Array.of(0.01, 0.02, 0.08, 0.94, 0.06, 0.02, 0.01),
  };
  const representative = {
    taxa: [0, 1, 2] as const, taxaNames: ["a", "b", "c"] as const,
    breakpoint: 13, eventBoundary: 4, informativeEvents: 8,
    leftState: 0 as const, rightState: 1 as const,
    leftCounts: [4, 0, 0] as const, rightCounts: [0, 4, 0] as const,
    g2: 22.1, logP: -11.05, rawP: 1.59e-5, adjustedP: 0.002,
    evidence: 2.699, intervalLow: 11, intervalHigh: 16, switchPosterior: 0.94,
    emissionAccuracy: 0.94, switchingRates: [{ expectedSwitches: 0.5, posterior: 0.25 }, { expectedSwitches: 1, posterior: 0.75 }], trace,
  };
  const result: FsartAnalysisResult = {
    method: "fsart",
    breakpoints: [{ id: "BP1", rank: 1, breakpoint: 13, intervalLow: 11, intervalHigh: 16, supportLow: 10, supportHigh: 18, evidence: 2.699, consensusScore: 5.2, strengthScore: 4.1, adjustedP: 0.002, supportTriplets: 3, supportTaxa: 4, representative, memberIndexes: [0] }],
    tripletSignals: [representative],
    partition: {
      status: "complete", criterion: "aicc", criterionValue: 210.4,
      segments: [
        { id: "segment-1-13", start: 1, end: 13, logLikelihood: -70, tree: "((a:0.1,b:0.1):0.1,c:0.2);", variableSites: 6, elapsedMs: 5 },
        { id: "segment-14-24", start: 14, end: 24, logLikelihood: -60, tree: "((a:0.1,c:0.1):0.1,b:0.2);", variableSites: 7, elapsedMs: 5 },
      ],
      candidateTrees: [
        { id: "segment-1-13", start: 1, end: 13, logLikelihood: -70, tree: "((a:0.1,b:0.1):0.1,c:0.2);", variableSites: 6, elapsedMs: 5 },
        { id: "segment-14-24", start: 14, end: 24, logLikelihood: -60, tree: "((a:0.1,c:0.1):0.1,b:0.2);", variableSites: 7, elapsedMs: 5 },
      ],
      steps: [{ candidateRank: 1, breakpoint: 13, accepted: true, reason: "AICc improved.", criterionBefore: 230, criterionAfter: 210.4, deltaCriterion: 19.6, logLikelihoodBefore: -150, logLikelihoodAfter: -130, parameterCountBefore: 14, parameterCountAfter: 28, consecutiveFailures: 0 }],
      acceptedBreakpoints: [13], rejectedBreakpoints: [], fastTreeVersion: "FastTree 2.1.11 bioWASM",
    },
    treeHmm: {
      status: "complete", criterion: "aicc", criterionValue: 190, nullCriterionValue: 230, deltaCriterion: 40,
      logLikelihood: -70, integratedLogEvidence: -71, nullLogLikelihood: -100, parameterCount: 20, nullParameterCount: 12,
      sites: 24,
      states: [
        { id: "T1", tree: "((a,b),c);", topologySignature: "t1", sourceStart: 1, sourceEnd: 13, weight: 0.5, occupancy: 0.5, expectedSites: 12, color: "#176b87" },
        { id: "T2", tree: "((a,c),b);", topologySignature: "t2", sourceStart: 14, sourceEnd: 24, weight: 0.5, occupancy: 0.5, expectedSites: 12, color: "#d5673f" },
      ],
      statePosterior: Float32Array.from([...Array(12).fill(0.98), ...Array(12).fill(0.02), ...Array(12).fill(0.02), ...Array(12).fill(0.98)]),
      mapState: Uint16Array.from([...Array(12).fill(0), ...Array(12).fill(1)]),
      switchPosterior: Float32Array.from([...Array(11).fill(0.01), 0.92, ...Array(11).fill(0.01)]),
      switchIntervals: [{ rank: 1, breakpoint: 12, intervalLow: 11, intervalHigh: 14, peakProbability: 0.92, expectedSwitchMass: 1.02 }],
      switchingRates: [{ expectedResets: 1, transitionProbability: 0.04, logLikelihood: -70, posterior: 1 }],
      expectedSwitches: 1.02, searchSteps: [],
      subsetSearch: {
        algorithm: "beam-forward-floating", evaluatedSubsets: 3, beamWidth: 4, maximumStates: 2,
        selectedTreeIds: ["T1", "T2"], selectedProfileIndexes: [0, 1], criterionValue: 192, nullCriterionValue: 230,
        converged: true, steps: [{ round: 0, move: "seed", treeIds: ["T1", "T2"], criterionValue: 192, deltaCriterion: 38 }],
        hypotheses: [
          { key: "0,1", treeIds: ["T1", "T2"], profileIndexes: [0, 1], stateCount: 2, logLikelihood: -72, criterionValue: 192, deltaFromBest: 0, parameterCount: 20, expectedResets: 1, exactLogLikelihood: -70, exactCriterionValue: 190 },
          { key: "0", treeIds: ["T1"], profileIndexes: [0], stateCount: 1, logLikelihood: -100, criterionValue: 230, deltaFromBest: 38, parameterCount: 12, expectedResets: 0, exactLogLikelihood: -100, exactCriterionValue: 230 },
          { key: "1", treeIds: ["T2"], profileIndexes: [1], stateCount: 1, logLikelihood: -105, criterionValue: 240, deltaFromBest: 48, parameterCount: 12, expectedResets: 0 },
        ],
        transitions: [{ fromKey: "0", toKey: "0,1", move: "add", phase: "beam" }],
        nullKey: "0", selectedKey: "0,1", exactVerifiedKeys: ["0", "0,1"], exactSelectedKey: "0,1", finalSelectedKey: "0,1", elapsedMs: 2,
      },
      fastTreeMs: 10, hmmMs: 2,
    },
    treeHmmProfiles: [
      { id: "T1", sourceStart: 1, sourceEnd: 13, tree: "((a:0.1,b:0.1):0.1,c:0.2);", topologySignature: "t1", logLikelihood: -70, siteLogLikelihoods: Float64Array.from([...Array(12).fill(-1), ...Array(12).fill(-5)]), elapsedMs: 2 },
      { id: "T2", sourceStart: 14, sourceEnd: 24, tree: "((a:0.1,c:0.1):0.1,b:0.2);", topologySignature: "t2", logLikelihood: -70, siteLogLikelihoods: Float64Array.from([...Array(12).fill(-5), ...Array(12).fill(-1)]), elapsedMs: 2 },
    ],
    topologyBankAudit: { familyFits: 3, resolvedFits: 3, unresolvedFits: 0, distinctResolvedTopologies: 2, retainedFullTreeFits: 2, truncatedFullTreeFits: 0, failedProfileScores: 0, maximumAiccStates: 1, fastTreeParallelism: 2 },
    discordantClades: [{ betweenSegments: ["segment-1-13", "segment-14-24"], direction: "lost", taxa: ["a", "b"], size: 2 }],
    diagnostics: { taxa: 3, sites: 24, variableSites: 18, totalTriplets: 1, scannedTriplets: 1, tripletSampling: "exhaustive", pairCoverageGuaranteed: true, totalTaxonPairs: 3, informativeTriplets: 1, testedBoundaries: 10, scanWindow: 4, minimumTreeSpan: 12, expectedVariableSitesPerMinimumSpan: 9, parallelWorkers: 1, multipleTesting: "none-ranked-candidate-generation", breakpointUncertainty: "three-state-burt-style-hmm-rate-marginalization", intervalConditioning: "candidate-window-local-posterior-basin", exactBurtParity: false, baumWelch: false, scanner: "bitset-informative-event-g-test", pairEqualityCache: true, bitsetWords: 1 },
    timings: { totalMs: 120 }, breakpointCsv: "Rank\n1\n", partitionCsv: "Breakpoint\n13\n", treeHmmCsv: "Site\n1\n",
  };
  const markup = renderToStaticMarkup(<FsartResultsView result={result} />);
  assert.match(markup, /Fast Stepwise Approximate Recombination Test/);
  assert.match(markup, /without a multiple-comparisons admission gate/);
  assert.match(markup, /Credible interval/);
  assert.match(markup, /Approximate GARD competitor/);
  assert.match(markup, /Conservative IC search: topology posterior and switching path/);
  assert.match(markup, /Low-switch Viterbi retention/);
  assert.match(markup, /Searched topology-subset landscape/);
  assert.match(markup, /Re-estimate trees \+ polish breakpoints/);
  assert.match(markup, /AICc feasibility warning/);
  assert.match(markup, /final automatic/);
  assert.match(markup, /linked topology comparison/);
  assert.match(markup, /Triplet topology trace/);
  assert.match(markup, /Refined Viterbi tree reconstruction/);
  assert.match(markup, /Exploratory participating-subtree candidates/);
  assert.match(markup, /FastTree 2.1.11 bioWASM/);
  assert.match(markup, /Continue with codon site analysis/);
  assert.ok((markup.match(/Export SVG/g) ?? []).length >= 5);
});

test("MosaicSPR is a separate result studio with implied regional trees, taxon links, and an executable edit tape", () => {
  const result: MosaicSprAnalysisResult = {
    method: "mosaic-spr",
    taxa: 4,
    sites: 24,
    variableSites: 18,
    proposals: [{ id: "BP1", rank: 1, breakpoint: 12, intervalLow: 10, intervalHigh: 14, supportLow: 9, supportHigh: 15, consensusScore: 7.2, evidence: 3.1, supportTriplets: 4, supportTaxa: 4 }],
    proposalDiagnostics: { source: "fsart-triplet-plus-overlap", scannedTriplets: 4, informativeTriplets: 4, testedBoundaries: 18, pairCoverageGuaranteed: true, minimumTreeSpan: 8 },
    draftTrees: [
      { id: "GLOBAL", kind: "global", start: 1, end: 24, tree: "((a:0.1,b:0.1):0.1,(c:0.1,d:0.1):0.1);", logLikelihood: -120, elapsedMs: 4, topologySignature: "global" },
      { id: "S2", kind: "segment", start: 13, end: 24, tree: "((a:0.1,c:0.1):0.1,(b:0.1,d:0.1):0.1);", logLikelihood: -54, elapsedMs: 3, topologySignature: "local" },
    ],
    reconstruction: {
      status: "complete", scoreKind: "fitch-parsimony-mdl", objective: 31.2, parsimony: 28, nullParsimony: 35,
      breakpointPenalty: 1.2, sprPenalty: 1.8, masterPenalty: 0.45, minimumRunLength: 8,
      initialSeedStateId: "S1", masterStateId: "S2", masterChangedFromSeed: true,
      states: [
        { id: "S1", tree: "((a:0.1,b:0.1):0.1,(c:0.1,d:0.1):0.1);", topologySignature: "s1", seedDistance: 0, parsimony: 35, occupiedSites: 12, color: "#156f66" },
        { id: "S2", tree: "((a:0.1,c:0.1):0.1,(b:0.1,d:0.1):0.1);", topologySignature: "s2", seedDistance: 1, parsimony: 34, occupiedSites: 12, color: "#e0664f" },
      ],
      runs: [
        { id: "R1", start: 1, end: 12, stateId: "S1", stateIndex: 0, parsimony: 14 },
        { id: "R2", start: 13, end: 24, stateId: "S2", stateIndex: 1, parsimony: 14 },
      ],
      derivations: [
        { stateId: "S1", occupiedSites: 12, sprDistanceFromMaster: 1, edits: [{ step: 1, fromStateId: "S2", toStateId: "S1", prunedTaxa: ["a"], sourceSplit: ["a"], sourceAttachmentSplit: ["b"], destinationSplit: ["c"] }], alternativeShortestScripts: 1, alternativesCapped: false },
        { stateId: "S2", occupiedSites: 12, sprDistanceFromMaster: 0, edits: [], alternativeShortestScripts: 1, alternativesCapped: false },
      ],
      events: [{ breakpoint: 12, fromStateId: "S1", toStateId: "S2", sprDistance: 1, edits: [{ step: 1, fromStateId: "S1", toStateId: "S2", prunedTaxa: ["a"], sourceSplit: ["a"], sourceAttachmentSplit: ["c"], destinationSplit: ["b"] }], alternativeShortestScripts: 1, alternativesCapped: false }],
      iterations: [{ start: 1, iteration: 1, topologyStates: 2, occupiedStates: 2, candidatesEnumerated: 12, candidatesScored: 12, candidatesAdded: 1, objective: 31.2, improvement: 4.1, masterStateId: "S2", elapsedMs: 3 }],
      certificate: { globalOptimal: false, completeOneSprNeighborhood: false, scope: "budgeted-column-generation", searchedStarts: 2, topologyStates: 2, graphEdges: 1, unconnectedSeedTopologies: 0, message: "Budgeted topology-space search." },
      elapsedMs: 8, message: "Two local topology runs with one explicit SPR edit.",
    },
    fastTreeVersion: "FastTree 2.1.11 bioWASM",
    timings: { proposalMs: 3, fastTreeMs: 7, searchMs: 8, totalMs: 18 },
    eventCsv: "Breakpoint after site\n12\n",
  };
  const markup = renderToStaticMarkup(<MosaicSprResultsView result={result} />);
  assert.match(markup, /MosaicSPR/);
  assert.match(markup, /Regions and implied phylogenies/);
  assert.match(markup, /implied by replaying MosaicSPR/);
  assert.match(markup, /Select all regions/);
  assert.match(markup, /Matching-taxon links/);
  assert.match(markup, /Breakpoint-indexed SPR edit tape/);
  assert.match(markup, /Master-to-local derivations/);
  assert.match(markup, /Event CSV/);
  assert.match(markup, /Continue with codon site analysis/);
  assert.ok((markup.match(/Export SVG/g) ?? []).length >= 2);
});

test("JEMSPR renders coherent event lanes, linked implied trees, and the compiled switching DAG as independent SVGs", async () => {
  const length = 80;
  const sequences = [["A", "A"], ["A", "G"], ["G", "A"], ["G", "G"]]
    .map(([left, right]) => left!.repeat(length / 2) + right!.repeat(length / 2));
  const result = await analyzeJemspr(sequences.map((sequence, index) => `>t${index}\n${sequence}`).join("\n"), {
    minimumWindow: 16, maximumDyadicTrees: 4, rootPlacements: 1,
    maximumGraphStates: 10, maximumGraphIterations: 3, neighbourScreen: 16, frontierStates: 3, nearImprovers: 1,
    pathBreakpointPenalty: 2, pathEndpointPenalty: 1, pathSpanPenalty: .001,
    maximumReticulations: 2, overlapCap: 2, networkBeamWidth: 3, eventPoolSize: 6,
    eventOpenPenalty: 1, networkBreakpointPenalty: 1, eventSpanPenalty: .001, reticulationPenalty: 1,
    gtrModel: { frequencies: [.25, .25, .25, .25], exchangeabilities: [1, 2, 1, 1, 2, 1], source: "FastTree-2.1.11-global-fit", version: "test" },
    likelihoodRateCategories: 1, fitLikelihoodGammaShape: false, likelihoodIterations: 5, likelihoodRefitIterations: 3,
  });
  const markup = renderToStaticMarkup(<JemsprResultsView result={result} />);
  const parsedNetwork = parseJemsprSwitchingNetwork(result.networkJson).network;
  for (const run of result.network.runs) {
    const path = displayMaskPath(parsedNetwork, run.mask);
    assert.equal(path[0], 0);
    assert.equal(path.at(-1), run.mask);
    for (let index = 1; index < path.length; index += 1) {
      assert.equal((path[index]! ^ path[index - 1]!).toString(2).replaceAll("0", "").length, 1);
      assert.notEqual(displayNetwork(parsedNetwork, path[index - 1]!)?.signature, displayNetwork(parsedNetwork, path[index]!)?.signature);
    }
  }
  assert.match(markup, /JEMSPR/);
  assert.match(markup, /never supplied by FastTree, FSART, MosaicSPR/);
  assert.match(markup, /Coherent linked branch-length likelihood/);
  assert.match(markup, /Shared atomic network edges/);
  assert.match(markup, /Likelihood-refined breakpoints and branch-length trees/);
  assert.match(markup, /JEMSPR likelihood-refined regional phylograms/);
  assert.match(markup, /Branch-length scale/);
  assert.match(markup, /Shared horizontal scale:/);
  assert.match(markup, /Coherent genomic event history/);
  assert.match(markup, /Implied regional phylogenies/);
  assert.match(markup, /Compiled switching DAG/);
  assert.match(markup, /Animated genomic SPR strip/);
  assert.match(markup, /Likelihood-refined alignment layout/);
  assert.match(markup, /Reset to master/);
  assert.match(markup, /Native horizontal scrolling/);
  assert.match(markup, /SPR move storyboard/);
  assert.match(markup, /SPR display-state graph/);
  assert.match(markup, /only the cut clade moves/i);
  assert.match(markup, /shared linked-ML scale/i);
  assert.match(markup, /Continue with codon site analysis/);
  assert.match(markup, /Matching-taxon links/);
  assert.match(markup, /Network JSON/);
  assert.ok((markup.match(/Export SVG/g) ?? []).length >= 7);
});

test("JEMSPR polished animation layout uses the optimized branch-length scale", () => {
  const layout = layoutPolishedSprTree("((a:0.1,b:0.3):0.2,c:0.7);", ["a", "b", "c"], 800, 420, 40);
  assert.ok(layout.pixelsPerUnit > 0);
  assert.ok(layout.nodes.get("2")!.x > layout.nodes.get("1")!.x);
  assert.ok(Math.abs(layout.nodes.get("0,1")!.branchLength - 0.2) < 1e-12);
  assert.ok(Math.abs(layout.maximumDistance - 0.7) < 1e-12);
});

test("DifFUBAR result studio renders a native SVG overview and export control", () => {
  const result: DifFubarRunResult = {
    sites: [{
      site: 1,
      pOmega1Greater: 0.98,
      pOmega2Greater: 0.01,
      pOmega1Positive: 0.97,
      pOmega2Positive: 0.1,
      meanAlpha: 0.5,
      meanOmega1: 2.2,
      meanOmega2: 0.4,
    }],
    detectedSites: [1],
    posteriorMarginals: {
      siteCount: 1,
      alphaValues: Float64Array.of(0.01, 1, 2),
      omegaValues: Float64Array.of(0.01, 1, 2),
      alpha: Float32Array.of(0.1, 0.8, 0.1),
      omega1: Float32Array.of(0.05, 0.15, 0.8),
      omega2: Float32Array.of(0.8, 0.15, 0.05),
    },
    backend: "wasm",
    timings: { totalMs: 12 },
    diagnostics: { taxa: 4, codonSites: 1, categories: 27, treeRegisterNumber: 1, precision: "f64" },
    tree: "((a{G1}:0.1,b{G1}:0.1){G1}:0.1,(c{G2}:0.1,d{G2}:0.1){G2}:0.1);",
    csv: "Codon Sites\n1\n",
  };
  const markup = renderToStaticMarkup(<DifFubarVisualizations result={result} threshold={0.95} onThresholdChange={() => undefined} />);
  assert.match(markup, /DifFUBAR figure studio/);
  assert.match(markup, /Posterior mean selection by codon/);
  assert.match(markup, /Export SVG/);
  assert.match(markup, /<svg/);
  assert.match(markup, /data-transient="true"/);
});

test("tagged phylogram exposes branch colors, label controls, and SVG export", () => {
  const markup = renderToStaticMarkup(<PhylogramFigure newick="((a{G1}:0.1,b{G1}:0.1){G1}:0.1,(c{G2}:0.1,d{G2}:0.1){G2}:0.1);" tagged />);
  assert.match(markup, /Tagged input phylogeny/);
  assert.match(markup, /Tip labels/);
  assert.match(markup, /Label size/);
  assert.match(markup, /Export SVG/);
  assert.match(markup, /#ff4b4f/);
  assert.match(markup, /#4f46f5/);
});

test("BS-REL renders a fitted branch-length phylogram, branch metrics, and SVG export", () => {
  const makeBranch = (branch: number, nodeId: number, name: string, terminal: boolean, p: number): BsrelRunResult["branches"][number] => ({
    branch, nodeId, nodeIndex: nodeId, name, parentName: "Root", terminal, tested: true,
    inputLength: 0.1, fittedLength: 0.08 + branch * 0.01,
    omegaMinus: 0.1, weightMinus: 0.7, omegaNeutral: 0.8, weightNeutral: 0.2,
    omegaPositive: 4.2, weightPositive: 0.1, meanOmega: 0.65,
    nullLogLikelihood: -120, likelihoodRatio: 7.2, pValue: p / 2, pValueHolm: p, significant: p <= 0.05,
  });
  const result: BsrelRunResult = {
    branches: [makeBranch(1, 1, "N", false, 0.01), makeBranch(2, 2, "a", true, 0.02), makeBranch(3, 3, "b", true, 0.4), makeBranch(4, 4, "c", true, 0.8)],
    alternativeLogLikelihood: -116.4,
    backend: "wasm-parallel",
    timings: { totalMs: 1234 },
    diagnostics: {
      taxa: 3, codonSites: 100, branches: 4, testedBranches: 4, significantBranches: 2,
      alternativeIterations: 9, alternativeConverged: true, nullIterations: 8, maximumOmega: 1000,
      lrtCalibration: "0.50*chi2_0 + 0.05*chi2_1 + 0.45*chi2_2",
      multipleTesting: "Holm-Bonferroni", messageAlgorithm: "upward-downward-local-blanket", precision: "f64",
    },
    tree: "((a:0.1,b:0.1)N:0.2,c:0.3);",
    csv: "Branch,Name\n1,N\n",
  };
  const markup = renderToStaticMarkup(<BsrelResultsView result={result} threshold={0.05} />);
  assert.match(markup, /Fixed three-rate BS-REL/);
  assert.match(markup, /no AIC complexity selection/i);
  assert.match(markup, /Annotated fitted phylogeny/);
  assert.match(markup, /Holm p-value/);
  assert.match(markup, /Fitted branch length/);
  assert.match(markup, /Export SVG/);
  assert.match(markup, /cached two-sided local blanket/);
});

test("Glamma results link full/null evidence, activation evidence, sites, and tree posteriors", () => {
  const branches: GlobalGammaRunResult["branches"] = [
    { branch: 1, nodeId: 1, nodeIndex: 1, name: "N", parentName: "Root", terminal: false, branchLength: 0.2, cappedLogEvidence: 3.1, cappedEvidenceRatio: 22.2, activationLogBayesFactor: 2.8, activationBayesFactor: 16.4, activationPosteriorMean: 0.34, expectedPositiveSites: 1.2, anySitePositivePosterior: 0.72, anySitePositiveLogBayesFactor: 1.8, maximumSitePosterior: 0.84 },
    { branch: 2, nodeId: 2, nodeIndex: 2, name: "a", parentName: "N", terminal: true, branchLength: 0.1, cappedLogEvidence: 0.2, cappedEvidenceRatio: 1.22, activationLogBayesFactor: 0.1, activationBayesFactor: 1.1, activationPosteriorMean: 0.11, expectedPositiveSites: 0.3, anySitePositivePosterior: 0.25, anySitePositiveLogBayesFactor: 0.1, maximumSitePosterior: 0.22 },
    { branch: 3, nodeId: 3, nodeIndex: 3, name: "b", parentName: "N", terminal: true, branchLength: 0.1, cappedLogEvidence: -0.4, cappedEvidenceRatio: 0.67, activationLogBayesFactor: -0.2, activationBayesFactor: 0.82, activationPosteriorMean: 0.08, expectedPositiveSites: 0.2, anySitePositivePosterior: 0.18, anySitePositiveLogBayesFactor: -0.2, maximumSitePosterior: 0.16 },
    { branch: 4, nodeId: 4, nodeIndex: 4, name: "c", parentName: "Root", terminal: true, branchLength: 0.3, cappedLogEvidence: 1.1, cappedEvidenceRatio: 3, activationLogBayesFactor: 0.7, activationBayesFactor: 2, activationPosteriorMean: 0.17, expectedPositiveSites: 0.6, anySitePositivePosterior: 0.45, anySitePositiveLogBayesFactor: 0.5, maximumSitePosterior: 0.55 },
  ];
  const result: GlobalGammaRunResult = {
    method: "glamma",
    sites: [
      { site: 1, cappedLogEvidence: 2.1, cappedEvidenceRatio: 8.17, conditionalSupport: 0.891, expectedPositiveBranches: 1.4, maximumBranchPosterior: 0.84 },
      { site: 2, cappedLogEvidence: -0.3, cappedEvidenceRatio: 0.74, conditionalSupport: 0.426, expectedPositiveBranches: 0.3, maximumBranchPosterior: 0.22 },
    ],
    branches,
    fit: { omegaMean: 0.72, omegaShape: 0.8, alphaShape: 1.6, logLikelihood: -123.4 },
    omegaValues: Float64Array.of(0.1, 0.5, 1.4, 4),
    alphaValues: Float64Array.of(0.2, 0.8, 1.2, 1.8),
    positivePrior: 0.15,
    posterior: { siteCount: 2, branchCount: 4, tailPosterior: Float32Array.of(0.84, 0.1, 0.22, 0.08, 0.16, 0.06, 0.55, 0.06), localLogEvidence: Float32Array.of(2, 0.1, 0.2, 0, -0.1, -0.2, 0.8, 0.3) },
    backend: "wasm-parallel",
    timings: { totalMs: 2300 },
    diagnostics: {
      taxa: 3, codonSites: 2, branches: 4, omegaSlices: 4, alphaSlices: 4, fitPreset: "fast", coarseCandidates: 20, refinementCandidates: 9,
      activationPriorAlpha: 1, activationPriorBeta: 9, messageAlgorithm: "upward-downward-local-blanket", alphaModel: "mean-one-global-discrete-gamma",
      omegaModel: "global-discrete-gamma-iid-branch-site", evidenceCalibration: "plug-in-conditional-empirical-bayes", fitNumerics: "coarse-to-fine-grid-ml-julia-interpolation", finalNumerics: "direct-f64-uniformization",
    },
    tree: "((a:0.1,b:0.1)N:0.2,c:0.3);",
    siteCsv: "Codon site\n1\n",
    branchCsv: "Branch\n1\n",
  };
  const markup = renderToStaticMarkup(<GlobalGammaResultsView result={result} threshold={0.9} alignment=">a\nATGAAA\n>b\nATGAAG\n>c\nATGAAA\n" />);
  assert.match(markup, /Glamma/);
  assert.match(markup, /Full data range/);
  assert.match(markup, /Map selection onto a protein structure/);
  assert.match(markup, /same site-wise α is used on every edge/);
  assert.match(markup, /each edge independently integrates/);
  assert.match(markup, /Activation empirical BF/);
  assert.match(markup, /Full vs branch-null evidence/);
  assert.match(markup, /Selected-site tail posterior/);
  assert.match(markup, /Codon alignment evidence track/);
  assert.ok((markup.match(/Export SVG/g) ?? []).length >= 2);
});

test("CladeShift keeps its exploratory scan isolated while linking sites, clades, reference, and structure views", () => {
  const result: CladeShiftRunResult = {
    method: "clade-shift",
    sites: [
      { site: 1, pShift: 0.96, pRelaxation: 0.91, pIntensification: 0.05, logBayesFactor: 5.1, relaxationLogBayesFactor: 5.7, intensificationLogBayesFactor: -0.2, direction: "relaxation", detected: true, mapBranch: 1, mapBranchName: "N", mapBranchPosterior: 0.79, mapIntensity: 0.5, meanIntensityGivenShift: 0.57, capturedNullPosteriorMass: 0.97, baselineMeanAlpha: 0.8, baselineMeanBeta: 0.2 },
      { site: 2, pShift: 0.92, pRelaxation: 0.08, pIntensification: 0.84, logBayesFactor: 4.3, relaxationLogBayesFactor: -0.1, intensificationLogBayesFactor: 5, direction: "intensification", detected: true, mapBranch: 4, mapBranchName: "c", mapBranchPosterior: 0.68, mapIntensity: 2, meanIntensityGivenShift: 1.8, capturedNullPosteriorMass: 0.94, baselineMeanAlpha: 0.7, baselineMeanBeta: 1.4 },
    ],
    branches: [
      { branch: 1, nodeId: 1, nodeIndex: 1, name: "N", parentName: "root", terminal: false, descendantTips: 2, eligible: true, expectedShiftedSites: 0.8, expectedRelaxedSites: 0.75, expectedIntensifiedSites: 0.05, maximumSitePosterior: 0.79, mapSite: 1 },
      { branch: 2, nodeId: 2, nodeIndex: 2, name: "a", parentName: "N", terminal: true, descendantTips: 1, eligible: true, expectedShiftedSites: 0.1, expectedRelaxedSites: 0.08, expectedIntensifiedSites: 0.02, maximumSitePosterior: 0.07, mapSite: 1 },
      { branch: 3, nodeId: 3, nodeIndex: 3, name: "b", parentName: "N", terminal: true, descendantTips: 1, eligible: true, expectedShiftedSites: 0.1, expectedRelaxedSites: 0.07, expectedIntensifiedSites: 0.03, maximumSitePosterior: 0.06, mapSite: 1 },
      { branch: 4, nodeId: 4, nodeIndex: 4, name: "c", parentName: "root", terminal: true, descendantTips: 1, eligible: true, expectedShiftedSites: 0.7, expectedRelaxedSites: 0.04, expectedIntensifiedSites: 0.66, maximumSitePosterior: 0.68, mapSite: 2 },
    ],
    detectedSites: [1, 2],
    posterior: {
      siteCount: 2, branchCount: 4, intensities: Float64Array.of(0.5, 2),
      branchPosterior: Float32Array.of(0.79, 0.03, 0.07, 0.03, 0.06, 0.02, 0.04, 0.68),
      branchRelaxation: Float32Array.of(0.75, 0.02, 0.06, 0.01, 0.05, 0.01, 0.03, 0.02),
      branchIntensification: Float32Array.of(0.04, 0.01, 0.01, 0.02, 0.01, 0.01, 0.01, 0.66),
      intensityPosterior: Float32Array.of(0.91, 0.05, 0.08, 0.84),
    },
    intensities: Float64Array.of(0.5, 2),
    shiftPrior: 0.2,
    backend: "wasm-parallel",
    timings: { totalMs: 2100 },
    diagnostics: { taxa: 3, codonSites: 2, branches: 4, candidateClades: 4, gridPoints: 16, baselineCategories: 256, posteriorComponents: 18, meanPosteriorComponents: 15.5, posteriorMassTarget: 0.9, intensityStates: 2, intensityPreset: "fast", minimumDescendantTips: 1, minimumCapturedPosteriorMass: 0.94, meanCapturedPosteriorMass: 0.955, nullIntegration: "compressed-fubar-posterior-identity", cladeAlgorithm: "baseline-outside-plus-shifted-subtree-inside", evidenceCalibration: "fixed-prior-empirical-bayes", validatedMethod: false, precision: "f64" },
    tree: "((a:0.1,b:0.1)N:0.2,c:0.3)root;",
    siteCsv: "Codon site\n1\n2\n",
    branchCsv: "Branch\n1\n2\n3\n4\n",
  };
  const markup = renderToStaticMarkup(<CladeShiftResultsView result={result} threshold={0.9} alignment=">a\nATGAAA\n>b\nATGAAG\n>c\nATGAAA\n" />);
  assert.match(markup, /CladeShift/);
  assert.match(markup, /Exploratory and not simulation-validated/);
  assert.match(markup, /none is selected by an unpenalized maximum/);
  assert.match(markup, /Where did the persistent shift begin/);
  assert.match(markup, /Map selection onto a protein structure/);
  assert.match(markup, /Optional selection-on-profile visualization/);
  assert.ok((markup.match(/Export SVG/g) ?? []).length >= 2);
});

test("FUBAR studio renders selection overview and site posterior products", () => {
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
    diagnostics: {
      taxa: 4,
      codonSites: 2,
      categories: 4,
      treeRegisterNumber: 2,
      precision: "f64",
      inferenceMethod: "dirichlet-em",
      inferenceIterations: 14,
      inferenceBurnin: 0,
      inferenceLogLikelihood: -2.3,
    },
    tree: "((a:0.1,b:0.1):0.1,(c:0.1,d:0.1):0.1);",
    csv: "Codon Sites\n1\n2\n",
  };
  const markup = renderToStaticMarkup(<FubarVisualizations result={result} threshold={0.95} onThresholdChange={() => undefined} showPositive showPurifying />);
  assert.match(markup, /FUBAR figure studio/);
  assert.match(markup, /positive and purifying selection/i);
  assert.match(markup, /Posterior surface/);
  assert.match(markup, /Export SVG/);
  assert.match(markup, /mean α/);
});

test("FAME studio exposes linked evidence, mass lanes, posterior projection, and SVG export", () => {
  const result: FameRunResult = {
    method: "fame",
    sites: [
      { site: 1, pPositive: 0.97, bayesFactor: 18, meanAlpha: 0.5, meanOmega1: 0.2, meanOmega2: 2.4, detected: true },
      { site: 2, pPositive: 0.1, bayesFactor: 0.2, meanAlpha: 1.2, meanOmega1: 0.4, meanOmega2: 0.7, detected: false },
    ],
    detectedSites: [1],
    posterior: {
      siteCount: 2,
      alphaValues: Float64Array.of(0.1, 2),
      omega1Values: Float64Array.of(0.1, 1),
      omega2Values: Float64Array.of(0.1, 3),
      surfaces: Float32Array.from({ length: 16 }, (_unused, index) => index % 8 === 7 ? 0.7 : 0.3 / 7),
      alpha: Float32Array.of(0.7, 0.3, 0.2, 0.8),
      omega1: Float32Array.of(0.8, 0.2, 0.6, 0.4),
      omega2: Float32Array.of(0.1, 0.9, 0.8, 0.2),
    },
    positivePrior: 0.2,
    backend: "wasm-parallel",
    timings: { totalMs: 1000 },
    diagnostics: {
      taxa: 4, codonSites: 2, categories: 8, branchMixtureOperators: 32, atomicOmegaModels: 4,
      treeRegisterNumber: 2, precision: "f64", inferenceMethod: "dirichlet-em", inferenceIterations: 10,
      inferenceBurnin: 0, inferenceLogLikelihood: -8, modelDraftCommit: "4c65c984", numericalEngine: "fused-sparse-or-dense-uniformization",
      weightIntegration: "likelihood-quadrature", weightPoints: 4, gridPreset: "fast",
    },
    tree: "((a:0.1,b:0.1):0.1,(c:0.1,d:0.1):0.1);",
    csv: "Codon Sites\n1\n2\n",
  };
  const markup = renderToStaticMarkup(<BameVisualizations result={result} threshold={0.9} onThresholdChange={() => undefined} />);
  assert.match(markup, /FAME figure studio/);
  assert.match(markup, /Parameter posteriors/);
  assert.match(markup, /Posterior projection/);
  assert.match(markup, /Export SVG/);
  assert.match(markup, /data-figure="bame-evidence-overview"/);
});

test("FLAVOR studio exposes capped-state projection controls and branch-omega CDF", () => {
  const result: FlavorRunResult = {
    method: "flavor",
    sites: [{
      site: 1, pPositive: 0.96, pUncapped: 0.98, bayesFactor: 22, meanAlpha: 0.6, meanOmega: 2.2,
      meanShape: 1.4, meanOmegaStandardDeviation: 1.8, meanPositiveBranchFraction: 0.35, detected: true,
    }],
    detectedSites: [1],
    posterior: {
      siteCount: 1,
      muValues: Float64Array.of(0.2, 3),
      shapeValues: Float64Array.of(0.2, 2),
      alphaValues: Float64Array.of(0.1, 2),
      surfaces: Float32Array.from({ length: 16 }, (_unused, index) => index === 15 ? 0.7 : 0.3 / 15),
      mu: Float32Array.of(0.2, 0.8),
      shape: Float32Array.of(0.3, 0.7),
      alpha: Float32Array.of(0.6, 0.4),
      capState: Float32Array.of(0.98, 0.02),
    },
    positivePrior: 0.15,
    backend: "wasm-parallel",
    timings: { totalMs: 2000 },
    diagnostics: {
      taxa: 4, codonSites: 1, categories: 16, branchMixtureOperators: 16, atomicOmegaModels: 20,
      treeRegisterNumber: 2, precision: "f64", inferenceMethod: "dirichlet-em", inferenceIterations: 12,
      inferenceBurnin: 0, inferenceLogLikelihood: -4, modelDraftCommit: "4c65c984", numericalEngine: "fused-sparse-or-dense-uniformization",
      gammaSlices: 12, cappedGridMultiplicityRetained: true, gridPreset: "fast",
    },
    tree: "((a:0.1,b:0.1):0.1,(c:0.1,d:0.1):0.1);",
    csv: "Codon Sites\n1\n",
  };
  const markup = renderToStaticMarkup(<BameVisualizations result={result} threshold={0.9} onThresholdChange={() => undefined} />);
  assert.match(markup, /FLAVOR figure studio/);
  assert.match(markup, /Surface categories/);
  assert.match(markup, /Uncapped only/);
  assert.match(markup, /Branch-ω CDF/);
  assert.match(markup, /Posterior projection/);
});

test("approximate FEL stays separate and renders conditional likelihood optima plus SVG export", () => {
  const result = {
    siteCount: 2,
    gridSize: 3,
    gridValues: Float64Array.of(0.01, 1, 8),
    relativeLogLikelihoods: Float32Array.of(
      -8, -5, -3, -6, -2, 0, -7, -3, -1,
      -1, -3, -7, 0, -2, -6, -3, -5, -8,
    ),
    sites: [
      {
        site: 1, pValue: 0.02, pPositive: 0.01, pPurifying: 0.99, likelihoodRatio: 5.41,
        gridLogLikelihoodMaximum: -100, logLikelihoodAlternative: -99.9, logLikelihoodNull: -102.605,
        alphaAlternative: 0.7, betaAlternative: 2.4, alphaBetaNull: 1.1,
        alphaCoordinate: 0.9, betaCoordinate: 1.35, nullCoordinate: 1.04,
        direction: "positive", splineTension: 1,
      },
      {
        site: 2, pValue: 0.03, pPositive: 0.985, pPurifying: 0.015, likelihoodRatio: 4.7,
        gridLogLikelihoodMaximum: -80, logLikelihoodAlternative: -79.8, logLikelihoodNull: -82.15,
        alphaAlternative: 2.8, betaAlternative: 0.6, alphaBetaNull: 1.2,
        alphaCoordinate: 1.45, betaCoordinate: 0.8, nullCoordinate: 1.06,
        direction: "purifying", splineTension: 1,
      },
    ],
    diagnostics: {
      interpolation: "exact-tensioned-bicubic-log-likelihood",
      coordinateSystem: "uniform-fubar-grid-index",
      maximumNodeError: 0,
      minimumSplineTension: 1,
      guardedSites: 0,
    },
  } as const;
  assert.equal(approximateFelCall(result.sites[0], 0.05), "positive");
  assert.equal(approximateFelCall(result.sites[1], 0.05), "purifying");
  const markup = renderToStaticMarkup(<ApproximateFelResults result={result} elapsedMs={640} />);
  assert.match(markup, /Optional frequentist companion/);
  assert.match(markup, /Separate from FUBAR/);
  assert.match(markup, /No FUBAR prior enters these results/);
  assert.match(markup, /data-figure="approximate-fel-surface"/);
  assert.match(markup, /data-optimum="null"/);
  assert.match(markup, /data-optimum="alternative"/);
  assert.match(markup, /data-lrt-connector="true"/);
  assert.match(markup, /Download FEL CSV/);
  assert.match(markup, /Export SVG/);
  assert.match(markup, /FEL compute time/);
});

test("posterior marginals render Julia-style alpha and omega probability-mass lanes", () => {
  const sites = [
    {
      site: 1,
      pOmega1Greater: 0.99,
      pOmega2Greater: 0.01,
      pOmega1Positive: 0.98,
      pOmega2Positive: 0.02,
      meanAlpha: 0.6,
      meanOmega1: 2.1,
      meanOmega2: 0.4,
    },
    {
      site: 2,
      pOmega1Greater: 0.02,
      pOmega2Greater: 0.98,
      pOmega1Positive: 0.03,
      pOmega2Positive: 0.97,
      meanAlpha: 1.1,
      meanOmega1: 0.3,
      meanOmega2: 2.4,
    },
  ] as const;
  const marginals = {
    siteCount: 2,
    alphaValues: Float64Array.of(0.01, 0.2, 1, 4),
    omegaValues: Float64Array.of(0.01, 0.2, 1, 4),
    alpha: Float32Array.of(0.05, 0.8, 0.1, 0.05, 0.1, 0.2, 0.6, 0.1),
    omega1: Float32Array.of(0.05, 0.1, 0.25, 0.6, 0.7, 0.2, 0.08, 0.02),
    omega2: Float32Array.of(0.65, 0.2, 0.1, 0.05, 0.03, 0.07, 0.2, 0.7),
  } as const;
  const markup = renderToStaticMarkup(
    <PosteriorMarginalFigure
      sites={sites}
      threshold={0.95}
      labels={DEFAULT_LABELS}
      onSelectSite={() => undefined}
      svgRef={createRef<SVGSVGElement>()}
      marginals={marginals}
    />,
  );
  const group = (series: string): string => {
    const match = markup.match(new RegExp(`<g data-series="${series}"[\\s\\S]*?<\\/g>`));
    assert.ok(match !== null, `missing ${series} marginal group`);
    return match[0];
  };
  const mark = (series: string, site: number, bin: number): { baseline: number; height: number } => {
    const match = group(series).match(new RegExp(`<rect[^>]*data-site="${site}"[^>]*data-bin="${bin}"[^>]*data-baseline="([^"]+)"[^>]*height="([^"]+)"`));
    assert.ok(match !== null, `missing ${series} mark for site ${site}, bin ${bin}`);
    return { baseline: Number(match[1]), height: Number(match[2]) };
  };

  for (const series of ["alpha", "omega1", "omega2"]) {
    assert.equal((group(series).match(/<rect/g) ?? []).length, 8);
  }
  assert.match(markup, /viewBox="0 0 520 /);
  assert.match(markup, /data-layout="paper-portrait"/);
  assert.match(markup, /data-bin-occupancy="0.8"/);
  assert.match(markup, /style="[^"]*width:520px/);
  assert.match(markup, /min-width:520px/);
  const alpha = mark("alpha", 1, 1);
  const alphaTail = mark("alpha", 1, 0);
  const omega1 = mark("omega1", 1, 1);
  const omega2 = mark("omega2", 1, 1);
  assert.ok(alpha.baseline < omega1.baseline, "alpha must sit above the omega lane");
  assert.equal(omega1.baseline, omega2.baseline, "the two omega marginals share the Julia baseline");
  assert.ok(alpha.height > alphaTail.height * 10, "posterior mass must control local bar thickness");
  assert.match(markup, /Rectangle thickness is proportional to posterior probability/);
});

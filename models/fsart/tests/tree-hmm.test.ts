import assert from "node:assert/strict";
import test from "node:test";
import {
  consensusBreakpointSignals,
  effectiveMinimumTreeSpan,
  exploreTreeHmm,
  fitTreeHmm,
  selectTreeBankBreakpoints,
  selectTreeHypotheses,
  scoreFrozenTreeProfile,
  treeBankWindows,
  treeFamilyWindows,
  type MergedBreakpoint,
  type SegmentLikelihood,
  type RefinedTripletSignal,
  type TreeEmissionProfile,
} from "../src/index.js";

const frozenAlignment = `>a
AACCGGTT
>b
AACCGGTA
>c
TTCCGGTT
>d
TTCCGGTA
`;
const frozenModel = { gtrFrequencies: [0.25, 0.25, 0.25, 0.25], gtrRates: [1, 1, 1, 1, 1, 1] };

function profile(id: string, values: readonly number[]): TreeEmissionProfile {
  return {
    id,
    sourceStart: id === "T1" ? 1 : Math.floor(values.length / 2) + 1,
    sourceEnd: id === "T1" ? Math.floor(values.length / 2) : values.length,
    tree: id === "T1" ? "((a,b),(c,d));" : "((a,c),(b,d));",
    topologySignature: id,
    logLikelihood: values.reduce((sum, value) => sum + value, 0),
    siteLogLikelihoods: Float64Array.from(values),
    elapsedMs: 0,
  };
}

test("tree HMM recovers a topology transition and a local switch interval", () => {
  const sites = 200;
  const first = Array.from({ length: sites }, (_value, site) => site < 100 ? 0 : -6);
  const second = Array.from({ length: sites }, (_value, site) => site < 100 ? -6 : 0);
  const result = fitTreeHmm([profile("T1", first), profile("T2", second)], {
    taxa: 4,
    criterion: "bic",
    maximumRateSlices: 13,
    maximumWeightIterations: 12,
  });
  assert.equal(result.status, "complete");
  assert.equal(result.states.length, 2);
  assert.ok((result.deltaCriterion ?? -Infinity) > 100);
  assert.equal(result.mapState[20], 0);
  assert.equal(result.mapState[180], 1);
  assert.ok(result.expectedSwitches > 0.5 && result.expectedSwitches < 2);
  assert.equal(result.switchIntervals.length, 1);
  assert.ok(result.switchIntervals.some((interval) => Math.abs(interval.breakpoint - 100) <= 2));
  assert.ok(result.switchIntervals[0]!.intervalHigh - result.switchIntervals[0]!.intervalLow < 30);
  assert.deepEqual(result.viterbi?.breakpoints, [100]);
  assert.ok((result.subsetSearch?.evaluatedSubsets ?? 0) >= 3);
  assert.ok((result.subsetSearch?.hypotheses.length ?? 0) >= 3);
  assert.ok((result.subsetSearch?.transitions.length ?? 0) >= 1);
  assert.ok((result.subsetSearch?.exactVerifiedKeys.length ?? 0) >= 1);
  assert.ok(result.subsetSearch?.exactVerifiedKeys.includes("0"));
  assert.equal(result.subsetSearch?.exactSelectedKey, "0,1");
  assert.equal(result.subsetSearch?.finalSelectedKey, "0,1");
});

test("tree HMM remains finite across extreme per-site likelihood contrasts", () => {
  const sites = 180;
  const first = Array.from({ length: sites }, (_value, site) => site < 90 ? -1_000_000 : -1_001_200);
  const second = Array.from({ length: sites }, (_value, site) => site < 90 ? -1_001_200 : -1_000_000);
  const result = fitTreeHmm([profile("T1", first), profile("T2", second)], {
    taxa: 4,
    criterion: "bic",
    maximumRateSlices: 9,
  });
  assert.equal(result.status, "complete");
  assert.equal(result.states.length, 2);
  assert.ok(Number.isFinite(result.logLikelihood));
  assert.ok(Number.isFinite(result.criterionValue));
  assert.deepEqual(result.viterbi?.breakpoints, [90]);
});

test("tree HMM rejects non-finite emissions instead of silently favoring one tree", () => {
  const values = Array.from({ length: 120 }, () => -1);
  const broken = values.slice();
  broken[73] = Number.NaN;
  assert.throws(() => fitTreeHmm([profile("T1", values), profile("T2", broken)], {
    taxa: 4,
    criterion: "bic",
  }), /T2.*site 74/);
});

test("a narrow rapid beam evaluates additions to the explicit global null without forcing it into every subset", () => {
  const sites = 150;
  const global = Array.from({ length: sites }, () => -2);
  const regional = Array.from({ length: sites }, (_value, site) => site < 75 ? -1 : -5);
  const result = fitTreeHmm([profile("T1", global), profile("T2", regional)], {
    taxa: 4,
    criterion: "bic",
    maximumStates: 2,
    beamWidth: 1,
    maximumRateSlices: 5,
  });
  assert.ok(result.subsetSearch?.transitions.some((transition) => transition.fromKey === "0" && transition.toKey === "0,1"));
  assert.ok(result.subsetSearch?.hypotheses.some((hypothesis) => hypothesis.key === "1"));
});

test("AICc reports an infeasible multi-tree model instead of disguising it as an underflow failure", () => {
  const sites = 100;
  const first = Array.from({ length: sites }, (_value, site) => site < 50 ? 0 : -20);
  const second = Array.from({ length: sites }, (_value, site) => site < 50 ? -20 : 0);
  const result = fitTreeHmm([profile("T1", first), profile("T2", second)], {
    taxa: 30,
    criterion: "aicc",
    maximumStates: 2,
  });
  assert.equal(result.states.length, 1);
  const multiple = result.subsetSearch?.hypotheses.find((hypothesis) => hypothesis.stateCount === 2);
  assert.equal(multiple?.criterionValue, Number.POSITIVE_INFINITY);
});

test("fixed low-switch exploration removes draft trees absent from the stabilized Viterbi path", () => {
  const sites = 240;
  const first = Array.from({ length: sites }, (_value, site) => site < 120 ? 0 : -5);
  const second = Array.from({ length: sites }, (_value, site) => site < 120 ? -5 : 0);
  const decoy = Array.from({ length: sites }, () => -9);
  const result = exploreTreeHmm([
    profile("T1", first),
    profile("T2", second),
    { ...profile("T3", decoy), tree: "((a,d),(b,c));" },
  ], {
    mode: "fixed-low-switch",
    expectedResets: 1,
    minimumRunLength: 20,
  });
  assert.equal(result.status, "complete");
  assert.deepEqual(result.states.map((state) => state.id), ["T1", "T2"]);
  assert.deepEqual(result.droppedTreeIds, ["T3"]);
  assert.ok(result.viterbi.breakpoints.some((value) => Math.abs(value - 120) <= 1));
  assert.equal(result.statePosterior.length, 2 * sites);
});

test("sparse Dirichlet variational EM annihilates an unsupported topology without a subset search", () => {
  const sites = 200;
  const first = Array.from({ length: sites }, (_value, site) => site < 100 ? 0 : -4);
  const second = Array.from({ length: sites }, (_value, site) => site < 100 ? -4 : 0);
  const decoy = Array.from({ length: sites }, () => -12);
  const result = exploreTreeHmm([
    profile("T1", first),
    profile("T2", second),
    { ...profile("T3", decoy), tree: "((a,d),(b,c));" },
  ], {
    mode: "sparse-dirichlet",
    expectedResets: 2,
    dirichletConcentration: 0.03,
    minimumRunLength: 15,
    maximumIterations: 50,
  });
  assert.equal(result.status, "complete");
  assert.ok(result.converged);
  assert.deepEqual(result.states.map((state) => state.id), ["T1", "T2"]);
  assert.ok(result.droppedTreeIds.includes("T3"));
  assert.ok(result.states.every((state) => state.weight > 0));
  assert.ok(result.iterations > 0);
});

test("IC pruning removes a redundant topology emission profile", () => {
  const values = Array.from({ length: 160 }, (_value, site) => -1 - 0.1 * Math.sin(site));
  const result = fitTreeHmm([profile("T1", values), profile("T2", values)], {
    taxa: 4,
    criterion: "aicc",
    maximumRateSlices: 7,
  });
  assert.equal(result.status, "complete");
  assert.equal(result.states.length, 1);
  assert.equal(result.expectedSwitches, 0);
  assert.ok((result.deltaCriterion ?? -Infinity) >= -1e-8);
});

test("tree-bank cut selection reserves coverage for a weaker central signal", () => {
  const positions = [890, 1039, 1130, 801, 152, 287, 187, 388, 313, 438, 355, 126, 820, 230, 475, 568];
  const candidates = positions.map((breakpoint, index): MergedBreakpoint => ({
    id: `B${index + 1}`,
    rank: index + 1,
    breakpoint,
    intervalLow: breakpoint,
    intervalHigh: breakpoint,
    supportLow: breakpoint,
    supportHigh: breakpoint,
    evidence: positions.length - index,
    consensusScore: positions.length - index,
    strengthScore: positions.length - index,
    adjustedP: 1,
    supportTriplets: 1,
    supportTaxa: 3,
    representative: {} as MergedBreakpoint["representative"],
    memberIndexes: [],
  }));
  const selected = selectTreeBankBreakpoints(candidates, 1200, 12, 60);
  assert.equal(selected.length, 12);
  assert.ok(selected.some((candidate) => candidate.breakpoint === 568));
});

test("full-tree selection keeps the global null first without collapsing equal topologies", () => {
  const segment = (start: number, end: number, tree: string): SegmentLikelihood => ({
    start, end, tree, logLikelihood: -(end - start + 1), variableSites: 10, elapsedMs: 0,
  });
  const global = segment(1, 1000, "((a,b),(c,d));");
  const recurring = [segment(1, 500, "((a,c),(b,d));"), segment(501, 1000, "((b,d),(a,c));")];
  const short = segment(1, 100, "((a,d),(b,c));");
  const hypotheses = selectTreeHypotheses([short, ...recurring, global], 1000, 4);
  assert.equal(hypotheses.length, 4);
  assert.equal(hypotheses[0]!.segment, global);
  assert.equal(hypotheses[2]!.signature, hypotheses[3]!.signature);
  assert.notEqual(hypotheses[2]!.segment, hypotheses[3]!.segment);
});

test("full-tree selection never substitutes one same-topology source fit for another", () => {
  const segment = (start: number, end: number, tree: string): SegmentLikelihood => ({
    start, end, tree, logLikelihood: -(end - start + 1), variableSites: 10, elapsedMs: 0,
  });
  const global = segment(1, 3000, "((a,b),(c,d));");
  const contaminatedPrefix = segment(1, 2300, "((a,c),(b,d));");
  const localWindow = segment(1126, 1875, "((b,d),(a,c));");
  const hypotheses = selectTreeHypotheses([global, contaminatedPrefix, localWindow], 3000, 3);
  assert.equal(hypotheses[0]!.segment, global);
  assert.equal(hypotheses[1]!.segment, contaminatedPrefix);
  assert.equal(hypotheses[2]!.segment, localWindow);
  assert.equal(hypotheses[1]!.signature, hypotheses[2]!.signature);
});

test("frozen-tree scoring never mixes or reweights source-region columns", () => {
  const tree = "((a:0.1,b:0.1):0.05,c:0.1,d:0.1);";
  const left = scoreFrozenTreeProfile(frozenAlignment, {
    id: "left", sourceStart: 1, sourceEnd: 4, tree, topologySignature: "same", gammaAlpha: 0.5,
  }, frozenModel);
  const right = scoreFrozenTreeProfile(frozenAlignment, {
    id: "right", sourceStart: 5, sourceEnd: 8, tree, topologySignature: "same", gammaAlpha: 0.5,
  }, frozenModel);
  assert.deepEqual(Array.from(left.siteLogLikelihoods), Array.from(right.siteLogLikelihoods));
  assert.equal(left.logLikelihood, right.logLikelihood);
});

test("same-topology trees with different fitted branch lengths retain different emissions", () => {
  const short = scoreFrozenTreeProfile(frozenAlignment, {
    id: "short", sourceStart: 1, sourceEnd: 4,
    tree: "((a:0.02,b:0.02):0.01,c:0.02,d:0.02);",
    topologySignature: "same", gammaAlpha: 0.5,
  }, frozenModel);
  const long = scoreFrozenTreeProfile(frozenAlignment, {
    id: "long", sourceStart: 5, sourceEnd: 8,
    tree: "((a:0.5,b:0.5):0.25,c:0.5,d:0.5);",
    topologySignature: "same", gammaAlpha: 0.5,
  }, frozenModel);
  assert.notDeepEqual(Array.from(short.siteLogLikelihoods), Array.from(long.siteLogLikelihoods));
  assert.notEqual(short.logLikelihood, long.logLikelihood);
});

test("tree-bank windows cover internal mosaics with constant-size overlap", () => {
  const windows = treeBankWindows(3000, 60);
  assert.equal(windows.length, 7);
  assert.deepEqual(windows[0], { start: 1, end: 750 });
  assert.deepEqual(windows.at(-1), { start: 2251, end: 3000 });
  assert.ok(windows.some((window) => window.start <= 1200 && window.end >= 1800));
});

test("tree family contains every atomic segment, adjacent pair, adjacent triplet, and global fit", () => {
  assert.deepEqual(treeFamilyWindows([], 400, 50).map((window) => window.kind), ["global"]);
  const windows = treeFamilyWindows([100, 200, 300], 400, 50);
  assert.equal(windows.filter((window) => window.kind === "global").length, 1);
  assert.equal(windows.filter((window) => window.kind === "segment").length, 4);
  assert.equal(windows.filter((window) => window.kind === "pair").length, 3);
  assert.equal(windows.filter((window) => window.kind === "triplet").length, 2);
  assert.equal(windows.length, 10);
});

test("tree-window floor adapts to diversity and consensus boundaries remain hard-spaced", () => {
  assert.equal(effectiveMinimumTreeSpan(9, 3000, 360, 150), 250);
  assert.equal(effectiveMinimumTreeSpan(9, 3000, 1500, 150), 150);
  const signal = (breakpoint: number, taxa: readonly [number, number, number], evidence: number): RefinedTripletSignal => ({
    breakpoint,
    taxa,
    evidence,
    switchPosterior: 0.9,
    intervalLow: breakpoint - 2,
    intervalHigh: breakpoint + 2,
    adjustedP: 1e-5,
  } as RefinedTripletSignal);
  const consensus = consensusBreakpointSignals([
    signal(200, [0, 1, 2], 8),
    signal(205, [0, 1, 3], 7),
    signal(230, [1, 2, 3], 9),
    signal(600, [0, 2, 3], 6),
  ], { sites: 1000, mergeDistance: 10, minimumSpacing: 100, maximumCandidates: 10 });
  const ordered = consensus.map((value) => value.breakpoint).sort((a, b) => a - b);
  assert.ok(ordered.length >= 1);
  for (let index = 1; index < ordered.length; index += 1) assert.ok(ordered[index]! - ordered[index - 1]! >= 100);
  assert.ok(ordered.every((value) => value >= 100 && 1000 - value >= 100));
});

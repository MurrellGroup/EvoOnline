import assert from "node:assert/strict";
import test from "node:test";
import { breakpointAccuracy, matchBreakpoints, normalizedRobinsonFoulds } from "../simulations/metrics.js";
import { summarizeDiversity } from "../simulations/diversity.js";
import { DEFAULT_SCENARIOS, STRESS_SCENARIOS, simulateAlignment } from "../simulations/simulator.js";
import { analyzeFsart } from "../src/index.js";

test("piecewise GTR simulation is deterministic, rectangular, rate-variable, and topology-changing", () => {
  const options = { taxa: 8, sites: 360, seed: 12345, scenario: DEFAULT_SCENARIOS[2]! };
  const first = simulateAlignment(options);
  const second = simulateAlignment(options);
  assert.equal(first.fasta, second.fasta);
  assert.equal(first.trueBreakpoints.length, 2);
  assert.equal(first.trueSegments.length, 3);
  assert.ok(first.sequences.every((sequence) => sequence.length === 360));
  assert.ok(Math.abs(first.rateSummary.mean - 1) < 1e-10);
  assert.ok(first.rateSummary.invariantFraction > 0.02);
  assert.ok(first.rateSummary.q90 > first.rateSummary.median);
  assert.ok(first.trueSegments.some((segment, index) => index > 0 && segment.topology !== first.trueSegments[index - 1]!.topology));
  for (let index = 1; index < first.trueSegments.length; index += 1) {
    assert.ok(normalizedRobinsonFoulds(first.trueSegments[index - 1]!.tree, first.trueSegments[index]!.tree) > 0,
      "every simulated recombination boundary must change the unrooted topology");
  }
});

test("branch scaling creates distinct realized diversity and reports FSART event supply", () => {
  const shared = { taxa: 8, sites: 900, seed: 9876, scenario: DEFAULT_SCENARIOS[0]! };
  const low = simulateAlignment({ ...shared, branchLengthScale: 0.04 });
  const high = simulateAlignment({ ...shared, branchLengthScale: 1 });
  const lowSummary = summarizeDiversity(low.sequences, 24);
  const highSummary = summarizeDiversity(high.sequences, 24);
  assert.ok(lowSummary.meanPairwiseDistance < highSummary.meanPairwiseDistance / 3);
  assert.ok(lowSummary.variableSiteFraction < highSummary.variableSiteFraction);
  assert.ok(highSummary.medianEventsPerTriplet > lowSummary.medianEventsPerTriplet);
  assert.ok(lowSummary.eligibleTripletFraction >= 0 && lowSummary.eligibleTripletFraction <= 1);
});

test("breakpoint matching maximizes one-to-one recall before minimizing localization error", () => {
  const match = matchBreakpoints([100, 140], [80, 119, 141], 21);
  assert.deepEqual(match.matches, [
    { truth: 100, predicted: 119, error: 19 },
    { truth: 140, predicted: 141, error: 1 },
  ]);
  const accuracy = breakpointAccuracy([100], [], 20);
  assert.equal(accuracy.recall, 0);
  assert.equal(accuracy.f1, 0);
});

test("normalized RF is zero for equivalent child order and positive for a changed split", () => {
  const first = "((a:0.1,b:0.1):0.2,(c:0.1,(d:0.1,e:0.1):0.2):0.2);";
  const reordered = "(((e:0.1,d:0.1):0.2,c:0.1):0.2,(b:0.1,a:0.1):0.2);";
  const changed = "((a:0.1,c:0.1):0.2,(b:0.1,(d:0.1,e:0.1):0.2):0.2);";
  assert.equal(normalizedRobinsonFoulds(first, reordered), 0);
  assert.ok(normalizedRobinsonFoulds(first, changed) > 0);
});

test("candidate-conditioned HMM intervals stay local at roughly ten percent divergence", () => {
  // This pinned replicate previously exposed the bug: marginal switch
  // probabilities from several recombination modes were globally normalized,
  // yielding 858–1,174 nt intervals on a 1,200 nt alignment.
  const simulation = simulateAlignment({
    taxa: 18,
    sites: 1_200,
    seed: 24_455_642,
    scenario: STRESS_SCENARIOS[0]!,
    branchLengthScale: 0.2,
  });
  const diversity = summarizeDiversity(simulation.sequences, 24);
  assert.ok(diversity.meanPairwiseDistance >= 0.07 && diversity.meanPairwiseDistance <= 0.12,
    `pinned replicate no longer represents ~10% divergence (p=${diversity.meanPairwiseDistance})`);
  const result = analyzeFsart(simulation.fasta, {
    window: 24,
    mergeDistance: 12,
    maximumSignals: 2_048,
    maximumSignalsPerTriplet: 2,
    maximumReportedSignals: 512,
    rateSlices: 9,
    credibleMass: 0.95,
    runFastTree: false,
  });
  assert.ok(result.breakpoints.length > 0, "the pinned replicate must exercise interval construction");
  for (const breakpoint of result.breakpoints) {
    assert.ok(breakpoint.intervalLow <= breakpoint.breakpoint && breakpoint.breakpoint <= breakpoint.intervalHigh);
    assert.ok(breakpoint.intervalHigh - breakpoint.intervalLow < 300,
      `candidate-local interval unexpectedly spans ${breakpoint.intervalLow}–${breakpoint.intervalHigh}`);
  }
});

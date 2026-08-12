import { assembleScanResult, buildTopologyDictionary, fitTreeHmm, parseFsartFasta, scanTripletShard, selectStepwisePartition, selectTreeBankBreakpoints, treeBankWindows } from "../src/index.js";
import { createFastTreeEvaluator, runFastTreeTopology } from "./fasttree.js";
import { normalizedRobinsonFoulds } from "./metrics.js";
import { DEFAULT_SCENARIOS, simulateAlignment } from "./simulator.js";

const binary = "/workspace/scratch/7f088fc1fd73/research-fasttree/FastTreeMP";
const simulation = simulateAlignment({ taxa: 9, sites: 3000, seed: 21_260_815, scenario: DEFAULT_SCENARIOS[1]!, branchLengthScale: 0.12 });
const alignment = parseFsartFasta(simulation.fasta);
const shard = scanTripletShard(alignment, { window: 24, maximumSignals: 2048, maximumSignalsPerTriplet: 2 });
const result = assembleScanResult(alignment, [shard], { window: 24, mergeDistance: 12, maximumSignals: 2048, maximumReportedSignals: 512, maximumPartitionCandidates: 24, runFastTree: false }, 0);
const evaluator = createFastTreeEvaluator(binary, simulation.fasta, true);
const partition = await selectStepwisePartition(result.breakpoints, evaluator.evaluate, { taxa: 9, sites: 3000, criterion: "aicc", minimumSegmentLength: 60, maximumBreakpoints: 8, maximumCandidates: 24 });
const cuts = selectTreeBankBreakpoints(result.breakpoints, 3000, 12, 60);
const jobs = [...cuts.flatMap((candidate) => [{ start: 1, end: candidate.breakpoint }, { start: candidate.breakpoint + 1, end: 3000 }]), ...treeBankWindows(3000, 60)];
const independent = (await Promise.all(jobs.map((job) => evaluator.evaluate(job.start, job.end))));
const prioritized = [...partition.candidateTrees.filter((x) => x.start === 1 && x.end === 3000), ...independent, ...partition.segments, ...partition.candidateTrees];
const global = prioritized[0]!;
const unique = buildTopologyDictionary(prioritized, 3000, 8);
console.log("unscored trees", unique.map((item) => [item.segment.start, item.segment.end, item.segment.tree]));
const profiles = [];
for (let index = 0; index < unique.length; index += 1) {
  const item = unique[index]!;
  profiles.push(await runFastTreeTopology(binary, simulation.fasta, simulation.names, 3000, { id: `T${index + 1}`, tree: item.segment.tree, sourceStart: item.segment.start, sourceEnd: item.segment.end, topologySignature: item.signature }, { gtrFrequencies: global.gtrFrequencies!, gtrRates: global.gtrRates! }, 4));
}
console.log("truth", simulation.trueBreakpoints, "partition", partition.acceptedBreakpoints, "trees", unique.map((x) => [x.segment.start, x.segment.end]));
console.log("partition steps", partition.steps.map((step) => [step.breakpoint, step.deltaCriterion, step.accepted]));
console.log("tree-bank cuts", cuts.map((x) => [x.rank, x.breakpoint]));
console.log("tree RFs", unique.map((x) => simulation.trueSegments.map((truth) => normalizedRobinsonFoulds(x.segment.tree, truth.tree))));
console.log("ranked candidates", result.breakpoints.slice(0, 24).map((x) => [x.rank, x.breakpoint, x.intervalLow, x.intervalHigh, x.supportLow, x.supportHigh, x.evidence]));
for (const profile of profiles) {
  const segmentLogLs = simulation.trueSegments.map((segment) => Array.from(profile.siteLogLikelihoods).slice(segment.start - 1, segment.end).reduce((a, b) => a + b, 0));
  console.log(profile.id, profile.logLikelihood, segmentLogLs);
}
const hmm = fitTreeHmm(profiles, { taxa: 9, criterion: "aicc", maximumRateSlices: 13, credibleMass: 0.95 });
console.log("HMM", hmm.states.map((state) => [state.id, state.sourceStart, state.sourceEnd, state.expectedSites]), hmm.deltaCriterion, hmm.switchIntervals);
const switches = Array.from(hmm.switchPosterior);
const peak = switches.indexOf(Math.max(...switches));
const sorted = switches.slice().sort((a, b) => a - b);
const background = sorted[Math.floor(sorted.length * 0.2)]!;
for (const fraction of [0.5, 0.2, 0.1, 0.05, 0.02, 0.01]) {
  const threshold = background + fraction * (switches[peak]! - background);
  let low = peak;
  let high = peak;
  while (low > 0 && switches[low - 1]! >= threshold) low -= 1;
  while (high + 1 < switches.length && switches[high + 1]! >= threshold) high += 1;
  console.log("mode", fraction, low + 1, high + 1, threshold);
}

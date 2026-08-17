import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { cpus, platform, release } from "node:os";
import { resolve } from "node:path";
import {
  assembleScanResult,
  canonicalTopologySignature,
  effectiveMinimumTreeSpan,
  fitTreeHmm,
  isFullyResolvedTopology,
  parseFsartFasta,
  scanTripletShard,
  scoreFrozenTreeProfile,
  selectTreeHypotheses,
  selectStepwisePartition,
  treeFamilyWindows,
  type MergedBreakpoint,
  type RawTripletSignal,
  type SegmentLikelihood,
  type StepwisePartitionResult,
  type TreeEmissionProfile,
} from "../src/index.js";
import { breakpointAccuracy, normalizedRobinsonFoulds, partitionTopologyRf, type BreakpointInterval } from "./metrics.js";
import { summarizeDiversity } from "./diversity.js";
import { createFastTreeEvaluator, type FastTreeEvaluator } from "./fasttree.js";
import { benchmarkSvg, markdownReport, replicateCsv, summaryCsv } from "./report.js";
import { summarizeResults, type ApproachResult, type BenchmarkResult, type ReplicateResult } from "./results.js";
import { DEFAULT_DIVERSITIES, DEFAULT_SCENARIOS, simulateAlignment, type DiversityRegime, type TrueSegment } from "./simulator.js";

interface CliOptions {
  readonly taxa: number;
  readonly sites: number;
  readonly replicates: number;
  readonly seed: number;
  readonly tolerance: number;
  readonly output: string;
  readonly fastTree: string | null;
  readonly fastest: boolean;
  readonly window: number;
  readonly mergeDistance: number;
  readonly diversities: readonly DiversityRegime[];
}

function identifyFastTree(binary: string | null): string | null {
  if (binary === null) return null;
  const result = spawnSync(binary, ["-help"], { encoding: "utf8", maxBuffer: 1_000_000 });
  const line = `${result.stderr ?? ""}\n${result.stdout ?? ""}`
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => value.startsWith("FastTree "));
  return line?.replace(/:$/, "") ?? null;
}

function parseArguments(argv: readonly string[]): CliOptions {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index < 0 ? undefined : argv[index + 1];
  };
  const quick = argv.includes("--quick");
  const numeric = (name: string, fallback: number): number => {
    const parsed = Number(value(name) ?? fallback);
    if (!Number.isFinite(parsed)) throw new Error(`${name} must be numeric.`);
    return parsed;
  };
  const fastTreeArgument = value("--fasttree") ?? process.env.FSART_FASTTREE;
  const requestedScales = (value("--diversity-scales") ?? DEFAULT_DIVERSITIES.map((item) => item.branchLengthScale).join(","))
    .split(",")
    .map((item) => Number(item.trim()));
  if (requestedScales.length === 0 || requestedScales.some((item) => !(item > 0) || !Number.isFinite(item))) {
    throw new Error("--diversity-scales must be a comma-separated list of positive numbers.");
  }
  const diversities = requestedScales.map((scale, index): DiversityRegime => {
    const preset = DEFAULT_DIVERSITIES.find((item) => Math.abs(item.branchLengthScale - scale) < 1e-12);
    return preset ?? { id: `scale-${String(scale).replaceAll(".", "p")}`, label: `Branch scale ${scale}`, branchLengthScale: scale };
  });
  return {
    taxa: Math.round(numeric("--taxa", quick ? 8 : 9)),
    sites: Math.round(numeric("--sites", quick ? 1200 : 3000)),
    replicates: Math.round(numeric("--replicates", quick ? 2 : 20)),
    seed: Math.round(numeric("--seed", 20260812)),
    tolerance: Math.round(numeric("--tolerance", Math.max(30, Math.round(numeric("--sites", quick ? 1200 : 3000) * 0.02)))),
    output: resolve(value("--out") ?? "simulations/results"),
    fastTree: argv.includes("--no-fasttree") ? null : fastTreeArgument ?? null,
    fastest: !argv.includes("--thorough-fasttree"),
    window: Math.round(numeric("--window", 24)),
    mergeDistance: Math.round(numeric("--merge-distance", 12)),
    diversities,
  };
}

interface RawCandidate {
  readonly breakpoint: number;
  readonly rawP: number;
  readonly evidence: number;
}

function rawCandidates(
  signals: readonly RawTripletSignal[],
  mergeDistance: number,
  maximum = 64,
): RawCandidate[] {
  const passing = signals.map((signal) => ({
    breakpoint: signal.breakpoint,
    rawP: Math.exp(signal.logP),
    evidence: -signal.logP / Math.log(10),
  })).sort((a, b) => b.evidence - a.evidence || a.breakpoint - b.breakpoint);
  const clusters: { low: number; high: number; strongest: RawCandidate }[] = [];
  for (const signal of passing) {
    const cluster = clusters.find((value) => Math.abs(value.strongest.breakpoint - signal.breakpoint) <= mergeDistance);
    if (cluster === undefined) {
      clusters.push({ low: signal.breakpoint, high: signal.breakpoint, strongest: signal });
    } else {
      cluster.high = Math.max(cluster.high, signal.breakpoint);
      if (signal.evidence > cluster.strongest.evidence) cluster.strongest = signal;
    }
  }
  return clusters.map((cluster) => cluster.strongest).sort((a, b) => b.evidence - a.evidence).slice(0, maximum);
}

function oracleBreakpoints(values: readonly number[]): MergedBreakpoint[] {
  return values.map((breakpoint, index) => ({
    id: `TRUE${index + 1}`,
    rank: index + 1,
    breakpoint,
    intervalLow: breakpoint,
    intervalHigh: breakpoint,
    supportLow: breakpoint,
    supportHigh: breakpoint,
    evidence: values.length - index,
    consensusScore: values.length - index,
    strengthScore: values.length - index,
    adjustedP: 0,
    supportTriplets: 0,
    supportTaxa: 0,
    representative: {} as MergedBreakpoint["representative"],
    memberIndexes: [],
  }));
}

function intervals(values: readonly { readonly breakpoint: number; readonly intervalLow?: number; readonly intervalHigh?: number }[]): BreakpointInterval[] {
  return values.map((value) => ({
    breakpoint: value.breakpoint,
    ...(value.intervalLow === undefined ? {} : { low: value.intervalLow }),
    ...(value.intervalHigh === undefined ? {} : { high: value.intervalHigh }),
  }));
}

async function fitPartition(
  candidates: readonly MergedBreakpoint[],
  fasta: string,
  fastTree: string,
  taxa: number,
  sites: number,
  fastest: boolean,
): Promise<{ readonly partition: StepwisePartitionResult; readonly wallMs: number; readonly freshFits: number; readonly evaluator: FastTreeEvaluator }> {
  const evaluator = createFastTreeEvaluator(fastTree, fasta, fastest);
  const started = performance.now();
  const partition = await selectStepwisePartition(candidates, evaluator.evaluate, {
    taxa,
    sites,
    criterion: "aicc",
    minimumSegmentLength: Math.max(60, 2 * taxa),
    maximumBreakpoints: 8,
    maximumCandidates: 24,
  });
  return { partition, wallMs: performance.now() - started, freshFits: evaluator.diagnostics().freshFits, evaluator };
}

function expectedTreeHmmRf(
  posterior: Float32Array,
  states: readonly { readonly tree: string }[],
  sites: number,
  truth: readonly TrueSegment[],
): number | null {
  if (states.length === 0 || sites === 0) return null;
  let total = 0;
  for (const segment of truth) {
    for (let state = 0; state < states.length; state += 1) {
      const distance = normalizedRobinsonFoulds(states[state]!.tree, segment.tree);
      for (let site = segment.start - 1; site < segment.end; site += 1) total += posterior[state * sites + site]! * distance;
    }
  }
  return total / sites;
}

async function fitTreeHmmBenchmark(
  candidates: readonly MergedBreakpoint[],
  evaluator: FastTreeEvaluator,
  fasta: string,
  names: readonly string[],
  fastTree: string,
  taxa: number,
  sites: number,
  truth: readonly TrueSegment[],
  minimumSegmentLength: number,
): Promise<{
  readonly breakpoints: readonly BreakpointInterval[];
  readonly topologyRf: number | null;
  readonly wallMs: number;
  readonly fastTreeFits: number;
  readonly status: string;
}> {
  const started = performance.now();
  const fitsBefore = evaluator.diagnostics().freshFits;
  const jobs = treeFamilyWindows(candidates.map((candidate) => candidate.breakpoint), sites, minimumSegmentLength);
  const topologySources: SegmentLikelihood[] = [];
  for (const job of jobs) topologySources.push(await evaluator.evaluate(job.start, job.end));
  const global = topologySources.find((candidate) => candidate.start === 1 && candidate.end === sites);
  if (global?.gtrFrequencies === undefined || global.gtrRates === undefined) {
    return { breakpoints: [], topologyRf: null, wallMs: performance.now() - started, fastTreeFits: evaluator.diagnostics().freshFits - fitsBefore, status: "No shared GTR fit." };
  }
  const hypotheses = selectTreeHypotheses(topologySources, sites, 1000);
  const hasGlobalNull = hypotheses[0]?.segment.start === 1 && hypotheses[0]?.segment.end === sites;
  if (hypotheses.length < 2 || !hasGlobalNull) {
    return { breakpoints: [], topologyRf: partitionTopologyRf([global], truth), wallMs: performance.now() - started, fastTreeFits: evaluator.diagnostics().freshFits - fitsBefore, status: `Only one resolved full-tree fit from ${jobs.length} family fits.` };
  }
  let profiles: TreeEmissionProfile[] = [];
  for (let index = 0; index < hypotheses.length; index += 1) {
    const candidate = hypotheses[index]!;
    try {
      if (candidate.segment.gammaAlpha === undefined) throw new Error("Source fit has no Gamma shape.");
      profiles.push(scoreFrozenTreeProfile(fasta, {
        id: `T${profiles.length + 1}`,
        tree: candidate.segment.tree,
        sourceStart: candidate.segment.start,
        sourceEnd: candidate.segment.end,
        topologySignature: candidate.signature,
        gammaAlpha: candidate.segment.gammaAlpha,
      }, { gtrFrequencies: global.gtrFrequencies, gtrRates: global.gtrRates }));
    } catch (error) {
      if (index === 0) throw error;
      process.stderr.write(`\n  skipped unusable full-tree fit ${index + 1}: ${error instanceof Error ? error.message.split("\n", 1)[0] : String(error)}\n  `);
    }
  }
  if (profiles.length < 2) return { breakpoints: [], topologyRf: partitionTopologyRf([global], truth), wallMs: performance.now() - started, fastTreeFits: evaluator.diagnostics().freshFits - fitsBefore, status: "Fewer than two frozen full trees could be scored." };
  const globalProfile = profiles[0]!;
  let result = fitTreeHmm(profiles, {
    taxa,
    criterion: "aicc",
    maximumRateSlices: 13,
    credibleMass: 0.95,
    maximumStates: 8,
    beamWidth: 4,
    minimumRunLength: minimumSegmentLength,
    searchMode: "rapid",
  });
  let converged = false;
  let refinementIterations = 0;
  for (let iteration = 1; iteration <= 3 && result.states.length > 1 && result.viterbi !== undefined; iteration += 1) {
    const previousBreakpoints = result.viterbi.breakpoints;
    const previousTrees = result.states.map((state) => state.tree).sort();
    const rangesByTree = new Map<string, [number, number][]>();
    for (const run of result.viterbi.runs) {
      const ranges = rangesByTree.get(run.treeId);
      if (ranges === undefined) rangesByTree.set(run.treeId, [[run.start, run.end]]);
      else ranges.push([run.start, run.end]);
    }
    const refitted = [];
    for (const state of result.states) {
      const ranges = rangesByTree.get(state.id) ?? [];
      const assignedSites = ranges.reduce((sum, [start, end]) => sum + end - start + 1, 0);
      if (assignedSites < minimumSegmentLength) continue;
      const score = await evaluator.evaluateRanges(ranges);
      if (!isFullyResolvedTopology(score.tree)) continue;
      refitted.push({ ranges, assignedSites, score, signature: canonicalTopologySignature(score.tree) });
    }
    const nextProfiles: TreeEmissionProfile[] = [globalProfile];
    for (const value of refitted) {
      if (value.score.gammaAlpha === undefined) continue;
      nextProfiles.push(scoreFrozenTreeProfile(fasta, {
        id: `R${iteration}T${nextProfiles.length}`,
        tree: value.score.tree,
        sourceStart: value.score.start,
        sourceEnd: value.score.end,
        sourceRanges: value.ranges,
        topologySignature: value.signature,
        gammaAlpha: value.score.gammaAlpha,
      }, { gtrFrequencies: global.gtrFrequencies, gtrRates: global.gtrRates }));
    }
    const next = fitTreeHmm(nextProfiles, {
      taxa,
      criterion: "aicc",
      maximumRateSlices: 13,
      credibleMass: 0.95,
      maximumStates: Math.min(8, nextProfiles.length),
      beamWidth: 4,
      minimumRunLength: minimumSegmentLength,
      searchMode: "rapid",
    });
    const nextBreakpoints = next.viterbi?.breakpoints ?? [];
    const nextTrees = next.states.map((state) => state.tree).sort();
    const topologyChanged = previousTrees.length !== nextTrees.length
      || previousTrees.some((value, index) => value !== nextTrees[index]);
    const maximumShift = previousBreakpoints.length === nextBreakpoints.length
      ? previousBreakpoints.reduce((maximum, value, index) => Math.max(maximum, Math.abs(value - nextBreakpoints[index]!)), 0)
      : Infinity;
    profiles = nextProfiles;
    result = next;
    refinementIterations = iteration;
    if (!topologyChanged && maximumShift <= 3) {
      converged = true;
      break;
    }
  }
  const viterbiBreakpoints = result.viterbi?.breakpoints ?? [];
  const breakpointIntervals = viterbiBreakpoints.map((breakpoint) => {
    const interval = result.switchIntervals.slice().sort((a, b) => Math.abs(a.breakpoint - breakpoint) - Math.abs(b.breakpoint - breakpoint))[0];
    return interval === undefined
      ? { breakpoint }
      : { breakpoint, low: interval.intervalLow, high: interval.intervalHigh };
  });
  return {
    breakpoints: breakpointIntervals,
    topologyRf: expectedTreeHmmRf(result.statePosterior, result.states, result.sites, truth),
    wallMs: performance.now() - started,
    fastTreeFits: evaluator.diagnostics().freshFits - fitsBefore,
    status: result.status === "complete"
      ? `${jobs.length} family trees; ${hypotheses.length} frozen full-tree hypotheses; ${result.subsetSearch?.evaluatedSubsets ?? 0} cached subset tests; ${result.states.length} states; ${refinementIterations} refinements (${converged ? "converged" : "not required"}); delta AICc ${result.deltaCriterion?.toFixed(3)}; logL ${result.logLikelihood?.toFixed(3)} vs null ${result.nullLogLikelihood?.toFixed(3)}`
      : result.message ?? result.status,
  };
}

async function runReplicate(
  options: CliOptions,
  diversity: DiversityRegime,
  scenarioIndex: number,
  replicate: number,
): Promise<ReplicateResult> {
  const scenario = DEFAULT_SCENARIOS[scenarioIndex]!;
  const seed = (options.seed + scenarioIndex * 1_000_003 + replicate * 97_409) >>> 0;
  const simulationStarted = performance.now();
  const simulated = simulateAlignment({
    taxa: options.taxa,
    sites: options.sites,
    seed,
    scenario,
    branchLengthScale: diversity.branchLengthScale,
  });
  const simulationMs = performance.now() - simulationStarted;
  const diversitySummary = summarizeDiversity(simulated.sequences, options.window);
  const alignment = parseFsartFasta(simulated.fasta);
  const minimumSegmentLength = effectiveMinimumTreeSpan(
    options.taxa,
    options.sites,
    alignment.variableSites.length,
    150,
  );
  const scanStarted = performance.now();
  const shard = scanTripletShard(alignment, {
    window: options.window,
    maximumSignals: 2048,
    maximumSignalsPerTriplet: 4,
  });
  const scanMs = performance.now() - scanStarted;
  const raw = rawCandidates(shard.signals, options.mergeDistance);
  const assembled = assembleScanResult(alignment, [shard], {
    window: options.window,
    mergeDistance: options.mergeDistance,
    maximumSignals: 2048,
    maximumReportedSignals: 512,
    rateSlices: 9,
    credibleMass: 0.95,
    runFastTree: false,
    minimumSegmentLength,
  }, scanMs);
  const truth = simulated.trueBreakpoints;
  const approaches: ApproachResult[] = [
    {
      approach: "ranked-window",
      predictedBreakpoints: raw.map((value) => value.breakpoint),
      accuracy: breakpointAccuracy(truth, intervals(raw), options.tolerance),
      topologyRf: null,
      wallMs: scanMs,
      fastTreeFreshFits: 0,
      status: "complete",
    },
    {
      approach: "local-hmm-merged",
      predictedBreakpoints: assembled.breakpoints.map((value) => value.breakpoint),
      accuracy: breakpointAccuracy(truth, intervals(assembled.breakpoints), options.tolerance),
      topologyRf: null,
      wallMs: scanMs + assembled.timings.hmmMs! + assembled.timings.mergeMs!,
      fastTreeFreshFits: 0,
      status: "complete",
    },
  ];

  if (options.fastTree !== null) {
    // The deployed browser path does not invoke FastTree when the scan admits no
    // breakpoint candidates. Time that path the same way here. We still fit the
    // separate single-tree diagnostic below so its topology can describe the
    // unsplit partition without charging that fit to FSART's wall time.
    const baselineEvaluator = createFastTreeEvaluator(options.fastTree, simulated.fasta, options.fastest);
    const baselineStarted = performance.now();
    const baseline = await baselineEvaluator.evaluate(1, options.sites);
    const baselineWallMs = performance.now() - baselineStarted;
    const baselineTopologyRf = partitionTopologyRf([baseline], simulated.trueSegments);

    if (assembled.breakpoints.length === 0) {
      approaches.push({
        approach: "stepwise-aicc",
        predictedBreakpoints: [],
        accuracy: breakpointAccuracy(truth, [], options.tolerance),
        topologyRf: baselineTopologyRf,
        wallMs: scanMs + assembled.timings.hmmMs! + assembled.timings.mergeMs!,
        fastTreeFreshFits: 0,
        status: "No ranked candidates; FastTree skipped.",
      });
      approaches.push({
        approach: "tree-hmm-aicc",
        predictedBreakpoints: [],
        accuracy: breakpointAccuracy(truth, [], options.tolerance),
        topologyRf: baselineTopologyRf,
        wallMs: scanMs + assembled.timings.hmmMs! + assembled.timings.mergeMs!,
        fastTreeFreshFits: 0,
        status: "No topology dictionary could be generated.",
      });
    } else {
      const actual = await fitPartition(assembled.breakpoints, simulated.fasta, options.fastTree, options.taxa, options.sites, options.fastest);
      const actualPredictions = actual.partition.acceptedBreakpoints;
      const actualIntervals = actualPredictions.map((breakpoint) => {
        const source = assembled.breakpoints.find((value) => value.breakpoint === breakpoint);
        return source === undefined ? { breakpoint } : { breakpoint, low: source.intervalLow, high: source.intervalHigh };
      });
      approaches.push({
        approach: "stepwise-aicc",
        predictedBreakpoints: actualPredictions,
        accuracy: breakpointAccuracy(truth, actualIntervals, options.tolerance),
        topologyRf: partitionTopologyRf(actual.partition.segments, simulated.trueSegments),
        wallMs: scanMs + assembled.timings.hmmMs! + assembled.timings.mergeMs! + actual.wallMs,
        fastTreeFreshFits: actual.freshFits,
        status: actual.partition.status,
      });
      const hmmEvaluator = createFastTreeEvaluator(options.fastTree, simulated.fasta, options.fastest);
      const topologyHmm = await fitTreeHmmBenchmark(assembled.breakpoints, hmmEvaluator, simulated.fasta, simulated.names, options.fastTree, options.taxa, options.sites, simulated.trueSegments, minimumSegmentLength);
      approaches.push({
        approach: "tree-hmm-aicc",
        predictedBreakpoints: topologyHmm.breakpoints.map((value) => value.breakpoint),
        accuracy: breakpointAccuracy(truth, topologyHmm.breakpoints, options.tolerance),
        topologyRf: topologyHmm.topologyRf,
        wallMs: scanMs + assembled.timings.hmmMs! + assembled.timings.mergeMs! + topologyHmm.wallMs,
        fastTreeFreshFits: topologyHmm.fastTreeFits,
        status: topologyHmm.status,
      });
    }

    if (truth.length === 0) {
      approaches.push({
        approach: "oracle-aicc",
        predictedBreakpoints: [],
        accuracy: breakpointAccuracy(truth, [], options.tolerance),
        topologyRf: baselineTopologyRf,
        wallMs: 0,
        fastTreeFreshFits: 0,
        status: "No true breakpoint candidates; FastTree skipped.",
      });
    } else {
      const oracle = await fitPartition(oracleBreakpoints(truth), simulated.fasta, options.fastTree, options.taxa, options.sites, options.fastest);
      approaches.push({
        approach: "oracle-aicc",
        predictedBreakpoints: oracle.partition.acceptedBreakpoints,
        accuracy: breakpointAccuracy(truth, intervals(oracle.partition.acceptedBreakpoints.map((breakpoint) => ({ breakpoint }))), options.tolerance),
        topologyRf: partitionTopologyRf(oracle.partition.segments, simulated.trueSegments),
        wallMs: oracle.wallMs,
        fastTreeFreshFits: oracle.freshFits,
        status: oracle.partition.status,
      });
    }

    approaches.push({
      approach: "single-tree",
      predictedBreakpoints: [],
      accuracy: null,
      topologyRf: baselineTopologyRf,
      wallMs: baselineWallMs,
      fastTreeFreshFits: baselineEvaluator.diagnostics().freshFits,
      status: "topology baseline",
    });
  }

  return {
    diversityId: diversity.id,
    diversityLabel: diversity.label,
    branchLengthScale: diversity.branchLengthScale,
    scenarioId: scenario.id,
    scenarioLabel: scenario.label,
    replicate: replicate + 1,
    seed,
    taxa: options.taxa,
    sites: options.sites,
    tolerance: options.tolerance,
    trueBreakpoints: truth,
    simulationMs,
    scanMs,
    hmmMs: assembled.timings.hmmMs!,
    mergeMs: assembled.timings.mergeMs!,
    rateSummary: simulated.rateSummary,
    diversitySummary,
    approaches,
  };
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options.taxa < 4 || options.sites < 200 || options.replicates < 1) throw new Error("Use at least 4 taxa, 200 sites, and 1 replicate.");
  if (options.fastTree === null) console.warn("FastTree was not configured; partition/oracle/topology rows will be omitted. Set FSART_FASTTREE or pass --fasttree PATH.");
  const replicates: ReplicateResult[] = [];
  const total = options.diversities.length * DEFAULT_SCENARIOS.length * options.replicates;
  for (const diversity of options.diversities) {
    for (let scenarioIndex = 0; scenarioIndex < DEFAULT_SCENARIOS.length; scenarioIndex += 1) {
      for (let replicate = 0; replicate < options.replicates; replicate += 1) {
        const completed = replicates.length;
        const scenario = DEFAULT_SCENARIOS[scenarioIndex]!;
        process.stderr.write(`[${completed + 1}/${total}] ${diversity.id}/${scenario.id} replicate ${replicate + 1} ... `);
        const result = await runReplicate(options, diversity, scenarioIndex, replicate);
        replicates.push(result);
        const hmm = result.approaches.find((value) => value.approach === "local-hmm-merged")!;
        process.stderr.write(`p=${result.diversitySummary.meanPairwiseDistance.toFixed(3)}; ${hmm.predictedBreakpoints.length} HMM breakpoints; ${(hmm.wallMs / 1000).toFixed(2)} s\n`);
      }
    }
  }
  const summaries = summarizeResults(replicates);
  const benchmark: BenchmarkResult = {
    generatedAt: new Date().toISOString(),
    config: {
      taxa: options.taxa,
      sites: options.sites,
      replicates: options.replicates,
      seed: options.seed,
      tolerance: options.tolerance,
      window: options.window,
      mergeDistance: options.mergeDistance,
      intervalConditioning: "candidate-window-local-posterior-basin",
      fastTree: options.fastTree !== null,
      fastTreeFastest: options.fastest,
      scenarios: DEFAULT_SCENARIOS,
      diversities: options.diversities,
    },
    environment: {
      node: process.version,
      platform: platform(),
      osRelease: release(),
      logicalCpus: cpus().length,
      fastTreeBinary: options.fastTree,
      fastTreeVersion: identifyFastTree(options.fastTree),
      scannerWorkers: 1,
    },
    replicates,
    summaries,
  };
  await mkdir(options.output, { recursive: true });
  await Promise.all([
    writeFile(resolve(options.output, "results.json"), `${JSON.stringify(benchmark, null, 2)}\n`),
    writeFile(resolve(options.output, "replicates.csv"), replicateCsv(replicates)),
    writeFile(resolve(options.output, "summary.csv"), summaryCsv(summaries)),
    writeFile(resolve(options.output, "REPORT.md"), markdownReport(benchmark)),
    writeFile(resolve(options.output, "accuracy-timing.svg"), benchmarkSvg(benchmark)),
  ]);
  console.log(`Wrote FSART simulation benchmark to ${options.output}`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});

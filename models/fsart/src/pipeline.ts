import { combinationCount3, parseFsartFasta } from "./alignment.js";
import { refineTripletSignals } from "./hmm.js";
import { consensusBreakpointSignals } from "./merge.js";
import { effectiveMinimumTreeSpan } from "./tree-bank.js";
import { scanTripletShard } from "./scanner.js";
import { skippedTreeHmm } from "./tree-hmm.js";
import { skippedSprReconstruction } from "./spr-reconstruction.js";
import type {
  FsartAlignment,
  FsartAnalysisOptions,
  FsartAnalysisResult,
  MergedBreakpoint,
  RefinedTripletSignal,
  ScanShardResult,
  StepwisePartitionResult,
} from "./types.js";

function quote(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function breakpointsToCsv(breakpoints: readonly MergedBreakpoint[]): string {
  const header = [
    "Rank", "Breakpoint after site", "Candidate-local CI low", "Candidate-local CI high",
    "Merge envelope low", "Merge envelope high", "Consensus score", "Accumulated strength", "-log10 raw p", "Raw p", "Bonferroni audit p (not used for admission)",
    "Supporting triplets", "Supporting taxa", "Representative taxon A", "Representative taxon B",
    "Representative taxon C", "HMM switch posterior", "HMM emission accuracy",
  ];
  const rows = breakpoints.map((value) => [
    value.rank, value.breakpoint, value.intervalLow, value.intervalHigh, value.supportLow, value.supportHigh,
    value.consensusScore, value.strengthScore, value.evidence, value.representative.rawP, value.adjustedP, value.supportTriplets, value.supportTaxa,
    ...value.representative.taxaNames.map(quote), value.representative.switchPosterior, value.representative.emissionAccuracy,
  ].join(","));
  return `${header.join(",")}\n${rows.join("\n")}\n`;
}

export function partitionToCsv(partition: StepwisePartitionResult): string {
  const header = ["Run", "Start", "End", "Aligned sites", "Variable sites", "Tree log likelihood over run", "Newick tree"];
  const rows = partition.segments.map((segment) => [
    quote(segment.id), segment.start, segment.end, segment.end - segment.start + 1, segment.variableSites,
    segment.logLikelihood, quote(segment.tree),
  ].join(","));
  return `${header.join(",")}\n${rows.join("\n")}\n`;
}

export function skippedPartition(criterion: FsartAnalysisOptions["criterion"], message: string): StepwisePartitionResult {
  return {
    status: "skipped",
    criterion: criterion ?? "aicc",
    criterionValue: null,
    segments: [],
    candidateTrees: [],
    steps: [],
    acceptedBreakpoints: [],
    rejectedBreakpoints: [],
    message,
  };
}

export function assembleScanResult(
  alignment: FsartAlignment,
  shards: readonly ScanShardResult[],
  options: FsartAnalysisOptions,
  scanMs: number,
): FsartAnalysisResult {
  const testedBoundaries = shards.reduce((sum, shard) => sum + shard.testedBoundaries, 0);
  const scannedTriplets = shards.reduce((sum, shard) => sum + shard.scannedTriplets, 0);
  const informativeTriplets = shards.reduce((sum, shard) => sum + shard.informativeTriplets, 0);
  const maximumSignals = Math.max(1, Math.round(options.maximumSignals ?? 512));
  const raw = shards.flatMap((shard) => shard.signals).sort((a, b) => a.logP - b.logP).slice(0, maximumSignals);
  const hmmStarted = performance.now();
  options.onStage?.("breakpoint-hmm", 0, { message: "Initializing topology emissions from event runs; marginalizing the switching-rate grid", indeterminate: true });
  const tripletSignals = refineTripletSignals(alignment, raw, testedBoundaries, {
    ...options,
    onProgress: (fraction, detail) => options.onStage?.("breakpoint-hmm", fraction, detail),
  });
  const hmmMs = performance.now() - hmmStarted;
  const mergeStarted = performance.now();
  const feasibleMinimum = effectiveMinimumTreeSpan(
    alignment.taxa,
    alignment.sites,
    alignment.variableSites.length,
    options.minimumSegmentLength ?? 150,
  );
  const breakpoints = consensusBreakpointSignals(tripletSignals, {
    mergeDistance: options.mergeDistance ?? 12,
    minimumSpacing: feasibleMinimum,
    sites: alignment.sites,
    maximumCandidates: options.maximumConsensusBreakpoints ?? 14,
  });
  const mergeMs = performance.now() - mergeStarted;
  const partition = skippedPartition(options.criterion, options.runFastTree === false
    ? "FastTree tree-family reconstruction was disabled."
    : "FastTree tree-family fitting and the cached topology-HMM are performed by the browser's local WASM runner after the triplet scan.");
  const diagnostics = {
    taxa: alignment.taxa,
    sites: alignment.sites,
    variableSites: alignment.variableSites.length,
    totalTriplets: combinationCount3(alignment.taxa),
    scannedTriplets,
    tripletSampling: scannedTriplets === combinationCount3(alignment.taxa) ? "exhaustive" as const : "pair-covered" as const,
    pairCoverageGuaranteed: shards.every((shard) => shard.pairCoverageGuaranteed),
    totalTaxonPairs: alignment.taxa * (alignment.taxa - 1) / 2,
    informativeTriplets,
    testedBoundaries,
    scanWindow: Math.max(4, Math.round(options.window ?? 24)),
    minimumTreeSpan: feasibleMinimum,
    expectedVariableSitesPerMinimumSpan: feasibleMinimum * alignment.variableSites.length / alignment.sites,
    parallelWorkers: shards.length,
    multipleTesting: "none-ranked-candidate-generation" as const,
    breakpointUncertainty: "three-state-burt-style-hmm-rate-marginalization" as const,
    intervalConditioning: "candidate-window-local-posterior-basin" as const,
    exactBurtParity: false as const,
    baumWelch: false as const,
    scanner: "bitset-informative-event-g-test" as const,
    pairEqualityCache: alignment.pairEqualMasks !== undefined,
    bitsetWords: alignment.bitsetWords ?? Math.ceil(alignment.sites / 32),
  };
  return {
    method: "fsart",
    breakpoints,
    tripletSignals,
    partition,
    treeHmm: skippedTreeHmm("Tree-HMM scoring is performed after local FastTree-WASM has generated fixed-topology site likelihoods.", options.criterion),
    treeHmmProfiles: [],
    sprReconstruction: skippedSprReconstruction("The unrestricted SPR graph is built after the browser has generated the FastTree proposal family."),
    discordantClades: [],
    diagnostics,
    timings: { scanMs, hmmMs, mergeMs, totalMs: scanMs + hmmMs + mergeMs },
    breakpointCsv: breakpointsToCsv(breakpoints),
    partitionCsv: partitionToCsv(partition),
    treeHmmCsv: "Tree HMM was not run.\n",
  };
}

export function analyzeFsart(fasta: string | FsartAlignment, options: FsartAnalysisOptions = {}): FsartAnalysisResult {
  const started = performance.now();
  const alignment = typeof fasta === "string" ? parseFsartFasta(fasta) : fasta;
  options.onStage?.("initialization", 1, {
    message: `${alignment.taxa.toLocaleString()} taxa · ${alignment.sites.toLocaleString()} sites · ${combinationCount3(alignment.taxa).toLocaleString()} triplets`,
  });
  const scanStarted = performance.now();
  const shard = scanTripletShard(alignment, {
    ...options,
    onProgress: (fraction, detail) => options.onStage?.("triplet-scan", fraction, detail),
  });
  const result = assembleScanResult(alignment, [shard], options, performance.now() - scanStarted);
  const totalMs = performance.now() - started;
  options.onStage?.("complete", 1, { message: `${result.breakpoints.length} consensus breakpoint proposals reported` });
  return { ...result, timings: { ...result.timings, totalMs } };
}

export function replacePartition(
  result: FsartAnalysisResult,
  partition: StepwisePartitionResult,
  discordantClades = result.discordantClades,
): FsartAnalysisResult {
  return { ...result, partition, discordantClades, partitionCsv: partitionToCsv(partition) };
}

export function treeHmmToCsv(result: FsartAnalysisResult["treeHmm"]): string {
  if (result.status !== "complete") return `${result.message ?? "Tree HMM was not run."}\n`;
  const header = ["Site", "Marginal MAP tree", "Viterbi tree", "Switch after site posterior", ...result.states.map((state) => `${state.id} posterior`)];
  const rows = Array.from({ length: result.sites }, (_, site) => [
    site + 1,
    result.states[result.mapState[site] ?? 0]?.id ?? "",
    result.states[result.viterbi?.statePath[site] ?? result.mapState[site] ?? 0]?.id ?? "",
    site + 1 < result.sites ? result.switchPosterior[site] ?? 0 : "",
    ...result.states.map((_state, state) => result.statePosterior[state * result.sites + site] ?? 0),
  ].join(","));
  return `${header.join(",")}\n${rows.join("\n")}\n`;
}

export function replaceTreeHmm(result: FsartAnalysisResult, treeHmm: FsartAnalysisResult["treeHmm"]): FsartAnalysisResult {
  return { ...result, treeHmm, treeHmmCsv: treeHmmToCsv(treeHmm) };
}

export function replaceSprReconstruction(
  result: FsartAnalysisResult,
  sprReconstruction: FsartAnalysisResult["sprReconstruction"],
): FsartAnalysisResult {
  return { ...result, sprReconstruction };
}

export type { RefinedTripletSignal };

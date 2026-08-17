import {
  buildTopologyDictionary,
  canonicalTopologySignature,
  effectiveMinimumTreeSpan,
  planPairCoveredTriplets,
  findDiscordantClades,
  isFullyResolvedTopology,
  replacePartition,
  replaceTreeHmm,
  skippedPartition,
  skippedTreeHmm,
  treeFamilyWindows,
  type FsartAnalysisResult,
  type InformationCriterion,
  type ScanShardResult,
  type SegmentLikelihood,
  type PartitionSegment,
  type StepwisePartitionResult,
  type TreeEmissionProfile,
  type TreeHmmResult,
  type TreeHmmRefinementIteration,
  type TreeHmmRefinementResult,
  type TripletSamplingPlan,
} from "@phylo-workbench/model-fsart/browser-source";
import type { ParameterValues } from "@phylo-workbench/model-sdk";
import type { WidgetBridge } from "@phylo-workbench/viewer-bridge";
import type { FsartWorkerRequest, FsartWorkerResponse } from "../workers/fsart.worker.js";
import type { RunProgress } from "./diffubar-client.js";

interface FastTreeScore extends SegmentLikelihood {
  readonly version: string;
}

function fastaSequences(text: string): string[] {
  const output: string[] = [];
  let sequence = "";
  let active = false;
  for (const raw of text.replaceAll("\r", "").split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith(">")) {
      if (active) output.push(sequence);
      active = true;
      sequence = "";
    } else sequence += line.toUpperCase();
  }
  if (active) output.push(sequence);
  return output;
}

function countVariableSites(sequences: readonly string[], start: number, end: number): number {
  let total = 0;
  for (let site = start - 1; site < end; site += 1) {
    let mask = 0;
    for (const sequence of sequences) {
      const value = sequence.charCodeAt(site);
      if (value === 65) mask |= 1;
      else if (value === 67) mask |= 2;
      else if (value === 71) mask |= 4;
      else if (value === 84 || value === 85) mask |= 8;
    }
    if ((mask & (mask - 1)) !== 0) total += 1;
  }
  return total;
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason ?? new DOMException("Analysis cancelled.", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

export class FsartClient {
  private workers: Worker[] = [];
  private abort: AbortController | undefined;
  private rejectActive: ((error: Error) => void) | undefined;

  constructor(
    private readonly getAlignmentBridge: () => WidgetBridge | undefined,
    private readonly getMaxCpus: () => number = () => Math.max(1, navigator.hardwareConcurrency || 1),
  ) {}

  private createWorker(): Worker {
    return new Worker(new URL("../workers/fsart.worker.ts", import.meta.url), { type: "module" });
  }

  async run(alignmentText: string, _tree: string, parameters: ParameterValues, onProgress: (progress: RunProgress) => void): Promise<FsartAnalysisResult> {
    this.cancel();
    const abort = new AbortController();
    this.abort = abort;
    const taxa = (alignmentText.match(/(?:^|\n)\s*>/g) ?? []).length;
    if (taxa < 3) throw new Error("FSART requires at least three FASTA sequences.");
    const sampling = planPairCoveredTriplets(taxa, Number(parameters.maximumTriplets ?? 250_000));
    const hardwareRequested = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 1, this.getMaxCpus()));
    // Every scan worker owns a site-major byte matrix. Keep the speedup for
    // normal alignments while avoiding an N-fold memory explosion for very
    // large uploads on static hosts that cannot enable SharedArrayBuffer.
    const deviceBudget = Math.max(256, Number((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 2) * 1024 * 0.25) * 1024 * 1024;
    const estimatedWorkerBytes = Math.max(1, alignmentText.length * 4 + 8 * 1024 * 1024);
    const requested = Math.max(1, Math.min(hardwareRequested, Math.floor(deviceBudget / estimatedWorkerBytes)));
    const workerCount = Math.max(1, Math.min(sampling.scannedTriplets, requested));
    const workers = Array.from({ length: workerCount }, () => this.createWorker());
    this.workers = workers;
    const runPromise = this.runWorkers(workers, alignmentText, parameters, sampling, onProgress, abort.signal)
      .then((result) => this.runPartition(result, alignmentText, parameters, onProgress, abort.signal));
    return new Promise((resolve, reject) => {
      this.rejectActive = reject;
      runPromise.then(
        (result) => { this.finish(); resolve(result); },
        (error: unknown) => { this.finish(); reject(error); },
      );
    });
  }

  private async runWorkers(
    workers: readonly Worker[],
    alignment: string,
    parameters: ParameterValues,
    sampling: TripletSamplingPlan,
    onProgress: (progress: RunProgress) => void,
    signal: AbortSignal,
  ): Promise<FsartAnalysisResult> {
    const started = performance.now();
    const fractions = new Float64Array(workers.length);
    const shardPromises = workers.map((worker, workerIndex) => {
      const start = Math.floor(sampling.scannedTriplets * workerIndex / workers.length);
      const end = Math.floor(sampling.scannedTriplets * (workerIndex + 1) / workers.length);
      const tripletRanks = sampling.ranks?.slice(start, end);
      const id = crypto.randomUUID();
      return raceAbort(new Promise<ScanShardResult>((resolve, reject) => {
        worker.onmessage = (event: MessageEvent<FsartWorkerResponse>) => {
          const message = event.data;
          if (message.id !== id) return;
          if (message.type === "progress") {
            fractions[workerIndex] = message.fraction;
            const aggregate = fractions.reduce((sum, value) => sum + value, 0) / workers.length;
            onProgress({ stage: "triplet-scan", fraction: aggregate, ...message.detail, message: `${workers.length} workers · ${message.detail.message}` });
          } else if (message.type === "shard") resolve(message.shard);
          else if (message.type === "error") reject(new Error(message.error));
        };
        worker.onerror = (event) => reject(new Error(event.message || "FSART triplet worker failed."));
        const request: FsartWorkerRequest = {
          type: "scan", id, alignment, parameters,
          rangeStart: tripletRanks === undefined ? start : 0,
          rangeEnd: tripletRanks === undefined ? end : tripletRanks.length,
          ...(tripletRanks === undefined ? {} : { tripletRanks }),
          pairCoverageGuaranteed: sampling.pairCoverageGuaranteed,
        };
        worker.postMessage(request, tripletRanks === undefined ? [] : [tripletRanks.buffer]);
      }), signal);
    });
    const shards = await Promise.all(shardPromises);
    for (let index = 1; index < workers.length; index += 1) workers[index]!.terminate();
    this.workers = [workers[0]!];
    const refineWorker = workers[0]!;
    const id = crypto.randomUUID();
    return raceAbort(new Promise<FsartAnalysisResult>((resolve, reject) => {
      refineWorker.onmessage = (event: MessageEvent<FsartWorkerResponse>) => {
        const message = event.data;
        if (message.id !== id) return;
        if (message.type === "progress") onProgress({ stage: message.stage, fraction: message.fraction, ...message.detail });
        else if (message.type === "result") resolve(message.result);
        else if (message.type === "error") reject(new Error(message.error));
      };
      refineWorker.onerror = (event) => reject(new Error(event.message || "FSART uncertainty worker failed."));
      const request: FsartWorkerRequest = { type: "refine", id, alignment, parameters, shards, scanMs: performance.now() - started };
      refineWorker.postMessage(request);
    }), signal);
  }

  private async runPartition(
    result: FsartAnalysisResult,
    alignment: string,
    parameters: ParameterValues,
    onProgress: (progress: RunProgress) => void,
    signal: AbortSignal,
  ): Promise<FsartAnalysisResult> {
    if (!Boolean(parameters.runFastTree ?? true)) return result;
    const bridge = this.getAlignmentBridge();
    if (bridge === undefined) return replacePartition(result, skippedPartition(parameters.criterion as InformationCriterion, "The local FastTree bridge was unavailable; consensus breakpoint scanning completed normally."));
    const started = performance.now();
    onProgress({ stage: "fasttree-runtime", fraction: 0, message: "Loading or compiling the shared FastTree 2.1.11 bioWASM runtime", indeterminate: true });
    await raceAbort(bridge.waitUntilReady(120_000), signal);
    let activeFastTreeStage = "tree-family";
    let activeFastTreeFraction = 0;
    const unsubscribe = bridge.onEvent((message) => {
      if (message.type !== "status") return;
      const payload = message.payload as { message?: string } | undefined;
      onProgress({ stage: activeFastTreeStage, fraction: activeFastTreeFraction, message: payload?.message ?? "FastTree fit active", indeterminate: true });
    });
    let familyCompleted: FsartAnalysisResult | undefined;
    try {
      let version: string | undefined;
      let sharedGtr: Pick<SegmentLikelihood, "gtrFrequencies" | "gtrRates"> | undefined;
      const segmentCache = new Map<string, Promise<FastTreeScore>>();
      const scoreSegment = (start: number, end: number): Promise<FastTreeScore> => {
        const key = `${start}:${end}`;
        const cached = segmentCache.get(key);
        if (cached !== undefined) return cached;
        const pending = raceAbort(bridge.request<FastTreeScore>("score-fasttree-segment", {
          alignment, start, end, fastest: Boolean(parameters.fastTreeFastest ?? true),
          ...(sharedGtr?.gtrFrequencies === undefined ? {} : { gtrFrequencies: sharedGtr.gtrFrequencies }),
          ...(sharedGtr?.gtrRates === undefined ? {} : { gtrRates: sharedGtr.gtrRates }),
        }, 15 * 60_000), signal).then((score) => {
          version = score.version;
          if (start === 1 && end === result.diagnostics.sites && score.gtrFrequencies !== undefined && score.gtrRates !== undefined) {
            sharedGtr = { gtrFrequencies: score.gtrFrequencies, gtrRates: score.gtrRates };
          }
          return score;
        });
        segmentCache.set(key, pending);
        return pending;
      };
      const criterion = parameters.criterion === "aic" || parameters.criterion === "bic" ? parameters.criterion : "aicc";
      const minimumSegmentLength = effectiveMinimumTreeSpan(
        result.diagnostics.taxa,
        result.diagnostics.sites,
        result.diagnostics.variableSites,
        Number(parameters.minimumSegmentLength ?? 150),
      );
      const windows = treeFamilyWindows(
        result.breakpoints.map((breakpoint) => breakpoint.breakpoint),
        result.diagnostics.sites,
        minimumSegmentLength,
      );
      const familyFits: SegmentLikelihood[] = [];
      for (let index = 0; index < windows.length; index += 1) {
        signal.throwIfAborted();
        const job = windows[index]!;
        activeFastTreeFraction = index / Math.max(1, windows.length);
        onProgress({
          stage: "tree-family",
          fraction: activeFastTreeFraction,
          message: `FastTree family ${index + 1}/${windows.length} · ${job.kind} ${job.start}–${job.end}`,
          current: index,
          total: windows.length,
        });
        familyFits.push(await scoreSegment(job.start, job.end));
      }
      activeFastTreeFraction = 1;
      onProgress({
        stage: "tree-family",
        fraction: 1,
        message: `${familyFits.length} segment / adjacent-pair / adjacent-triplet / global trees fitted`,
        current: familyFits.length,
        total: familyFits.length,
      });
      const globalFit = familyFits.find((candidate) => candidate.start === 1 && candidate.end === result.diagnostics.sites);
      const sequences = fastaSequences(alignment);
      const familyTrees: PartitionSegment[] = familyFits.map((score, index) => ({ ...score, id: windows[index]!.id }));
      const atomicSegments: PartitionSegment[] = windows
        .map((window, index) => ({ window, score: familyTrees[index]! }))
        .filter(({ window }) => window.kind === "segment")
        .map(({ window, score }, index) => ({ ...score, id: `S${index + 1}`, variableSites: countVariableSites(sequences, window.start, window.end) }));
      const familySegments: PartitionSegment[] = atomicSegments.length > 0
        ? atomicSegments
        : globalFit === undefined ? [] : [{ ...globalFit, id: "GLOBAL", variableSites: countVariableSites(sequences, 1, result.diagnostics.sites) }];
      const familyPartition: StepwisePartitionResult = {
        status: "complete",
        criterion,
        criterionValue: null,
        segments: familySegments,
        candidateTrees: familyTrees,
        steps: [],
        acceptedBreakpoints: [],
        rejectedBreakpoints: [],
        ...(version === undefined ? {} : { fastTreeVersion: version }),
        message: `${familyFits.length} tree hypotheses were generated; consensus cuts are proposals, not an accepted fixed partition.`,
      };
      let completed = replacePartition(result, familyPartition);
      const familyMs = performance.now() - started;
      completed = { ...completed, timings: { ...completed.timings, fastTreeMs: familyMs, totalMs: (completed.timings.totalMs ?? 0) + familyMs } };
      familyCompleted = completed;
      if (!Boolean(parameters.runTreeHmm ?? true)) return replaceTreeHmm(completed, skippedTreeHmm("Rapid topology-set HMM search was disabled.", criterion));

      const treeHmmStarted = performance.now();
      const maximumTrees = Math.max(2, Math.min(64, Math.round(Number(parameters.maximumTreeHypotheses ?? 48))));
      const unique = buildTopologyDictionary(familyFits, result.diagnostics.sites, maximumTrees);
      const hasGlobalNull = unique[0]?.segment.start === 1 && unique[0]?.segment.end === result.diagnostics.sites;
      if (unique.length < 2 || !hasGlobalNull) {
        const elapsed = performance.now() - treeHmmStarted;
        const timed = { ...completed, timings: { ...completed.timings, treeHmmMs: elapsed, totalMs: (completed.timings.totalMs ?? 0) + elapsed } };
        return replaceTreeHmm(timed, skippedTreeHmm(hasGlobalNull
          ? "The segment/pair/triplet tree family produced only one resolved topology; the global tree remains the appropriate model."
          : "The whole-alignment FastTree was unresolved, so fixed-topology HMM scoring was safely skipped.", criterion));
      }
      if (globalFit?.gtrFrequencies === undefined || globalFit.gtrRates === undefined) {
        const elapsed = performance.now() - treeHmmStarted;
        const timed = { ...completed, timings: { ...completed.timings, treeHmmMs: elapsed, totalMs: (completed.timings.totalMs ?? 0) + elapsed } };
        return replaceTreeHmm(timed, { ...skippedTreeHmm("FastTree did not expose the whole-alignment GTR estimates required for comparable fixed-topology emissions.", criterion), status: "failed" });
      }
      activeFastTreeStage = "tree-hmm-emissions";
      const profiles: TreeEmissionProfile[] = [];
      for (let index = 0; index < unique.length; index += 1) {
        signal.throwIfAborted();
        const candidate = unique[index]!;
        activeFastTreeFraction = index / unique.length;
        onProgress({
          stage: "tree-hmm-emissions",
          fraction: activeFastTreeFraction,
          message: `Fixed-topology likelihoods ${index + 1}/${unique.length} · ${candidate.occurrences} source fit${candidate.occurrences === 1 ? "" : "s"}`,
          current: index,
          total: unique.length,
        });
        try {
          const profile = await raceAbort(bridge.request<TreeEmissionProfile>("score-fasttree-topology", {
            alignment,
            id: `T${index + 1}`,
            sourceStart: candidate.segment.start,
            sourceEnd: candidate.segment.end,
            tree: candidate.segment.tree,
            topologySignature: candidate.signature,
            gtrFrequencies: globalFit.gtrFrequencies,
            gtrRates: globalFit.gtrRates,
            sourceWeight: Number(parameters.treeHmmSourceWeight ?? 4),
          }, 15 * 60_000), signal);
          profiles.push(profile);
        } catch (error) {
          if (index === 0 || signal.aborted) throw error;
          onProgress({
            stage: "tree-hmm-emissions",
            fraction: (index + 1) / unique.length,
            message: `Skipped one unusable exploratory topology; ${unique.length - index - 1} remain to score`,
          });
        }
      }
      activeFastTreeFraction = 1;
      completed = { ...completed, treeHmmProfiles: profiles };
      familyCompleted = completed;
      onProgress({ stage: "tree-hmm-emissions", fraction: 1, message: `${profiles.length} fixed topologies scored at every aligned site`, current: profiles.length, total: profiles.length });
      onProgress({ stage: "tree-hmm", fraction: 0, message: `Rapid joint search across ${profiles.length} precomputed topology likelihood profiles`, current: 0, total: profiles.length });
      const initialTreeHmm = await this.fitTreeHmmInWorker(
        profiles,
        result.diagnostics.taxa,
        criterion,
        Number(parameters.credibleMass ?? 0.95),
        Number(parameters.treeHmmRateSlices ?? 13),
        Number(parameters.maximumHmmStates ?? 8),
        Number(parameters.treeHmmBeamWidth ?? 4),
        minimumSegmentLength,
        onProgress,
        signal,
      );
      activeFastTreeStage = "tree-refinement";
      activeFastTreeFraction = 0;
      const refined = await this.refineTreeHmm(
        bridge,
        alignment,
        profiles,
        initialTreeHmm,
        {
          gtrFrequencies: globalFit.gtrFrequencies,
          gtrRates: globalFit.gtrRates,
        },
        {
          taxa: result.diagnostics.taxa,
          criterion,
          credibleMass: Number(parameters.credibleMass ?? 0.95),
          rateSlices: Number(parameters.treeHmmRateSlices ?? 13),
          maximumStates: Number(parameters.maximumHmmStates ?? 8),
          beamWidth: Number(parameters.treeHmmBeamWidth ?? 4),
          minimumRunLength: minimumSegmentLength,
          maximumIterations: Boolean(parameters.refineTreeHmm ?? true) ? Number(parameters.maximumRefinementIterations ?? 3) : 0,
          boundaryTolerance: Number(parameters.refinementBoundaryTolerance ?? 3),
          sourceWeight: Number(parameters.treeHmmSourceWeight ?? 4),
          fastest: Boolean(parameters.fastTreeFastest ?? true),
        },
        (progress) => {
          activeFastTreeStage = progress.stage;
          activeFastTreeFraction = progress.fraction;
          onProgress(progress);
        },
        signal,
      );
      const treeHmm: TreeHmmResult = { ...refined.result, refinement: refined.refinement };
      const profileById = new Map(refined.profiles.map((profile) => [profile.id, profile]));
      const finalSegments: PartitionSegment[] = (treeHmm.viterbi?.runs ?? []).map((run, index) => {
        const state = treeHmm.states[run.state]!;
        const profile = profileById.get(state.id)!;
        let logLikelihood = 0;
        for (let site = run.start - 1; site < run.end; site += 1) logLikelihood += Number(profile.siteLogLikelihoods[site]);
        return {
          id: `R${index + 1}`,
          start: run.start,
          end: run.end,
          tree: state.tree,
          logLikelihood,
          variableSites: countVariableSites(sequences, run.start, run.end),
          elapsedMs: 0,
        };
      });
      const acceptedBreakpoints = treeHmm.viterbi?.breakpoints ?? [];
      const finalPartition: StepwisePartitionResult = {
        ...familyPartition,
        criterionValue: treeHmm.criterionValue,
        segments: finalSegments.length > 0 ? finalSegments : familyPartition.segments,
        acceptedBreakpoints,
        rejectedBreakpoints: result.breakpoints.map((breakpoint) => breakpoint.breakpoint)
          .filter((breakpoint) => !acceptedBreakpoints.includes(breakpoint)),
        message: `${profiles.length} unique family topologies were scored at every site; the displayed runs are the minimum-length Viterbi reconstruction after rapid HMM subset search.`,
      };
      completed = replacePartition(completed, finalPartition, findDiscordantClades(finalPartition.segments));
      const treeHmmWallMs = performance.now() - treeHmmStarted;
      const withHmm = replaceTreeHmm(completed, treeHmm);
      return {
        ...withHmm,
        timings: {
          ...withHmm.timings,
          treeHmmMs: treeHmmWallMs,
          totalMs: (withHmm.timings.totalMs ?? 0) + treeHmmWallMs,
        },
      };
    } catch (error) {
      if (signal.aborted) throw error;
      if (familyCompleted !== undefined) {
        const criterion = parameters.criterion === "aic" || parameters.criterion === "bic" ? parameters.criterion : "aicc";
        return replaceTreeHmm(familyCompleted, {
          ...skippedTreeHmm(`Tree-HMM scoring failed without invalidating the consensus scan or fitted tree family: ${error instanceof Error ? error.message : String(error)}`, criterion),
          status: "failed",
        });
      }
      return replacePartition(result, {
        ...skippedPartition(parameters.criterion as InformationCriterion, `FastTree family generation failed without invalidating the consensus scan: ${error instanceof Error ? error.message : String(error)}`),
        status: "failed",
      });
    } finally {
      unsubscribe();
    }
  }

  private async refineTreeHmm(
    bridge: WidgetBridge,
    alignment: string,
    initialProfiles: readonly TreeEmissionProfile[],
    initialResult: TreeHmmResult,
    model: {
      readonly gtrFrequencies: NonNullable<SegmentLikelihood["gtrFrequencies"]>;
      readonly gtrRates: NonNullable<SegmentLikelihood["gtrRates"]>;
    },
    options: {
      readonly taxa: number;
      readonly criterion: InformationCriterion;
      readonly credibleMass: number;
      readonly rateSlices: number;
      readonly maximumStates: number;
      readonly beamWidth: number;
      readonly minimumRunLength: number;
      readonly maximumIterations: number;
      readonly boundaryTolerance: number;
      readonly sourceWeight: number;
      readonly fastest: boolean;
    },
    onProgress: (progress: RunProgress) => void,
    signal: AbortSignal,
  ): Promise<{ readonly result: TreeHmmResult; readonly profiles: readonly TreeEmissionProfile[]; readonly refinement: TreeHmmRefinementResult }> {
    const maximumIterations = Math.max(0, Math.min(8, Math.round(options.maximumIterations)));
    const history: TreeHmmRefinementIteration[] = [{
      iteration: 0,
      stateCount: initialResult.states.length,
      breakpoints: initialResult.viterbi?.breakpoints ?? [],
      maximumBoundaryShift: null,
      topologyChanged: false,
      criterionValue: initialResult.criterionValue,
      logLikelihood: initialResult.logLikelihood,
      fastTreeMs: 0,
      elapsedMs: 0,
    }];
    if (maximumIterations === 0 || initialResult.status !== "complete" || initialResult.states.length <= 1 || initialResult.viterbi === undefined) {
      return {
        result: initialResult,
        profiles: initialProfiles,
        refinement: {
          status: "skipped",
          converged: initialResult.states.length <= 1,
          maximumIterations,
          iterations: history,
          message: maximumIterations === 0
            ? "Viterbi/tree refinement was disabled."
            : initialResult.states.length <= 1 ? "The one-tree reconstruction requires no breakpoint refinement." : "No Viterbi reconstruction was available to refine.",
        },
      };
    }

    const globalProfile = initialProfiles[0]!;
    let currentProfiles = initialProfiles.slice();
    let currentResult = initialResult;
    let converged = false;
    let message = `Stopped after the configured ${maximumIterations} refinement iterations without requiring convergence.`;
    for (let iteration = 1; iteration <= maximumIterations; iteration += 1) {
      signal.throwIfAborted();
      const iterationStarted = performance.now();
      const previousBreakpoints = currentResult.viterbi?.breakpoints ?? [];
      const previousTopologies = currentResult.states.map((state) => state.topologySignature).sort();
      const rangesByTree = new Map<string, [number, number][]>();
      for (const run of currentResult.viterbi?.runs ?? []) {
        const ranges = rangesByTree.get(run.treeId);
        const range: [number, number] = [run.start, run.end];
        if (ranges === undefined) rangesByTree.set(run.treeId, [range]);
        else ranges.push(range);
      }
      const fitted: {
        readonly ranges: readonly (readonly [number, number])[];
        readonly assignedSites: number;
        readonly score: FastTreeScore;
        readonly signature: string;
      }[] = [];
      let fastTreeMs = 0;
      const activeStates = currentResult.states.filter((state) => {
        const ranges = rangesByTree.get(state.id) ?? [];
        return ranges.reduce((sum, range) => sum + range[1] - range[0] + 1, 0) >= options.minimumRunLength;
      });
      for (let stateIndex = 0; stateIndex < activeStates.length; stateIndex += 1) {
        signal.throwIfAborted();
        const state = activeStates[stateIndex]!;
        const ranges = rangesByTree.get(state.id)!;
        const assignedSites = ranges.reduce((sum, range) => sum + range[1] - range[0] + 1, 0);
        onProgress({
          stage: "tree-refinement",
          fraction: (iteration - 1 + 0.45 * stateIndex / Math.max(1, activeStates.length)) / maximumIterations,
          message: `Refinement ${iteration}/${maximumIterations} · refitting state ${stateIndex + 1}/${activeStates.length} on ${ranges.length} Viterbi run(s)`,
          current: stateIndex,
          total: activeStates.length,
          metricLabel: "assigned sites",
          metricValue: assignedSites,
        });
        try {
          const score = await raceAbort(bridge.request<FastTreeScore>("score-fasttree-ranges", {
            alignment,
            sourceRanges: ranges,
            fastest: options.fastest,
            gtrFrequencies: model.gtrFrequencies,
            gtrRates: model.gtrRates,
          }, 15 * 60_000), signal);
          fastTreeMs += score.elapsedMs;
          if (!isFullyResolvedTopology(score.tree)) continue;
          fitted.push({ ranges, assignedSites, score, signature: canonicalTopologySignature(score.tree) });
        } catch (error) {
          if (signal.aborted) throw error;
        }
      }
      const bestByTopology = new Map<string, typeof fitted[number]>();
      for (const candidate of fitted) {
        const current = bestByTopology.get(candidate.signature);
        if (current === undefined || candidate.assignedSites > current.assignedSites) bestByTopology.set(candidate.signature, candidate);
      }
      const candidates = Array.from(bestByTopology.values())
        .filter((candidate) => candidate.signature !== globalProfile.topologySignature)
        .sort((a, b) => b.assignedSites - a.assignedSites);
      const nextProfiles: TreeEmissionProfile[] = [globalProfile];
      for (let index = 0; index < candidates.length; index += 1) {
        signal.throwIfAborted();
        const candidate = candidates[index]!;
        onProgress({
          stage: "tree-refinement",
          fraction: (iteration - 1 + 0.45 + 0.35 * index / Math.max(1, candidates.length)) / maximumIterations,
          message: `Refinement ${iteration}/${maximumIterations} · rescoring topology ${index + 1}/${candidates.length} at every site`,
          current: index,
          total: candidates.length,
        });
        try {
          const profile = await raceAbort(bridge.request<TreeEmissionProfile>("score-fasttree-topology", {
            alignment,
            id: `R${iteration}T${index + 1}`,
            sourceStart: candidate.score.start,
            sourceEnd: candidate.score.end,
            sourceRanges: candidate.ranges,
            tree: candidate.score.tree,
            topologySignature: candidate.signature,
            gtrFrequencies: model.gtrFrequencies,
            gtrRates: model.gtrRates,
            sourceWeight: options.sourceWeight,
          }, 15 * 60_000), signal);
          fastTreeMs += profile.elapsedMs;
          nextProfiles.push(profile);
        } catch (error) {
          if (signal.aborted) throw error;
        }
      }
      onProgress({
        stage: "tree-refinement",
        fraction: (iteration - 1 + 0.82) / maximumIterations,
        message: `Refinement ${iteration}/${maximumIterations} · updating the HMM and Viterbi reconstruction`,
        current: iteration,
        total: maximumIterations,
      });
      const nextResult = await this.fitTreeHmmInWorker(
        nextProfiles,
        options.taxa,
        options.criterion,
        options.credibleMass,
        options.rateSlices,
        Math.min(options.maximumStates, nextProfiles.length),
        options.beamWidth,
        options.minimumRunLength,
        onProgress,
        signal,
        "tree-refinement-hmm",
      );
      const nextBreakpoints = nextResult.viterbi?.breakpoints ?? [];
      const maximumBoundaryShift = previousBreakpoints.length === nextBreakpoints.length
        ? previousBreakpoints.reduce((maximum, breakpoint, index) => Math.max(maximum, Math.abs(breakpoint - nextBreakpoints[index]!)), 0)
        : null;
      const nextTopologies = nextResult.states.map((state) => state.topologySignature).sort();
      const topologyChanged = previousTopologies.length !== nextTopologies.length
        || previousTopologies.some((value, index) => value !== nextTopologies[index]);
      history.push({
        iteration,
        stateCount: nextResult.states.length,
        breakpoints: nextBreakpoints,
        maximumBoundaryShift,
        topologyChanged,
        criterionValue: nextResult.criterionValue,
        logLikelihood: nextResult.logLikelihood,
        fastTreeMs,
        elapsedMs: performance.now() - iterationStarted,
      });
      currentProfiles = nextProfiles;
      currentResult = nextResult;
      if (!topologyChanged && maximumBoundaryShift !== null && maximumBoundaryShift <= Math.max(0, options.boundaryTolerance)) {
        converged = true;
        message = `Topology set and Viterbi boundaries stabilized after ${iteration} refinement iteration${iteration === 1 ? "" : "s"}.`;
        break;
      }
    }
    return {
      result: currentResult,
      profiles: currentProfiles,
      refinement: { status: "complete", converged, maximumIterations, iterations: history, message },
    };
  }

  private fitTreeHmmInWorker(
    profiles: readonly TreeEmissionProfile[],
    taxa: number,
    criterion: InformationCriterion,
    credibleMass: number,
    rateSlices: number,
    maximumStates: number,
    beamWidth: number,
    minimumRunLength: number,
    onProgress: (progress: RunProgress) => void,
    signal: AbortSignal,
    stage = "tree-hmm",
  ): Promise<TreeHmmResult> {
    const worker = this.workers[0] ?? this.createWorker();
    if (this.workers.length === 0) this.workers = [worker];
    const id = crypto.randomUUID();
    return raceAbort(new Promise<TreeHmmResult>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<FsartWorkerResponse>) => {
        const message = event.data;
        if (message.id !== id) return;
        if (message.type === "progress") onProgress({ stage: message.stage, fraction: message.fraction, ...message.detail });
        else if (message.type === "tree-hmm-result") resolve(message.result);
        else if (message.type === "error") reject(new Error(message.error));
      };
      worker.onerror = (event) => reject(new Error(event.message || "FSART topology-HMM worker failed."));
      const request: FsartWorkerRequest = {
        type: "tree-hmm",
        id,
        profiles,
        taxa,
        criterion,
        credibleMass,
        rateSlices,
        maximumStates,
        beamWidth,
        minimumRunLength,
        stage,
      };
      worker.postMessage(request);
    }), signal);
  }

  cancel(): void {
    if (this.abort === undefined && this.workers.length === 0) return;
    this.abort?.abort(new DOMException("Analysis cancelled.", "AbortError"));
    this.abort = undefined;
    for (const worker of this.workers) worker.terminate();
    this.workers = [];
    this.rejectActive?.(new DOMException("Analysis cancelled.", "AbortError"));
    this.rejectActive = undefined;
  }

  private finish(): void {
    for (const worker of this.workers) worker.terminate();
    this.workers = [];
    this.abort = undefined;
    this.rejectActive = undefined;
  }

  dispose(): void { this.cancel(); }
}

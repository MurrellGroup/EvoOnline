import {
  analyzeFame,
  analyzeFlavor,
  analyzeGlobalGamma,
  fameResultsToCsv,
  flavorResultsToCsv,
  globalGammaBranchesToCsv,
  globalGammaSitesToCsv,
} from "@phylo-workbench/model-bame";
import { analyzeBsrel, bsrelResultsToCsv } from "@phylo-workbench/model-bsrel";
import { analyzeCladeShift, cladeShiftBranchesToCsv, cladeShiftSitesToCsv } from "@phylo-workbench/model-cladeshift";
import { analyzeDifFUBAR, getGeneticCode, resultsToCsv, type RecombinationCodonTreeSet } from "@phylo-workbench/model-diffubar";
import {
  analyzeFsart,
  buildTopologyDictionary,
  canonicalTopologySignature,
  effectiveMinimumTreeSpan,
  findDiscordantClades,
  fitTreeHmm,
  isFullyResolvedTopology,
  replacePartition,
  replaceTreeHmm,
  skippedTreeHmm,
  treeFamilyWindows,
  type FsartAnalysisResult,
  type InformationCriterion,
  type PartitionSegment,
  type SegmentLikelihood,
  type StepwisePartitionResult,
  type TreeEmissionProfile,
  type TreeHmmRefinementIteration,
  type TreeHmmRefinementResult,
  type TreeHmmResult,
} from "@phylo-workbench/model-fsart";
import { analyzeFubar, fubarResultsToCsv } from "@phylo-workbench/model-fubar";
import { analyzeJemspr, type JemsprFixedGtrModel, type JemsprOptions } from "@phylo-workbench/model-jemspr";
import {
  mosaicSprEventsToCsv,
  mosaicSprTreeWindows,
  parseMosaicSprFasta,
  proposeMosaicSprBreakpoints,
  reconstructSprHistory,
  type MosaicSprAnalysisResult,
  type MosaicSprDraftTree,
} from "@phylo-workbench/model-mosaicspr";
import type { ParameterValues } from "@phylo-workbench/model-sdk";
import {
  createFastTreeEvaluator,
  fitFastTreeSegment,
  parseFastaText,
  scoreFastTreeTopology,
  segmentAlignment,
  variableSiteCount,
  type FastTreeRuntime,
} from "./fasttree.js";

export interface ProgressEvent {
  readonly stage: string;
  readonly fraction: number;
  readonly message?: string;
}

export type ProgressReporter = (event: ProgressEvent) => void;

const numberValue = (parameters: ParameterValues, key: string, fallback: number): number => {
  const value = Number(parameters[key] ?? fallback);
  return Number.isFinite(value) ? value : fallback;
};

const progress = (reporter: ProgressReporter, stage: string, fraction: number, detail?: { readonly message?: string }): void => {
  reporter({ stage, fraction: Math.max(0, Math.min(1, fraction)), ...(detail?.message === undefined ? {} : { message: detail.message }) });
};

/** Node binaries use the same f64 WASM kernel but avoid browser/WebGPU and worker-only runtimes. */
const cliBackend = "wasm" as const;

export async function runSelectionMethod(
  modelId: string,
  alignment: string,
  tree: string,
  parameters: ParameterValues,
  reporter: ProgressReporter,
  recombinationTrees?: RecombinationCodonTreeSet,
): Promise<unknown> {
  const geneticCode = getGeneticCode(String(parameters.geneticCode ?? 1)).id;
  if (modelId === "diffubar") {
    const threshold = numberValue(parameters, "posteriorThreshold", 0.95);
    const result = await analyzeDifFUBAR(alignment, tree, {
      geneticCode,
      backend: cliBackend,
      foregroundGrid: numberValue(parameters, "foregroundGrid", 6),
      backgroundGrid: numberValue(parameters, "backgroundGrid", 4),
      iterations: numberValue(parameters, "iterations", 2500),
      burnin: numberValue(parameters, "burnin", 500),
      posteriorThreshold: threshold,
      seed: numberValue(parameters, "seed", 1234),
      fitMode: parameters.fitMode === "reference-compatible" ? "reference-compatible" : "empirical-fast",
      samplerMode: parameters.samplerMode === "reference" || parameters.samplerMode === "collapsed" ? parameters.samplerMode : "fast-exact",
      collectPosteriorMarginals: true,
      onStage: (stage, fraction, detail) => progress(reporter, stage, fraction, detail),
    });
    return { ...result, tree, csv: resultsToCsv(result) };
  }
  if (modelId === "fubar") {
    const threshold = numberValue(parameters, "posteriorThreshold", 0.95);
    const result = await analyzeFubar(alignment, tree, {
      geneticCode,
      backend: cliBackend,
      gridPoints: numberValue(parameters, "gridPoints", 20),
      inferenceMethod: parameters.inferenceMethod === "gibbs" ? "gibbs" : "dirichlet-em",
      iterations: numberValue(parameters, "iterations", 2500),
      burnin: numberValue(parameters, "burnin", 500),
      concentration: numberValue(parameters, "concentration", 0.5),
      seed: numberValue(parameters, "seed", 1234),
      posteriorThreshold: threshold,
      fitMode: parameters.fitMode === "reference-compatible" ? "reference-compatible" : "empirical-fast",
      approximateFel: parameters.approximateFel === true || parameters.approximateFel === "true",
      ...(recombinationTrees === undefined ? {} : { recombinationTrees }),
      onStage: (stage, fraction, detail) => progress(reporter, stage, fraction, detail),
    });
    return { ...result, tree, csv: fubarResultsToCsv(result, threshold) };
  }
  if (modelId === "bsrel") {
    const result = await analyzeBsrel(alignment, tree, {
      geneticCode,
      backend: cliBackend,
      branchScope: parameters.branchScope === "internal" || parameters.branchScope === "terminal" ? parameters.branchScope : "all",
      significanceThreshold: numberValue(parameters, "significanceThreshold", 0.05),
      alternativeIterations: numberValue(parameters, "alternativeIterations", 45),
      nullIterations: numberValue(parameters, "nullIterations", 10),
      maximumOmega: numberValue(parameters, "maximumOmega", 1000),
      fitMode: parameters.fitMode === "reference-compatible" ? "reference-compatible" : "empirical-fast",
      onStage: (stage, fraction, detail) => progress(reporter, stage, fraction, detail),
    });
    return { ...result, tree, csv: bsrelResultsToCsv(result) };
  }
  if (modelId === "fame" || modelId === "flavor") {
    const threshold = numberValue(parameters, "posteriorThreshold", 0.9);
    const common = {
      geneticCode,
      backend: cliBackend,
      inferenceMethod: parameters.inferenceMethod === "gibbs" ? "gibbs" as const : "dirichlet-em" as const,
      iterations: numberValue(parameters, "iterations", 2500),
      burnin: numberValue(parameters, "burnin", 500),
      concentration: numberValue(parameters, "concentration", 0.1),
      seed: numberValue(parameters, "seed", 1234),
      posteriorThreshold: threshold,
      gridPreset: parameters.gridPreset === "julia-draft" ? "julia-draft" as const : "fast" as const,
      fitMode: parameters.fitMode === "reference-compatible" ? "reference-compatible" as const : "empirical-fast" as const,
      ...(recombinationTrees === undefined ? {} : { recombinationTrees }),
      onStage: (stage: string, fraction: number, detail?: { readonly message?: string }) => progress(reporter, stage, fraction, detail),
    };
    if (modelId === "fame") {
      const result = await analyzeFame(alignment, tree, { ...common, weightIntegration: parameters.weightIntegration === "julia-draft-log-average" ? "julia-draft-log-average" : "likelihood-quadrature", quadraturePoints: numberValue(parameters, "quadraturePoints", 4), draftWeightPoints: numberValue(parameters, "draftWeightPoints", 20) });
      return { ...result, method: "fame", tree, csv: fameResultsToCsv(result, threshold) };
    }
    const result = await analyzeFlavor(alignment, tree, { ...common, gammaSlices: numberValue(parameters, "gammaSlices", 12), transitionEngine: parameters.transitionEngine === "direct-uniformization" ? "direct-uniformization" : "julia-interpolated" });
    return { ...result, method: "flavor", tree, csv: flavorResultsToCsv(result, threshold) };
  }
  if (modelId === "glamma") {
    const result = await analyzeGlobalGamma(alignment, tree, {
      geneticCode,
      backend: cliBackend,
      omegaSlices: numberValue(parameters, "omegaSlices", 8),
      alphaSlices: numberValue(parameters, "alphaSlices", 4),
      fitPreset: parameters.fitPreset === "thorough" ? "thorough" : "fast",
      activationPriorAlpha: numberValue(parameters, "activationPriorAlpha", 1),
      activationPriorBeta: numberValue(parameters, "activationPriorBeta", 9),
      fitMode: parameters.fitMode === "reference-compatible" ? "reference-compatible" : "empirical-fast",
      onStage: (stage, fraction, detail) => progress(reporter, stage, fraction, detail),
    });
    return { ...result, method: "glamma", tree, siteCsv: globalGammaSitesToCsv(result), branchCsv: globalGammaBranchesToCsv(result) };
  }
  if (modelId === "clade-shift") {
    const threshold = numberValue(parameters, "posteriorThreshold", 0.9);
    const result = await analyzeCladeShift(alignment, tree, {
      geneticCode,
      backend: cliBackend,
      gridPoints: numberValue(parameters, "gridPoints", 16),
      posteriorComponents: numberValue(parameters, "posteriorComponents", 96),
      posteriorMassTarget: numberValue(parameters, "posteriorMassTarget", 0.9),
      intensityPreset: parameters.intensityPreset === "thorough" ? "thorough" : "fast",
      shiftPrior: numberValue(parameters, "shiftPrior", 0.2),
      posteriorThreshold: threshold,
      minimumDescendantTips: numberValue(parameters, "minimumDescendantTips", 1),
      inferenceIterations: numberValue(parameters, "inferenceIterations", 1000),
      concentration: numberValue(parameters, "concentration", 0.5),
      fitMode: parameters.fitMode === "reference-compatible" ? "reference-compatible" : "empirical-fast",
      onStage: (stage, fraction, detail) => progress(reporter, stage, fraction, detail),
    });
    return { ...result, method: "clade-shift", tree, siteCsv: cladeShiftSitesToCsv(result.sites), branchCsv: cladeShiftBranchesToCsv(result.branches) };
  }
  throw new Error(`Selection method '${modelId}' is not supported by evo-cli.`);
}

function fsartOptions(parameters: ParameterValues, reporter: ProgressReporter) {
  return {
    window: numberValue(parameters, "window", 24),
    mergeDistance: numberValue(parameters, "mergeDistance", 12),
    maximumSignals: numberValue(parameters, "maximumSignals", 1024),
    maximumReportedSignals: numberValue(parameters, "maximumReportedSignals", 256),
    rateSlices: numberValue(parameters, "rateSlices", 9),
    credibleMass: numberValue(parameters, "credibleMass", 0.95),
    runFastTree: Boolean(parameters.runFastTree ?? true),
    criterion: parameters.criterion === "aic" || parameters.criterion === "bic" ? parameters.criterion : "aicc" as InformationCriterion,
    minimumSegmentLength: numberValue(parameters, "minimumSegmentLength", 150),
    maximumTriplets: numberValue(parameters, "maximumTriplets", 250_000),
    maximumConsensusBreakpoints: numberValue(parameters, "maximumConsensusBreakpoints", 14),
    maximumBreakpoints: numberValue(parameters, "maximumBreakpoints", 8),
    maximumPartitionCandidates: numberValue(parameters, "maximumPartitionCandidates", 24),
    fastTreeFastest: Boolean(parameters.fastTreeFastest ?? true),
    runTreeHmm: Boolean(parameters.runTreeHmm ?? true),
    maximumTreeHypotheses: numberValue(parameters, "maximumTreeHypotheses", 8),
    maximumTreeBankCandidates: numberValue(parameters, "maximumTreeBankCandidates", 12),
    treeHmmSourceWeight: numberValue(parameters, "treeHmmSourceWeight", 4),
    onStage: (stage: string, fraction: number, detail?: { readonly message?: string }) => progress(reporter, stage, fraction, detail),
  };
}

async function refineFsartProfiles(
  runtime: FastTreeRuntime,
  alignment: string,
  initialProfiles: readonly TreeEmissionProfile[],
  initialResult: TreeHmmResult,
  model: { readonly gtrFrequencies: readonly number[]; readonly gtrRates: readonly number[] },
  parameters: ParameterValues,
  minimumRunLength: number,
  taxa: number,
  reporter: ProgressReporter,
): Promise<{ readonly profiles: readonly TreeEmissionProfile[]; readonly result: TreeHmmResult; readonly refinement: TreeHmmRefinementResult }> {
  const maximumIterations = Boolean(parameters.refineTreeHmm ?? true) ? Math.max(0, Math.min(8, Math.round(numberValue(parameters, "maximumRefinementIterations", 3)))) : 0;
  const boundaryTolerance = Math.max(0, numberValue(parameters, "refinementBoundaryTolerance", 3));
  const criterion = parameters.criterion === "aic" || parameters.criterion === "bic" ? parameters.criterion : "aicc";
  const history: TreeHmmRefinementIteration[] = [{ iteration: 0, stateCount: initialResult.states.length, breakpoints: initialResult.viterbi?.breakpoints ?? [], maximumBoundaryShift: null, topologyChanged: false, criterionValue: initialResult.criterionValue, logLikelihood: initialResult.logLikelihood, fastTreeMs: 0, elapsedMs: 0 }];
  if (maximumIterations === 0 || initialResult.status !== "complete" || initialResult.viterbi === undefined || initialResult.states.length <= 1) return { profiles: initialProfiles, result: initialResult, refinement: { status: "skipped", converged: initialResult.states.length <= 1, maximumIterations, iterations: history, message: maximumIterations === 0 ? "Viterbi/tree refinement was disabled." : "No multi-tree Viterbi reconstruction was available to refine." } };
  const evaluator = createFastTreeEvaluator(runtime, alignment, Boolean(parameters.fastTreeFastest ?? true));
  const global = initialProfiles[0]!;
  let currentProfiles = [...initialProfiles];
  let currentResult = initialResult;
  let converged = false;
  for (let iteration = 1; iteration <= maximumIterations; iteration += 1) {
    const started = performance.now();
    const previousBreakpoints = currentResult.viterbi?.breakpoints ?? [];
    const previousTopologies = currentResult.states.map((state) => state.topologySignature).sort();
    const rangesByTree = new Map<string, [number, number][]>();
    for (const run of currentResult.viterbi?.runs ?? []) rangesByTree.set(run.treeId, [...(rangesByTree.get(run.treeId) ?? []), [run.start, run.end]]);
    const fitted: Array<{ readonly ranges: readonly (readonly [number, number])[]; readonly assignedSites: number; readonly score: SegmentLikelihood; readonly signature: string }> = [];
    const states = currentResult.states.filter((state) => (rangesByTree.get(state.id) ?? []).reduce((sum, range) => sum + range[1] - range[0] + 1, 0) >= minimumRunLength);
    for (let index = 0; index < states.length; index += 1) {
      const state = states[index]!;
      const ranges = rangesByTree.get(state.id)!;
      progress(reporter, "tree-refinement", (iteration - 1 + 0.4 * index / Math.max(1, states.length)) / maximumIterations, { message: `Refitting state ${index + 1}/${states.length}` });
      const score = await evaluator.evaluateRanges(ranges);
      if (isFullyResolvedTopology(score.tree)) fitted.push({ ranges, assignedSites: ranges.reduce((sum, range) => sum + range[1] - range[0] + 1, 0), score, signature: canonicalTopologySignature(score.tree) });
    }
    const unique = [...new Map(fitted.sort((a, b) => b.assignedSites - a.assignedSites).map((candidate) => [candidate.signature, candidate])).values()].filter((candidate) => candidate.signature !== global.topologySignature);
    const nextProfiles: TreeEmissionProfile[] = [global];
    for (let index = 0; index < unique.length; index += 1) {
      const candidate = unique[index]!;
      nextProfiles.push(await scoreFastTreeTopology(runtime, alignment, parseFastaText(alignment).names, parseFastaText(alignment).sequences[0]!.length, { id: `R${iteration}T${index + 1}`, tree: candidate.score.tree, sourceStart: candidate.score.start, sourceEnd: candidate.score.end, sourceRanges: candidate.ranges, topologySignature: candidate.signature }, model, numberValue(parameters, "treeHmmSourceWeight", 4)));
    }
    const nextResult = fitTreeHmm(nextProfiles, { taxa, criterion, credibleMass: numberValue(parameters, "credibleMass", 0.95), maximumRateSlices: numberValue(parameters, "treeHmmRateSlices", 13), maximumStates: numberValue(parameters, "maximumHmmStates", 8), beamWidth: numberValue(parameters, "treeHmmBeamWidth", 4), minimumRunLength, searchMode: "rapid", onProgress: (fraction, detail) => progress(reporter, "tree-refinement-hmm", fraction, detail) });
    const nextBreakpoints = nextResult.viterbi?.breakpoints ?? [];
    const maximumBoundaryShift = previousBreakpoints.length === nextBreakpoints.length ? previousBreakpoints.reduce((maximum, breakpoint, index) => Math.max(maximum, Math.abs(breakpoint - nextBreakpoints[index]!)), 0) : null;
    const nextTopologies = nextResult.states.map((state) => state.topologySignature).sort();
    const topologyChanged = previousTopologies.length !== nextTopologies.length || previousTopologies.some((value, index) => value !== nextTopologies[index]);
    history.push({ iteration, stateCount: nextResult.states.length, breakpoints: nextBreakpoints, maximumBoundaryShift, topologyChanged, criterionValue: nextResult.criterionValue, logLikelihood: nextResult.logLikelihood, fastTreeMs: evaluator.diagnostics().fastTreeMs, elapsedMs: performance.now() - started });
    currentProfiles = nextProfiles;
    currentResult = nextResult;
    if (!topologyChanged && maximumBoundaryShift !== null && maximumBoundaryShift <= boundaryTolerance) { converged = true; break; }
  }
  return { profiles: currentProfiles, result: currentResult, refinement: { status: "complete", converged, maximumIterations, iterations: history, message: converged ? "Topology set and Viterbi boundaries stabilized." : `Stopped after ${maximumIterations} configured refinement iterations.` } };
}

export async function runFsart(alignment: string, parameters: ParameterValues, runtime: FastTreeRuntime | undefined, reporter: ProgressReporter): Promise<FsartAnalysisResult> {
  const options = fsartOptions(parameters, reporter);
  let result = analyzeFsart(alignment, options);
  if (!options.runFastTree) return result;
  if (runtime === undefined) throw new Error("FSART tree reconstruction requires FastTree. Pass --fasttree or set EVO_FASTTREE.");
  const parsed = parseFastaText(alignment);
  const minimum = effectiveMinimumTreeSpan(result.diagnostics.taxa, result.diagnostics.sites, result.diagnostics.variableSites, options.minimumSegmentLength);
  const windows = treeFamilyWindows(result.breakpoints.map((breakpoint) => breakpoint.breakpoint), result.diagnostics.sites, minimum);
  const evaluator = createFastTreeEvaluator(runtime, alignment, options.fastTreeFastest);
  const familyFits: SegmentLikelihood[] = [];
  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index]!;
    progress(reporter, "tree-family", index / windows.length, { message: `FastTree family ${index + 1}/${windows.length}` });
    familyFits.push(await evaluator.evaluate(window.start, window.end));
  }
  const globalFit = familyFits.find((fit) => fit.start === 1 && fit.end === result.diagnostics.sites);
  const familyTrees: PartitionSegment[] = familyFits.map((fit, index) => ({ ...fit, id: windows[index]!.id }));
  const atomic = windows.map((window, index) => ({ window, fit: familyTrees[index]! })).filter(({ window }) => window.kind === "segment").map(({ window, fit }, index) => ({ ...fit, id: `S${index + 1}`, variableSites: variableSiteCount(parsed.sequences, window.start, window.end) }));
  const segments = atomic.length > 0 ? atomic : globalFit === undefined ? [] : [{ ...globalFit, id: "GLOBAL", variableSites: result.diagnostics.variableSites }];
  const criterion = options.criterion;
  const partition: StepwisePartitionResult = { status: "complete", criterion, criterionValue: null, segments, candidateTrees: familyTrees, steps: [], acceptedBreakpoints: [], rejectedBreakpoints: [], fastTreeVersion: runtime.label, message: `${familyFits.length} bounded FastTree family hypotheses were generated.` };
  result = replacePartition(result, partition);
  if (!options.runTreeHmm) return replaceTreeHmm(result, skippedTreeHmm("Rapid topology-set HMM search was disabled.", criterion));
  const dictionary = buildTopologyDictionary(familyFits, result.diagnostics.sites, options.maximumTreeHypotheses);
  if (dictionary.length < 2 || globalFit?.gtrFrequencies === undefined || globalFit.gtrRates === undefined) return replaceTreeHmm(result, skippedTreeHmm(dictionary.length < 2 ? "The tree family produced one resolved topology." : "FastTree did not expose a complete shared GTR model.", criterion));
  const profiles: TreeEmissionProfile[] = [];
  for (let index = 0; index < dictionary.length; index += 1) {
    const candidate = dictionary[index]!;
    progress(reporter, "tree-hmm-emissions", index / dictionary.length, { message: `Fixed topology ${index + 1}/${dictionary.length}` });
    profiles.push(await scoreFastTreeTopology(runtime, alignment, parsed.names, result.diagnostics.sites, { id: `T${index + 1}`, sourceStart: candidate.segment.start, sourceEnd: candidate.segment.end, tree: candidate.segment.tree, topologySignature: candidate.signature }, { gtrFrequencies: globalFit.gtrFrequencies, gtrRates: globalFit.gtrRates }, options.treeHmmSourceWeight));
  }
  const initial = fitTreeHmm(profiles, { taxa: result.diagnostics.taxa, criterion, credibleMass: options.credibleMass, maximumRateSlices: numberValue(parameters, "treeHmmRateSlices", 13), maximumStates: numberValue(parameters, "maximumHmmStates", 8), beamWidth: numberValue(parameters, "treeHmmBeamWidth", 4), minimumRunLength: minimum, searchMode: "rapid", onProgress: (fraction, detail) => progress(reporter, "tree-hmm", fraction, detail) });
  const refined = await refineFsartProfiles(runtime, alignment, profiles, initial, { gtrFrequencies: globalFit.gtrFrequencies, gtrRates: globalFit.gtrRates }, parameters, minimum, result.diagnostics.taxa, reporter);
  const treeHmm = { ...refined.result, refinement: refined.refinement };
  const byId = new Map(refined.profiles.map((profile) => [profile.id, profile]));
  const finalSegments: PartitionSegment[] = (treeHmm.viterbi?.runs ?? []).map((run, index) => {
    const state = treeHmm.states[run.state]!;
    const profile = byId.get(state.id)!;
    let logLikelihood = 0;
    for (let site = run.start - 1; site < run.end; site += 1) logLikelihood += Number(profile.siteLogLikelihoods[site]);
    return { id: `R${index + 1}`, start: run.start, end: run.end, tree: state.tree, logLikelihood, variableSites: variableSiteCount(parsed.sequences, run.start, run.end), elapsedMs: 0 };
  });
  const acceptedBreakpoints = treeHmm.viterbi?.breakpoints ?? [];
  const finalPartition: StepwisePartitionResult = { ...partition, criterionValue: treeHmm.criterionValue, segments: finalSegments.length > 0 ? finalSegments : partition.segments, acceptedBreakpoints, rejectedBreakpoints: result.breakpoints.map((breakpoint) => breakpoint.breakpoint).filter((breakpoint) => !acceptedBreakpoints.includes(breakpoint)), message: `${profiles.length} unique topologies were scored at every site and decoded by the topology HMM.` };
  return replaceTreeHmm(replacePartition({ ...result, treeHmmProfiles: refined.profiles }, finalPartition, findDiscordantClades(finalPartition.segments)), treeHmm);
}

function optionalPenalty(parameters: ParameterValues, key: string): number | undefined {
  const value = numberValue(parameters, key, 0);
  return value > 0 ? value : undefined;
}

export async function runMosaicSpr(alignmentText: string, parameters: ParameterValues, runtime: FastTreeRuntime | undefined, reporter: ProgressReporter): Promise<MosaicSprAnalysisResult> {
  if (runtime === undefined) throw new Error("MosaicSPR requires FastTree. Pass --fasttree or set EVO_FASTTREE.");
  const started = performance.now();
  const alignment = parseMosaicSprFasta(alignmentText);
  const proposalStarted = performance.now();
  const proposal = proposeMosaicSprBreakpoints(alignment, { enabled: Boolean(parameters.useBreakpointProposals ?? true), window: numberValue(parameters, "window", 24), maximumTriplets: numberValue(parameters, "maximumTriplets", 250_000), maximumSignals: numberValue(parameters, "maximumSignals", 1024), maximumReportedSignals: numberValue(parameters, "maximumReportedSignals", 256), maximumBreakpoints: numberValue(parameters, "maximumConsensusBreakpoints", 14), minimumSegmentLength: numberValue(parameters, "minimumSegmentLength", 150), onProgress: (fraction, detail) => progress(reporter, "mosaicspr-proposals", fraction, detail) });
  const proposalMs = performance.now() - proposalStarted;
  const windows = mosaicSprTreeWindows(proposal.proposals, alignment.sites, proposal.diagnostics.minimumTreeSpan, true);
  const evaluator = createFastTreeEvaluator(runtime, alignmentText, Boolean(parameters.fastTreeFastest ?? true));
  const draftTrees: MosaicSprDraftTree[] = [];
  const fitStarted = performance.now();
  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index]!;
    progress(reporter, "mosaicspr-tree-family", index / windows.length, { message: `FastTree seed ${index + 1}/${windows.length}` });
    const score = await evaluator.evaluate(window.start, window.end);
    if (!isFullyResolvedTopology(score.tree)) continue;
    draftTrees.push({ id: window.id, kind: window.kind, start: window.start, end: window.end, tree: score.tree, logLikelihood: score.logLikelihood, elapsedMs: score.elapsedMs, topologySignature: canonicalTopologySignature(score.tree) });
  }
  if (draftTrees.length === 0) throw new Error("FastTree produced no resolved topology for MosaicSPR.");
  const fastTreeMs = performance.now() - fitStarted;
  const searchStarted = performance.now();
  const breakpointPenalty = optionalPenalty(parameters, "sprBreakpointPenalty");
  const sprPenalty = optionalPenalty(parameters, "sprMovePenalty");
  const masterPenalty = optionalPenalty(parameters, "sprMasterPenalty");
  const reconstruction = reconstructSprHistory(alignment, draftTrees.map((draft) => draft.tree), { minimumRunLength: proposal.diagnostics.minimumTreeSpan, maximumStates: numberValue(parameters, "maximumSprStates", 48), maximumIterations: numberValue(parameters, "maximumSprIterations", 12), beamWidth: numberValue(parameters, "sprBeamWidth", 4), parsimonyScreenLimit: numberValue(parameters, "sprParsimonyScreenLimit", 96), maximumStarts: numberValue(parameters, "maximumSprStarts", 3), patience: numberValue(parameters, "sprSearchPatience", 5), ...(breakpointPenalty === undefined ? {} : { breakpointPenalty }), ...(sprPenalty === undefined ? {} : { sprPenalty }), ...(masterPenalty === undefined ? {} : { masterPenalty }), onProgress: (fraction, detail) => progress(reporter, "mosaicspr-search", fraction, detail) });
  const base = { method: "mosaic-spr" as const, taxa: alignment.taxa, sites: alignment.sites, variableSites: alignment.variableSites.length, proposals: proposal.proposals, proposalDiagnostics: proposal.diagnostics, draftTrees, reconstruction, fastTreeVersion: runtime.label, timings: { proposalMs, fastTreeMs, searchMs: performance.now() - searchStarted, totalMs: performance.now() - started } };
  return { ...base, eventCsv: mosaicSprEventsToCsv(base) };
}

export async function runJemspr(alignment: string, parameters: ParameterValues, runtime: FastTreeRuntime | undefined, reporter: ProgressReporter): Promise<Awaited<ReturnType<typeof analyzeJemspr>>> {
  let gtrModel: JemsprFixedGtrModel | undefined;
  if (Boolean(parameters.linkedLikelihood ?? true)) {
    if (runtime === undefined) throw new Error("JEMSPR linked likelihood requires FastTree for its fixed GTR matrix. Pass --fasttree or disable linkedLikelihood.");
    const parsed = parseFastaText(alignment);
    const score = await fitFastTreeSegment(runtime, segmentAlignment(parsed, 1, parsed.sequences[0]!.length), parsed.names, 1, parsed.sequences[0]!.length, true);
    if (score.gtrFrequencies === undefined || score.gtrRates === undefined) throw new Error("FastTree did not report the fixed GTR matrix required by JEMSPR.");
    gtrModel = { frequencies: score.gtrFrequencies, exchangeabilities: score.gtrRates, source: "FastTree-2.1.11-global-fit", version: runtime.label };
  }
  const p = parameters;
  const options: JemsprOptions = {
    scoreMethod: p.scoreMethod === "sankoff" ? "sankoff" : "fitch",
    transitionCost: numberValue(p, "transitionCost", 0.5), transversionCost: numberValue(p, "transversionCost", 1), minimumWindow: numberValue(p, "minimumWindow", 120), maximumDyadicTrees: numberValue(p, "maximumDyadicTrees", 16), rootPlacements: numberValue(p, "rootPlacements", 3), maximumGraphStates: numberValue(p, "maximumGraphStates", 36), maximumGraphIterations: numberValue(p, "maximumGraphIterations", 10), neighbourScreen: numberValue(p, "neighbourScreen", 72), frontierStates: numberValue(p, "frontierStates", 4), nearImprovers: numberValue(p, "nearImprovers", 2), pathBreakpointPenalty: numberValue(p, "pathBreakpointPenalty", 4), pathEndpointPenalty: numberValue(p, "pathEndpointPenalty", 1), pathSpanPenalty: numberValue(p, "pathSpanPenalty", 0.002), maximumReticulations: numberValue(p, "maximumReticulations", 5), overlapCap: numberValue(p, "overlapCap", 3), networkBeamWidth: numberValue(p, "networkBeamWidth", 8), eventPoolSize: numberValue(p, "eventPoolSize", 20), eventOpenPenalty: numberValue(p, "eventOpenPenalty", 2), eventClosePenalty: numberValue(p, "eventClosePenalty", 0), networkBreakpointPenalty: numberValue(p, "networkBreakpointPenalty", 2), eventSpanPenalty: numberValue(p, "eventSpanPenalty", 0.002), reticulationPenalty: numberValue(p, "reticulationPenalty", 2), boundaryConvention: p.boundaryConvention === "closed" || p.boundaryConvention === "penalized-open" ? p.boundaryConvention : "open", boundaryCensorPenalty: numberValue(p, "boundaryCensorPenalty", 2), uncertaintyTolerance: numberValue(p, "uncertaintyTolerance", 2), linkedLikelihood: Boolean(p.linkedLikelihood ?? true), likelihoodRefinement: Boolean(p.likelihoodRefinement ?? true), likelihoodIterations: numberValue(p, "likelihoodIterations", 28), likelihoodRefitIterations: numberValue(p, "likelihoodRefitIterations", 14), likelihoodRateCategories: numberValue(p, "likelihoodRateCategories", 4), likelihoodGammaShape: numberValue(p, "likelihoodGammaShape", 0.5), fitLikelihoodGammaShape: Boolean(p.fitLikelihoodGammaShape ?? true), ...(gtrModel === undefined ? {} : { gtrModel }), onProgress: (stage, fraction, detail) => progress(reporter, stage, fraction, detail),
  };
  return analyzeJemspr(alignment, options);
}

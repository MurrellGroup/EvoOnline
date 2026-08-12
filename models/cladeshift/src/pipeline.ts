import {
  DifFUBARError,
  ParallelWasmBackend,
  WasmBackend,
  buildModelBank,
  encodeCodonTips,
  getGeneticCode,
  parseFasta,
  parseNewick,
  type FittedModel,
  type ProgressDetail,
} from "@phylo-workbench/model-diffubar";
import { analyzeFubar } from "@phylo-workbench/model-fubar";
import { createCladeShiftModelGrid, intensityValues } from "./model/intensity.js";
import { compressNullPosterior, summarizeCladeShift } from "./posterior.js";
import { cloneSingleClassTree, compileCladeShiftTree } from "./tree.js";
import type {
  CladeShiftAnalysisOptions,
  CladeShiftAnalysisResult,
  CladeShiftBranchResult,
  CladeShiftInput,
  CladeShiftSiteResult,
  CladeShiftTreeInput,
} from "./types.js";

type Backend = WasmBackend | ParallelWasmBackend;

function stage(options: CladeShiftAnalysisOptions, name: string, fraction: number, detail?: ProgressDetail): void {
  options.onStage?.(name, Math.max(0, Math.min(1, fraction)), detail);
}

function chooseBackend(kind: CladeShiftAnalysisOptions["backend"]): Backend {
  return kind === "wasm" ? new WasmBackend() : new ParallelWasmBackend(undefined, 0);
}

function quote(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function csvNumber(value: number): number | string {
  return Number.isFinite(value) ? value : value > 0 ? "Infinity" : "-Infinity";
}

export function cladeShiftSitesToCsv(sites: readonly CladeShiftSiteResult[]): string {
  const header = [
    "Codon site", "P(any persistent clade shift)", "P(relaxation)", "P(intensification)",
    "Shift log BF", "Relaxation log BF", "Intensification log BF", "Detected", "Direction",
    "MAP initiating branch", "MAP branch number", "MAP branch posterior", "MAP K", "Mean K given shift",
    "Captured null posterior mass", "Baseline mean alpha", "Baseline mean beta",
  ];
  const rows = sites.map((site) => [
    site.site, site.pShift, site.pRelaxation, site.pIntensification,
    csvNumber(site.logBayesFactor), csvNumber(site.relaxationLogBayesFactor), csvNumber(site.intensificationLogBayesFactor),
    site.detected, site.direction, quote(site.mapBranchName), site.mapBranch, site.mapBranchPosterior,
    site.mapIntensity, site.meanIntensityGivenShift, site.capturedNullPosteriorMass,
    site.baselineMeanAlpha, site.baselineMeanBeta,
  ].join(","));
  return `${header.join(",")}\n${rows.join("\n")}\n`;
}

export function cladeShiftBranchesToCsv(branches: readonly CladeShiftBranchResult[]): string {
  const header = [
    "Branch", "Name", "Parent", "Terminal", "Descendant tips", "Eligible",
    "Expected shifted sites", "Expected relaxed sites", "Expected intensified sites", "Maximum site posterior", "MAP site",
  ];
  const rows = branches.map((branch) => [
    branch.branch, quote(branch.name), quote(branch.parentName), branch.terminal, branch.descendantTips, branch.eligible,
    branch.expectedShiftedSites, branch.expectedRelaxedSites, branch.expectedIntensifiedSites,
    branch.maximumSitePosterior, branch.mapSite,
  ].join(","));
  return `${header.join(",")}\n${rows.join("\n")}\n`;
}

export async function analyzeCladeShift(
  fasta: CladeShiftInput,
  newick: CladeShiftTreeInput,
  options: CladeShiftAnalysisOptions = {},
): Promise<CladeShiftAnalysisResult> {
  const started = performance.now();
  const alignment = typeof fasta === "string" ? parseFasta(fasta) : fasta;
  // CladeShift is deliberately untagged. Flatten both parsed text and typed
  // tree inputs so stale DifFUBAR/FigTree annotations cannot leak branch
  // classes into the baseline model bank.
  const tree = cloneSingleClassTree(typeof newick === "string" ? parseNewick(newick) : newick);
  const geneticCode = getGeneticCode(options.geneticCode ?? 1);
  const compiled = compileCladeShiftTree(tree);
  if (compiled.edgeNodes.length === 0) throw new DifFUBARError("NO_BRANCHES", "CladeShift requires at least one phylogenetic branch.");
  options.signal?.throwIfAborted();

  const gridPoints = Math.max(8, Math.min(32, Math.round(options.gridPoints ?? 16)));
  const requestedComponents = Math.max(1, Math.min(gridPoints * gridPoints, Math.round(options.posteriorComponents ?? 96)));
  const posteriorMassTarget = options.posteriorMassTarget ?? 0.9;
  const intensityPreset = options.intensityPreset ?? "fast";
  const intensities = intensityValues(intensityPreset);
  const shiftPrior = options.shiftPrior ?? 0.2;
  const threshold = options.posteriorThreshold ?? 0.9;
  const minimumDescendantTips = Math.max(1, Math.round(options.minimumDescendantTips ?? 1));
  if (!(shiftPrior > 0 && shiftPrior < 1)) throw new RangeError("Shift prior must lie strictly between zero and one.");
  if (!(threshold > 0.5 && threshold < 1)) throw new RangeError("Posterior threshold must lie strictly between 0.5 and one.");
  if (!(posteriorMassTarget > 0 && posteriorMassTarget <= 1)) throw new RangeError("Null posterior mass target must lie in (0, 1].");
  const candidateBranches = Uint32Array.from(
    compiled.edgeNodes.map((_node, edge) => edge).filter((edge) => compiled.descendantTips[edge]! >= minimumDescendantTips),
  );
  if (candidateBranches.length === 0) {
    throw new RangeError(`No branch subtends at least ${minimumDescendantTips} tip${minimumDescendantTips === 1 ? "" : "s"}.`);
  }
  stage(options, "initialization", 1, {
    message: `${alignment.names.length.toLocaleString()} taxa · ${alignment.codonSites.toLocaleString()} codons · ${candidateBranches.length.toLocaleString()} candidate descendant clades`,
  });

  // FUBAR supplies both the global codon fit and the null posterior q_s(alpha,beta).
  // The later identity BF = E_q[L_shift/L_null] lets the change-point scan
  // integrate baseline uncertainty without repeating the complete 2-D grid.
  const baselineStarted = performance.now();
  const baseline = await analyzeFubar(alignment, tree, {
    geneticCode: geneticCode.id,
    backend: options.backend === "wasm" ? "wasm" : "wasm-parallel",
    gridPoints,
    inferenceMethod: "dirichlet-em",
    iterations: options.inferenceIterations ?? 1_000,
    concentration: options.concentration ?? 0.5,
    posteriorThreshold: 0.95,
    fitMode: options.fitMode ?? "empirical-fast",
    ...(options.fittedModel === undefined ? {} : { fittedModel: options.fittedModel }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    onStage: (name, fraction, detail) => stage(options, `clade-shift-null-${name}`, fraction, detail),
  });
  const baselineMs = performance.now() - baselineStarted;

  const compressionStarted = performance.now();
  stage(options, "clade-shift-compression", 0, {
    message: `Retaining up to ${requestedComponents.toLocaleString()} null categories per codon until ${(posteriorMassTarget * 100).toFixed(0)}% posterior mass is covered`,
    indeterminate: true,
  });
  const compressed = compressNullPosterior(baseline.posterior, requestedComponents, posteriorMassTarget);
  const modelGrid = createCladeShiftModelGrid(baseline.grid, intensities);
  // FUBAR absorbed global alpha into its private tree; mirror that scaling here.
  for (const node of tree.nodes) node.branchLength *= baseline.fittedModel.globalAlpha;
  const modelBank = buildModelBank(modelGrid.grid, tree, baseline.fittedModel.gtrRates, baseline.fittedModel.f3x4, geneticCode);
  const stateCount = intensities.length + 1;
  const baselineModels = new Uint32Array(alignment.codonSites * compressed.componentCount);
  const shiftedModels = new Uint32Array(baselineModels.length * intensities.length);
  for (let site = 0; site < alignment.codonSites; site += 1) {
    for (let component = 0; component < compressed.componentCount; component += 1) {
      const componentIndex = site * compressed.componentCount + component;
      const category = compressed.categories[componentIndex]!;
      baselineModels[componentIndex] = modelBank.gridModels[modelGrid.categoryIndex[category * stateCount]!]!;
      for (let intensity = 0; intensity < intensities.length; intensity += 1) {
        const gridCategory = modelGrid.categoryIndex[category * stateCount + intensity + 1]!;
        shiftedModels[componentIndex * intensities.length + intensity] = modelBank.gridModels[gridCategory]!;
      }
    }
  }
  const compressionMs = performance.now() - compressionStarted;
  let minimumCapturedPosteriorMass = 1;
  let capturedPosteriorMassTotal = 0;
  let retainedComponentTotal = 0;
  for (let site = 0; site < compressed.capturedMass.length; site += 1) {
    const mass = compressed.capturedMass[site]!;
    minimumCapturedPosteriorMass = Math.min(minimumCapturedPosteriorMass, mass);
    capturedPosteriorMassTotal += mass;
    retainedComponentTotal += compressed.retainedCounts[site]!;
  }
  const meanPosteriorComponents = retainedComponentTotal / compressed.retainedCounts.length;
  stage(options, "clade-shift-compression", 1, {
    message: `${meanPosteriorComponents.toFixed(1)} mean / ${compressed.componentCount.toLocaleString()} maximum components · ${(minimumCapturedPosteriorMass * 100).toFixed(1)}% minimum retained mass`,
    current: compressed.componentCount,
    total: compressed.componentCount,
  });

  const backend = chooseBackend(options.backend ?? "wasm-parallel");
  const runtimeStarted = performance.now();
  stage(options, "clade-shift-runtime", 0, {
    message: backend instanceof ParallelWasmBackend
      ? `Starting up to ${backend.workerCount.toLocaleString()} all-clade message workers`
      : "Preparing the all-clade SIMD WASM kernel",
    indeterminate: true,
  });
  await backend.prepare({ categoryCount: compressed.componentCount * intensities.length, siteCount: alignment.codonSites });
  const runtimeMs = performance.now() - runtimeStarted;
  stage(options, "clade-shift-runtime", 1, { message: "All-clade message runtime ready" });

  const scanStarted = performance.now();
  let kernel;
  try {
    kernel = await backend.evaluateCladeShift({
      tree: compiled.kernel,
      tipStates: encodeCodonTips(alignment, tree, geneticCode),
      siteCount: alignment.codonSites,
      branchLengths: Float64Array.from(compiled.edgeNodes, (node) => node.branchLength),
      baselineModels,
      shiftedModels,
      posteriorWeights: compressed.weights,
      componentCount: compressed.componentCount,
      intensityCount: intensities.length,
      candidateBranches,
      models: modelBank,
      equilibrium: baseline.fittedModel.codonEquilibrium,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      onProgress: (fraction, detail) => stage(options, "clade-shift-scan", fraction, detail),
    });
  } finally {
    if (backend instanceof ParallelWasmBackend) await backend.dispose();
  }
  const scanMs = performance.now() - scanStarted;

  const tabulationStarted = performance.now();
  stage(options, "clade-shift-tabulation", 0, {
    message: "Integrating the fixed priors over K, direction, and initiating clade",
    indeterminate: true,
  });
  const summary = summarizeCladeShift({
    logLikelihoodRatios: kernel.logLikelihoodRatios,
    intensities,
    candidateBranches,
    edgeNodes: compiled.edgeNodes,
    nodeForEdge: compiled.kernel.nodeForEdge,
    descendantTips: compiled.descendantTips,
    capturedMass: compressed.capturedMass,
    baselineSites: baseline.sites,
    shiftPrior,
    threshold,
  });
  const detectedSites = summary.sites.filter((site) => site.detected).map((site) => site.site);
  const tabulationMs = performance.now() - tabulationStarted;
  const meanCapturedPosteriorMass = capturedPosteriorMassTotal / compressed.capturedMass.length;
  stage(options, "clade-shift-tabulation", 1, {
    message: `${detectedSites.length.toLocaleString()} codons exceed the persistent-shift posterior threshold`,
    current: alignment.codonSites,
    total: alignment.codonSites,
  });
  stage(options, "complete", 1, { message: `CladeShift finished with ${kernel.backend}` });
  return {
    method: "clade-shift",
    sites: summary.sites,
    branches: summary.branches,
    detectedSites,
    posterior: summary.posterior,
    intensities,
    shiftPrior,
    fittedModel: baseline.fittedModel as FittedModel,
    backend: kernel.backend,
    timings: {
      baselineMs,
      compressionMs,
      runtimeMs,
      scanMs,
      tabulationMs,
      totalMs: performance.now() - started,
    },
    diagnostics: {
      geneticCodeId: geneticCode.id,
      geneticCodeName: geneticCode.name,
      codonStates: geneticCode.senseCodons.length,
      taxa: alignment.names.length,
      codonSites: alignment.codonSites,
      branches: compiled.edgeNodes.length,
      candidateClades: candidateBranches.length,
      gridPoints,
      baselineCategories: baseline.grid.categoryCount,
      posteriorComponents: compressed.componentCount,
      meanPosteriorComponents,
      posteriorMassTarget,
      intensityStates: intensities.length,
      intensityPreset,
      minimumDescendantTips,
      minimumCapturedPosteriorMass,
      meanCapturedPosteriorMass,
      nullIntegration: "compressed-fubar-posterior-identity",
      cladeAlgorithm: "baseline-outside-plus-shifted-subtree-inside",
      evidenceCalibration: "fixed-prior-empirical-bayes",
      validatedMethod: false,
      precision: "f64",
    },
  };
}

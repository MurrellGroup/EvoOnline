import {
  DifFUBARError,
  ParallelWasmBackend,
  WasmBackend,
  compileTree,
  encodeCodonTips,
  fitGlobalModel,
  normalizeConditionalLikelihoodsInPlace,
  parseFasta,
  parseNewick,
  type FittedModel,
  type ParsedTree,
  type ProgressDetail,
  type TreeNode,
} from "@phylo-workbench/model-diffubar";
import { createFameGrid, createFlavorGrid } from "./model/grids.js";
import { buildFameBranchMixtures, buildFlavorBranchMixtures } from "./model/operators.js";
import {
  postprocessFame,
  postprocessFameAllocations,
  postprocessFlavor,
  postprocessFlavorAllocations,
} from "./posterior.js";
import {
  MIXTURE_MODELS_COMMIT,
  type BameAnalysisOptions,
  type BameInput,
  type BameTreeInput,
  type FameAnalysisOptions,
  type FameAnalysisResult,
  type FlavorAnalysisOptions,
  type FlavorAnalysisResult,
} from "./types.js";

type BameBackend = WasmBackend | ParallelWasmBackend;

function cloneSingleClassTree(tree: ParsedTree): ParsedTree {
  const clones = new Map<TreeNode, TreeNode>();
  for (const node of tree.nodes) {
    clones.set(node, {
      id: node.id,
      name: node.name.replaceAll(/\{[^}]+\}/g, ""),
      branchLength: node.branchLength,
      branchClass: 0,
      parent: null,
      children: [],
      tipIndex: node.tipIndex,
    });
  }
  for (const node of tree.nodes) {
    const clone = clones.get(node)!;
    clone.parent = node.parent === null ? null : clones.get(node.parent)!;
    clone.children = node.children.map((child) => clones.get(child)!);
  }
  return {
    root: clones.get(tree.root)!,
    nodes: tree.nodes.map((node) => clones.get(node)!),
    tips: tree.tips.map((node) => clones.get(node)!),
    classCount: 1,
    hasBackground: false,
    tags: [],
  };
}

function validateFittedModel(model: FittedModel): void {
  if (model.gtrRates.length !== 6 || model.f3x4.length !== 12 || model.codonEquilibrium.length !== 61) {
    throw new DifFUBARError("INVALID_FITTED_MODEL", "Provided fitted model has invalid array dimensions.");
  }
  if (!(model.globalAlpha > 0) || !Number.isFinite(model.globalAlpha)) throw new DifFUBARError("INVALID_FITTED_MODEL", "Provided global alpha must be finite and positive.");
}

function chooseBackend(kind: BameAnalysisOptions["backend"], minimumParallelWork: number): BameBackend {
  return kind === "wasm" ? new WasmBackend() : new ParallelWasmBackend(undefined, minimumParallelWork);
}

function runtimeDescription(backend: BameBackend): string {
  return backend instanceof ParallelWasmBackend
    ? `Compiling WASM once and starting up to ${backend.workerCount.toLocaleString()} branch-mixture workers`
    : "Fetching, compiling, and instantiating the f64 WASM mixture engine";
}

function normalizeColumnsInPlace(conditionals: Float64Array, categoryCount: number, siteCount: number): void {
  for (let site = 0; site < siteCount; site += 1) {
    let total = 0;
    for (let category = 0; category < categoryCount; category += 1) total += conditionals[category * siteCount + site]!;
    if (!(total > 0)) throw new RangeError(`Branch-mixture likelihoods are undefined at codon site ${site + 1}.`);
    const inverse = 1 / total;
    for (let category = 0; category < categoryCount; category += 1) {
      const index = category * siteCount + site;
      conditionals[index] = conditionals[index]! * inverse;
    }
  }
}

async function fitModel(
  alignment: ReturnType<typeof parseFasta>,
  tree: ParsedTree,
  backend: BameBackend,
  options: BameAnalysisOptions,
): Promise<{ readonly model: FittedModel; readonly milliseconds: number }> {
  const started = performance.now();
  if (options.fittedModel !== undefined) {
    validateFittedModel(options.fittedModel);
    options.onStage?.("global-fit", 1, { message: "Using the supplied fitted model" });
    return { model: options.fittedModel, milliseconds: performance.now() - started };
  }
  const model = await fitGlobalModel(
    alignment,
    tree,
    compileTree(tree),
    backend,
    options.fitMode ?? "empirical-fast",
    (fraction, detail) => options.onStage?.("global-fit", fraction, detail),
    options.signal,
  );
  return { model, milliseconds: performance.now() - started };
}

interface InferenceResult {
  readonly theta: Float64Array;
  readonly iterations: number;
  readonly burnin: number;
  readonly logLikelihood: number | null;
  readonly allocations?: Uint32Array;
  readonly retainedIterations: number;
}

async function inferMixture(
  conditionals: Float64Array,
  categories: Float64Array,
  categoryCount: number,
  siteCount: number,
  parameterCount: number,
  backend: WasmBackend,
  options: BameAnalysisOptions,
): Promise<InferenceResult> {
  const inferenceMethod = options.inferenceMethod ?? "dirichlet-em";
  if (inferenceMethod === "gibbs") {
    const iterations = options.iterations ?? 2_500;
    const burnin = options.burnin ?? Math.floor(iterations / 5);
    const sampled = await backend.sample(conditionals, categories, categoryCount, siteCount, parameterCount, {
      iterations,
      burnin,
      concentration: options.concentration ?? 0.1,
      seed: options.seed ?? 1_234,
      samplerMode: "fast-exact",
      trackAllocations: true,
      onProgress: (fraction, detail) => options.onStage?.("gibbs-sampler", fraction, detail),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (sampled.allocations === undefined) throw new Error("BAME Gibbs sampler did not retain site allocations.");
    return {
      theta: sampled.theta,
      iterations,
      burnin,
      logLikelihood: null,
      allocations: sampled.allocations,
      retainedIterations: sampled.retainedIterations,
    };
  }
  const fitted = await backend.fitMixtureWeights(conditionals, categoryCount, siteCount, {
    iterations: options.iterations ?? 2_500,
    concentration: options.concentration ?? 0.1,
    tolerance: options.tolerance ?? 1e-10,
    onProgress: (fraction, detail) => options.onStage?.("dirichlet-em", fraction, detail),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return {
    theta: fitted.theta,
    iterations: fitted.completedIterations,
    burnin: 0,
    logLikelihood: fitted.logLikelihood,
    retainedIterations: 0,
  };
}

function parsedInputs(fasta: BameInput, newick: BameTreeInput) {
  const alignment = typeof fasta === "string" ? parseFasta(fasta) : fasta;
  const tree = typeof newick === "string" ? parseNewick(newick) : cloneSingleClassTree(newick);
  return { alignment, tree };
}

function stage(options: BameAnalysisOptions, name: string, fraction: number, detail?: ProgressDetail): void {
  options.onStage?.(name, fraction, detail);
}

export async function analyzeFame(
  fasta: BameInput,
  newick: BameTreeInput,
  options: FameAnalysisOptions = {},
): Promise<FameAnalysisResult> {
  const started = performance.now();
  const { alignment, tree } = parsedInputs(fasta, newick);
  options.signal?.throwIfAborted();
  stage(options, "initialization", 1, { message: `${alignment.names.length.toLocaleString()} taxa · ${alignment.codonSites.toLocaleString()} codon sites · untagged tree` });
  const gridPreset = options.gridPreset ?? "fast";
  const grid = createFameGrid(gridPreset);
  const integration = options.weightIntegration ?? "likelihood-quadrature";
  const weightPoints = integration === "julia-draft-log-average" ? options.draftWeightPoints ?? 20 : options.quadraturePoints ?? 4;
  const operatorCount = grid.categoryCount * weightPoints;
  // Category-parallel scheduling keeps every worker's 16-site SIMD lanes full,
  // even for tiny demo alignments; the draft grid is always wide enough to pay
  // for worker startup.
  const minimumParallelWork = 0;
  const backend = chooseBackend(options.backend ?? "wasm-parallel", minimumParallelWork);
  const inferenceBackend = new WasmBackend();
  const runtimeStarted = performance.now();
  stage(options, "runtime-initialization", 0, { message: runtimeDescription(backend), indeterminate: true });
  await backend.prepare({ categoryCount: operatorCount, siteCount: alignment.codonSites });
  await inferenceBackend.prepare({ categoryCount: grid.categoryCount, siteCount: alignment.codonSites });
  const runtimeMs = performance.now() - runtimeStarted;
  stage(options, "runtime-initialization", 1, { message: "Parallel f64 branch-mixture runtime ready" });
  const fitted = await fitModel(alignment, tree, backend, options);
  for (const node of tree.nodes) node.branchLength *= fitted.model.globalAlpha;
  const compiled = compileTree(tree);
  const preparationStarted = performance.now();
  stage(options, "branch-mixture-preparation", 0, {
    message: `Compiling ${grid.categoryCount.toLocaleString()} α–ω₁–ω₂ categories × ${weightPoints} weight nodes`,
    current: 0,
    total: operatorCount,
    indeterminate: true,
  });
  const built = buildFameBranchMixtures(grid, tree, fitted.model.gtrRates, fitted.model.f3x4, integration, weightPoints);
  const tipStates = encodeCodonTips(alignment, tree);
  const preparationMs = performance.now() - preparationStarted;
  stage(options, "branch-mixture-preparation", 1, {
    message: `${built.operators.operatorCount.toLocaleString()} branch-mixture operators · ${built.models.modelCount.toLocaleString()} unique atomic ω models`,
    current: operatorCount,
    total: operatorCount,
  });
  const likelihoodStarted = performance.now();
  const likelihood = await backend.evaluateBranchMixture({
    tree: compiled,
    tipStates,
    siteCount: alignment.codonSites,
    grid,
    models: built.models,
    operators: built.operators,
    equilibrium: fitted.model.codonEquilibrium,
    onProgress: (fraction, detail) => stage(options, "branch-mixture-likelihoods", fraction, detail),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const likelihoodMs = performance.now() - likelihoodStarted;
  const conditionals = normalizeConditionalLikelihoodsInPlace(likelihood.logLikelihoods, grid.categoryCount, alignment.codonSites);
  normalizeColumnsInPlace(conditionals, grid.categoryCount, alignment.codonSites);
  const inferenceStarted = performance.now();
  const inference = await inferMixture(conditionals, grid.categories, grid.categoryCount, alignment.codonSites, grid.parameterCount, inferenceBackend, options);
  const inferenceMs = performance.now() - inferenceStarted;
  const posteriorStarted = performance.now();
  stage(options, "tabulation", 0, { message: "Collapsing FAME site posteriors and empirical Bayes factors", indeterminate: true });
  const threshold = options.posteriorThreshold ?? 0.9;
  const postprocessed = inference.allocations === undefined
    ? postprocessFame(conditionals, inference.theta, grid, alignment.codonSites, threshold)
    : postprocessFameAllocations(inference.allocations, inference.retainedIterations, inference.theta, grid, alignment.codonSites, threshold);
  const detectedSites = postprocessed.sites.filter((site) => site.detected).map((site) => site.site);
  const posteriorMs = performance.now() - posteriorStarted;
  stage(options, "tabulation", 1, { message: `${detectedSites.length.toLocaleString()} sites exceed P(ω₂>1) > ${threshold}`, current: alignment.codonSites, total: alignment.codonSites });
  stage(options, "complete", 1, { message: `FAME finished with ${likelihood.backend} · ${integration === "likelihood-quadrature" ? "likelihood quadrature" : "Julia-draft log average"}` });
  return {
    method: "fame",
    sites: postprocessed.sites,
    detectedSites,
    fittedModel: fitted.model,
    grid,
    posterior: postprocessed.posterior,
    theta: inference.theta,
    positivePrior: postprocessed.prior,
    backend: likelihood.backend === "wasm-parallel" ? "wasm-parallel" : "wasm",
    timings: { runtimeMs, fitMs: fitted.milliseconds, preparationMs, likelihoodMs, inferenceMs, posteriorMs, totalMs: performance.now() - started },
    diagnostics: {
      taxa: tree.tips.length,
      codonSites: alignment.codonSites,
      categories: grid.categoryCount,
      branchMixtureOperators: built.operators.operatorCount,
      atomicOmegaModels: built.models.modelCount,
      treeRegisterNumber: compiled.registerNumber,
      precision: "f64",
      inferenceMethod: options.inferenceMethod ?? "dirichlet-em",
      inferenceIterations: inference.iterations,
      inferenceBurnin: inference.burnin,
      inferenceLogLikelihood: inference.logLikelihood,
      modelDraftCommit: MIXTURE_MODELS_COMMIT,
      numericalEngine: "fused-sparse-or-dense-uniformization",
      weightIntegration: integration,
      weightPoints,
      gridPreset,
    },
  };
}

export async function analyzeFlavor(
  fasta: BameInput,
  newick: BameTreeInput,
  options: FlavorAnalysisOptions = {},
): Promise<FlavorAnalysisResult> {
  const started = performance.now();
  const { alignment, tree } = parsedInputs(fasta, newick);
  options.signal?.throwIfAborted();
  stage(options, "initialization", 1, { message: `${alignment.names.length.toLocaleString()} taxa · ${alignment.codonSites.toLocaleString()} codon sites · untagged tree` });
  const gammaSliceCount = options.gammaSlices ?? 12;
  const gridPreset = options.gridPreset ?? "fast";
  const grid = createFlavorGrid(gammaSliceCount, gridPreset);
  const operatorCount = grid.categoryCount;
  const minimumParallelWork = 0;
  const backend = chooseBackend(options.backend ?? "wasm-parallel", minimumParallelWork);
  const inferenceBackend = new WasmBackend();
  const runtimeStarted = performance.now();
  stage(options, "runtime-initialization", 0, { message: runtimeDescription(backend), indeterminate: true });
  await backend.prepare({ categoryCount: operatorCount, siteCount: alignment.codonSites });
  await inferenceBackend.prepare({ categoryCount: grid.categoryCount, siteCount: alignment.codonSites });
  const runtimeMs = performance.now() - runtimeStarted;
  stage(options, "runtime-initialization", 1, { message: "Parallel f64 branch-mixture runtime ready" });
  const fitted = await fitModel(alignment, tree, backend, options);
  for (const node of tree.nodes) node.branchLength *= fitted.model.globalAlpha;
  const compiled = compileTree(tree);
  const preparationStarted = performance.now();
  stage(options, "branch-mixture-preparation", 0, {
    message: `Discretizing capped and uncapped Gamma(ω) mixtures with ${gammaSliceCount} quantiles`,
    current: 0,
    total: grid.categoryCount,
    indeterminate: true,
  });
  const built = buildFlavorBranchMixtures(grid, tree, fitted.model.gtrRates, fitted.model.f3x4, gammaSliceCount);
  const tipStates = encodeCodonTips(alignment, tree);
  const preparationMs = performance.now() - preparationStarted;
  stage(options, "branch-mixture-preparation", 1, {
    message: `${grid.categoryCount.toLocaleString()} Gamma-mixture categories · ${built.models.modelCount.toLocaleString()} unique atomic ω models`,
    current: grid.categoryCount,
    total: grid.categoryCount,
  });
  const likelihoodStarted = performance.now();
  const likelihood = await backend.evaluateBranchMixture({
    tree: compiled,
    tipStates,
    siteCount: alignment.codonSites,
    grid,
    models: built.models,
    operators: built.operators,
    equilibrium: fitted.model.codonEquilibrium,
    onProgress: (fraction, detail) => stage(options, "branch-mixture-likelihoods", fraction, detail),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const likelihoodMs = performance.now() - likelihoodStarted;
  const conditionals = normalizeConditionalLikelihoodsInPlace(likelihood.logLikelihoods, grid.categoryCount, alignment.codonSites);
  normalizeColumnsInPlace(conditionals, grid.categoryCount, alignment.codonSites);
  const inferenceStarted = performance.now();
  const inference = await inferMixture(conditionals, grid.categories, grid.categoryCount, alignment.codonSites, grid.parameterCount, inferenceBackend, options);
  const inferenceMs = performance.now() - inferenceStarted;
  const posteriorStarted = performance.now();
  stage(options, "tabulation", 0, { message: "Collapsing FLAVOR Gamma-mixture posteriors and empirical Bayes factors", indeterminate: true });
  const threshold = options.posteriorThreshold ?? 0.9;
  const postprocessed = inference.allocations === undefined
    ? postprocessFlavor(conditionals, inference.theta, grid, alignment.codonSites, threshold)
    : postprocessFlavorAllocations(inference.allocations, inference.retainedIterations, inference.theta, grid, alignment.codonSites, threshold);
  const detectedSites = postprocessed.sites.filter((site) => site.detected).map((site) => site.site);
  const posteriorMs = performance.now() - posteriorStarted;
  stage(options, "tabulation", 1, { message: `${detectedSites.length.toLocaleString()} sites exceed the episodic-positive posterior threshold`, current: alignment.codonSites, total: alignment.codonSites });
  stage(options, "complete", 1, { message: `FLAVOR finished with ${likelihood.backend} · ${gammaSliceCount}-slice Gamma mixtures` });
  return {
    method: "flavor",
    sites: postprocessed.sites,
    detectedSites,
    fittedModel: fitted.model,
    grid,
    posterior: postprocessed.posterior,
    theta: inference.theta,
    positivePrior: postprocessed.prior,
    backend: likelihood.backend === "wasm-parallel" ? "wasm-parallel" : "wasm",
    timings: { runtimeMs, fitMs: fitted.milliseconds, preparationMs, likelihoodMs, inferenceMs, posteriorMs, totalMs: performance.now() - started },
    diagnostics: {
      taxa: tree.tips.length,
      codonSites: alignment.codonSites,
      categories: grid.categoryCount,
      branchMixtureOperators: built.operators.operatorCount,
      atomicOmegaModels: built.models.modelCount,
      treeRegisterNumber: compiled.registerNumber,
      precision: "f64",
      inferenceMethod: options.inferenceMethod ?? "dirichlet-em",
      inferenceIterations: inference.iterations,
      inferenceBurnin: inference.burnin,
      inferenceLogLikelihood: inference.logLikelihood,
      modelDraftCommit: MIXTURE_MODELS_COMMIT,
      numericalEngine: "fused-sparse-or-dense-uniformization",
      gammaSlices: gammaSliceCount,
      cappedGridMultiplicityRetained: true,
      gridPreset,
    },
  };
}

function csvValue(value: number): string | number {
  return Number.isFinite(value) ? value : value > 0 ? "Infinity" : "-Infinity";
}

export function fameResultsToCsv(result: FameAnalysisResult, threshold = 0.9): string {
  const header = ["Codon Sites", "P(omega2 > 1)", "Empirical Bayes factor", "mean(alpha)", "mean(omega1)", "mean(omega2)", `P(omega2 > 1) > ${threshold}`];
  const rows = result.sites.map((site) => [site.site, site.pPositive, csvValue(site.bayesFactor), site.meanAlpha, site.meanOmega1, site.meanOmega2, site.pPositive > threshold].join(","));
  return `${header.join(",")}\n${rows.join("\n")}\n`;
}

export function flavorResultsToCsv(result: FlavorAnalysisResult, threshold = 0.9): string {
  const header = [
    "Codon Sites", "P(uncapped omega mixture with omega > 1)", "P(uncapped omega mixture)", "Empirical Bayes factor",
    "mean(alpha)", "mean(Gamma omega mean)", "mean(Gamma shape)", "mean(omega SD)", "posterior mean fraction branches omega > 1",
    `positive posterior > ${threshold}`,
  ];
  const rows = result.sites.map((site) => [
    site.site, site.pPositive, site.pUncapped, csvValue(site.bayesFactor), site.meanAlpha, site.meanOmega, site.meanShape,
    site.meanOmegaStandardDeviation, site.meanPositiveBranchFraction, site.pPositive > threshold,
  ].join(","));
  return `${header.join(",")}\n${rows.join("\n")}\n`;
}

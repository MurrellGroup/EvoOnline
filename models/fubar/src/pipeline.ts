import {
  DifFUBARError,
  ParallelWasmBackend,
  WasmBackend,
  WebGPUBackend,
  buildModelBank,
  compileTree,
  encodeCodonTips,
  applySharedTreeScale,
  fitGlobalModel,
  fitPartitionedGlobalModel,
  getGeneticCode,
  insertSegmentConditionals,
  normalizeConditionalLikelihoodsInPlace,
  parseFasta,
  parseNewick,
  prepareRecombinationCodonTrees,
  type FittedModel,
  type ParsedTree,
  type PreparedCodonTreeSegment,
  type TreeNode,
} from "@phylo-workbench/model-diffubar";
import { createFubarGrid } from "./model/grid.js";
import { analyzeApproximateFel } from "./fel/approximate-fel.js";
import { postprocessFubar, postprocessFubarAllocations } from "./posterior/postprocess.js";
import type {
  FubarAnalysisOptions,
  FubarAnalysisResult,
  FubarInput,
  FubarTreeInput,
} from "./types.js";

type Backend = WasmBackend | ParallelWasmBackend | WebGPUBackend;

function runtimeDescription(backend: Backend): string {
  if (backend instanceof ParallelWasmBackend) {
    return `Compiling WASM once and starting ${backend.workerCount.toLocaleString()} likelihood workers`;
  }
  if (backend instanceof WebGPUBackend) return "Requesting the GPU and compiling the WGSL likelihood pipeline";
  return "Fetching, compiling, and instantiating the WASM compute engine";
}

async function prepareComputeRuntime(
  backends: readonly Backend[],
  categoryCount: number,
  siteCount: number,
  onStage: FubarAnalysisOptions["onStage"],
): Promise<number> {
  const started = performance.now();
  const unique = [...new Set(backends)];
  for (let index = 0; index < unique.length; index += 1) {
    const backend = unique[index]!;
    onStage?.("runtime-initialization", index / unique.length, {
      message: runtimeDescription(backend),
      current: index,
      total: unique.length,
      indeterminate: true,
    });
    await backend.prepare({ categoryCount, siteCount });
    onStage?.("runtime-initialization", (index + 1) / unique.length, {
      message: `${backend.kind === "wasm-parallel" ? "Parallel WASM worker pool" : backend.kind === "webgpu" ? "WebGPU pipeline" : "WASM engine"} ready`,
      current: index + 1,
      total: unique.length,
    });
  }
  return performance.now() - started;
}

function chooseBackend(kind: FubarAnalysisOptions["backend"], minimumParallelWork: number): Backend {
  if (kind === "webgpu") return new WebGPUBackend();
  if (kind === "wasm") return new WasmBackend();
  return new ParallelWasmBackend(undefined, minimumParallelWork);
}

function validateFittedModel(model: FittedModel, geneticCodeId: FittedModel["geneticCodeId"], stateCount: number): void {
  if (model.gtrRates.length !== 6 || model.f3x4.length !== 12 || model.codonEquilibrium.length !== stateCount) {
    throw new DifFUBARError("INVALID_FITTED_MODEL", "Provided fitted model has invalid array dimensions.");
  }
  if (model.geneticCodeId !== geneticCodeId) throw new DifFUBARError("GENETIC_CODE_MISMATCH", `Provided model uses NCBI code ${model.geneticCodeId}, but this analysis requested code ${geneticCodeId}.`);
  if (!(model.globalAlpha > 0) || !Number.isFinite(model.globalAlpha)) {
    throw new DifFUBARError("INVALID_FITTED_MODEL", "Provided global alpha must be finite and positive.");
  }
}

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

/** FUBAR_grid additionally normalizes every site's max-shifted likelihood column. */
function normalizeFubarColumnsInPlace(conditionals: Float64Array, categoryCount: number, siteCount: number): void {
  for (let site = 0; site < siteCount; site += 1) {
    let total = 0;
    for (let category = 0; category < categoryCount; category += 1) total += conditionals[category * siteCount + site]!;
    if (!(total > 0)) throw new RangeError(`FUBAR likelihoods are undefined at codon site ${site + 1}.`);
    const inverse = 1 / total;
    for (let category = 0; category < categoryCount; category += 1) {
      const index = category * siteCount + site;
      conditionals[index] = conditionals[index]! * inverse;
    }
  }
}

export async function analyzeFubar(
  fasta: FubarInput,
  newick: FubarTreeInput,
  options: FubarAnalysisOptions = {},
): Promise<FubarAnalysisResult> {
  const started = performance.now();
  const alignment = typeof fasta === "string" ? parseFasta(fasta) : fasta;
  const inputTree = typeof newick === "string" ? parseNewick(newick) : cloneSingleClassTree(newick);
  const segments: readonly PreparedCodonTreeSegment[] = options.recombinationTrees === undefined
    ? [{
      startCodon: 1,
      endCodon: alignment.codonSites,
      siteOffset: 0,
      alignment,
      tree: inputTree,
      input: { startCodon: 1, endCodon: alignment.codonSites, tree: typeof newick === "string" ? newick : "", label: "Full alignment" },
    }]
    : prepareRecombinationCodonTrees(alignment, options.recombinationTrees);
  const tree = segments[0]!.tree;
  const geneticCode = getGeneticCode(options.geneticCode ?? 1);
  options.signal?.throwIfAborted();
  options.onStage?.("initialization", 1, {
    message: `${alignment.names.length.toLocaleString()} taxa · ${alignment.codonSites.toLocaleString()} codon sites · ${segments.length.toLocaleString()} fixed-scale tree${segments.length === 1 ? "" : "s"}`,
  });

  const grid = createFubarGrid(options.gridPoints ?? 20);
  const minimumParallelWork = grid.categoryCount * alignment.codonSites >= 150_000 ? 0 : 150_000;
  const backend = chooseBackend(options.backend ?? "wasm-parallel", minimumParallelWork);
  // Small optimizer dispatches are latency-bound on WebGPU; retain the exact
  // f64 CPU kernel for the global fit even when the user explicitly selects GPU.
  const fitBackend: Backend = backend instanceof WebGPUBackend ? new WasmBackend() : backend;
  const inferenceBackend = fitBackend instanceof WasmBackend ? fitBackend : new WasmBackend();
  const runtimeMs = await prepareComputeRuntime(
    [fitBackend, backend, inferenceBackend],
    grid.categoryCount,
    alignment.codonSites,
    options.onStage,
  );
  const fitStarted = performance.now();
  let fittedModel: FittedModel;
  if (options.fittedModel !== undefined) {
    validateFittedModel(options.fittedModel, geneticCode.id, geneticCode.senseCodons.length);
    fittedModel = options.fittedModel;
    options.onStage?.("global-fit", 1, { message: "Using the supplied fitted model" });
  } else {
    fittedModel = segments.length === 1
      ? await fitGlobalModel(
        alignment,
        tree,
        compileTree(tree),
        fitBackend,
        options.fitMode ?? "empirical-fast",
        (fraction, detail) => options.onStage?.("global-fit", fraction, detail),
        options.signal,
        geneticCode,
      )
      : await fitPartitionedGlobalModel(
        alignment,
        segments.map((segment) => ({ alignment: segment.alignment, tree: segment.tree, compiled: compileTree(segment.tree) })),
        fitBackend,
        options.fitMode ?? "empirical-fast",
        (fraction, detail) => options.onStage?.("global-fit", fraction, detail),
        options.signal,
        geneticCode,
      );
  }
  const fitMs = performance.now() - fitStarted;

  options.onStage?.("grid-preparation", 0, {
    message: `Constructing the ${grid.values.length} × ${grid.values.length} α–β grid`,
    indeterminate: true,
  });
  // Matches alphabetagrid/FUBAR_grid: fit alpha globally, then absorb it into
  // every branch length before evaluating the fixed alpha-beta surface.
  applySharedTreeScale(segments, fittedModel.globalAlpha);
  const models = buildModelBank(grid, tree, fittedModel.gtrRates, fittedModel.f3x4, geneticCode);
  options.onStage?.("grid-preparation", 1, {
    message: `${grid.categoryCount.toLocaleString()} α–β categories · ${models.modelCount.toLocaleString()} unique MG94 models`,
    current: grid.categoryCount,
    total: grid.categoryCount,
  });

  const gridStarted = performance.now();
  const rawLikelihoods = new Float64Array(grid.categoryCount * alignment.codonSites);
  let likelihoodBackend: "webgpu" | "wasm" | "wasm-parallel" = backend.kind;
  let likelihoodPrecision: "f32" | "f64" = backend instanceof WebGPUBackend ? "f32" : "f64";
  let maximumRegisterNumber = 0;
  for (let region = 0; region < segments.length; region += 1) {
    const segment = segments[region]!;
    const compiled = compileTree(segment.tree);
    maximumRegisterNumber = Math.max(maximumRegisterNumber, compiled.registerNumber);
    const local = await backend.evaluate({
      tree: compiled,
      tipStates: encodeCodonTips(segment.alignment, segment.tree, geneticCode),
      siteCount: segment.alignment.codonSites,
      grid,
      models,
      equilibrium: fittedModel.codonEquilibrium,
      onProgress: (fraction, detail) => options.onStage?.("conditional-likelihoods", (region + fraction) / segments.length, {
        ...detail,
        message: `Regional tree ${region + 1}/${segments.length} · ${detail?.message ?? "conditional likelihoods"}`,
      }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    insertSegmentConditionals(rawLikelihoods, local.logLikelihoods, grid.categoryCount, alignment.codonSites, segment);
    likelihoodBackend = local.backend;
    likelihoodPrecision = local.precision;
  }
  const gridMs = performance.now() - gridStarted;
  const approximateFelStarted = performance.now();
  if (options.approximateFel === true) options.onStage?.("approximate-fel", 0, {
    message: `Fitting exact conditional log-likelihood splines for ${alignment.codonSites.toLocaleString()} sites`,
    current: 0,
    total: alignment.codonSites,
  });
  const approximateFel = options.approximateFel === true
    ? analyzeApproximateFel(rawLikelihoods, grid, alignment.codonSites, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      onProgress: (fraction, detail) => options.onStage?.("approximate-fel", fraction, detail),
    })
    : undefined;
  const approximateFelMs = performance.now() - approximateFelStarted;
  const conditionals = normalizeConditionalLikelihoodsInPlace(
    rawLikelihoods,
    grid.categoryCount,
    alignment.codonSites,
  );
  normalizeFubarColumnsInPlace(conditionals, grid.categoryCount, alignment.codonSites);

  const inferenceStarted = performance.now();
  const inferenceMethod = options.inferenceMethod ?? "dirichlet-em";
  let theta: Float64Array;
  let inferenceIterations: number;
  let inferenceBurnin = 0;
  let inferenceLogLikelihood: number | null = null;
  let allocations: Uint32Array | undefined;
  let retainedIterations = 0;
  if (inferenceMethod === "gibbs") {
    const sampler = await inferenceBackend.sampleAlphaBeta(conditionals, grid.categories, grid.categoryCount, alignment.codonSites, {
      ...(options.iterations === undefined ? {} : { iterations: options.iterations }),
      ...(options.burnin === undefined ? {} : { burnin: options.burnin }),
      ...(options.concentration === undefined ? {} : { concentration: options.concentration }),
      ...(options.seed === undefined ? {} : { seed: options.seed }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      trackAllocations: true,
      onProgress: (fraction, detail) => options.onStage?.("gibbs-sampler", fraction, detail),
    });
    if (sampler.allocations === undefined) throw new Error("FUBAR Gibbs sampler did not retain site allocations.");
    theta = sampler.theta;
    allocations = sampler.allocations;
    retainedIterations = sampler.retainedIterations;
    inferenceBurnin = options.burnin ?? Math.floor((options.iterations ?? 2_500) / 5);
    inferenceIterations = sampler.retainedIterations + inferenceBurnin;
  } else {
    const mixture = await inferenceBackend.fitMixtureWeights(conditionals, grid.categoryCount, alignment.codonSites, {
      ...(options.iterations === undefined ? {} : { iterations: options.iterations }),
      ...(options.concentration === undefined ? {} : { concentration: options.concentration }),
      ...(options.tolerance === undefined ? {} : { tolerance: options.tolerance }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      onProgress: (fraction, detail) => options.onStage?.("dirichlet-em", fraction, detail),
    });
    theta = mixture.theta;
    inferenceIterations = mixture.completedIterations;
    inferenceLogLikelihood = mixture.logLikelihood;
  }
  const inferenceMs = performance.now() - inferenceStarted;

  const posteriorStarted = performance.now();
  options.onStage?.("tabulation", 0, { message: "Collapsing site posterior surfaces and marginals", indeterminate: true });
  const threshold = options.posteriorThreshold ?? 0.95;
  const postprocessed = inferenceMethod === "gibbs"
    ? postprocessFubarAllocations(allocations!, retainedIterations, grid, alignment.codonSites, threshold)
    : postprocessFubar(conditionals, theta, grid, alignment.codonSites, threshold);
  const positiveSites = postprocessed.sites.filter((site) => site.pPositive > threshold).map((site) => site.site);
  const purifyingSites = postprocessed.sites.filter((site) => site.pPurifying > threshold).map((site) => site.site);
  const posteriorMs = performance.now() - posteriorStarted;
  options.onStage?.("tabulation", 1, {
    message: `${positiveSites.length.toLocaleString()} positive · ${purifyingSites.length.toLocaleString()} purifying sites`,
    current: alignment.codonSites,
    total: alignment.codonSites,
  });
  options.onStage?.("complete", 1, {
    message: `FUBAR finished with ${likelihoodBackend} · ${segments.length} fixed-scale tree${segments.length === 1 ? "" : "s"} · ${inferenceMethod === "gibbs" ? "Gibbs" : "Dirichlet EM"}${approximateFel === undefined ? "" : " · approximate FEL"}`,
  });

  return {
    sites: postprocessed.sites,
    positiveSites,
    purifyingSites,
    fittedModel,
    grid,
    posterior: postprocessed.posterior,
    ...(approximateFel === undefined ? {} : { approximateFel }),
    theta,
    backend: likelihoodBackend,
    timings: {
      runtimeMs,
      fitMs,
      gridMs,
      ...(approximateFel === undefined ? {} : { approximateFelMs }),
      inferenceMs,
      posteriorMs,
      totalMs: performance.now() - started,
    },
    diagnostics: {
      geneticCodeId: geneticCode.id,
      geneticCodeName: geneticCode.name,
      codonStates: geneticCode.senseCodons.length,
      taxa: tree.tips.length,
      codonSites: alignment.codonSites,
      categories: grid.categoryCount,
      treeRegisterNumber: maximumRegisterNumber,
      precision: likelihoodPrecision,
      inferenceMethod,
      inferenceIterations,
      inferenceBurnin,
      inferenceLogLikelihood,
      regionalTrees: segments.length,
      branchScalePolicy: options.recombinationTrees === undefined ? "single-tree" : "fixed-relative",
      branchLengthSource: options.recombinationTrees?.branchLengthSource ?? "input-tree",
      codonAssignment: options.recombinationTrees?.codonAssignment ?? "single-tree",
    },
  };
}

export function fubarResultsToCsv(result: FubarAnalysisResult, threshold = 0.95): string {
  const header = [
    "Codon Sites",
    "P(beta > alpha)",
    "P(alpha > beta)",
    "mean(alpha)",
    "mean(beta)",
    "positive_selected",
    "purifying_selected",
    "selection",
  ];
  const rows = result.sites.map((site) => {
    const positive = site.pPositive > threshold;
    const purifying = site.pPurifying > threshold;
    const selection = positive ? "positive" : purifying ? "purifying" : "none";
    return [
      site.site,
      site.pPositive,
      site.pPurifying,
      site.meanAlpha,
      site.meanBeta,
      positive,
      purifying,
      selection,
    ].join(",");
  });
  return `${header.join(",")}\n${rows.join("\n")}\n`;
}

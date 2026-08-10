import {
  DifFUBARError,
  type AnalysisOptions,
  type AnalysisResult,
  type FastaAlignment,
  type FittedModel,
  type ParsedTree,
  type TreeNode,
} from "./types.js";
import { parseFasta } from "./io/fasta.js";
import { parseTaggedNewick } from "./io/newick.js";
import { compileTree } from "./tree/compiler.js";
import { createDifFUBARGrid } from "./model/grid.js";
import { buildModelBank, encodeCodonTips } from "./model/genetic-code.js";
import { fitGlobalModel, type EvaluationBackend } from "./fit/global.js";
import { WasmBackend, normalizeConditionalLikelihoodsInPlace } from "./backends/wasm.js";
import { ParallelWasmBackend } from "./backends/wasm-parallel.js";
import { WebGPUBackend } from "./backends/webgpu.js";
import { collapsePosteriorMarginals } from "./posterior/marginals.js";

function validateFittedModel(model: FittedModel): void {
  if (model.gtrRates.length !== 6 || model.f3x4.length !== 12 || model.codonEquilibrium.length !== 61) {
    throw new DifFUBARError("INVALID_FITTED_MODEL", "Provided fitted model has invalid array dimensions.");
  }
  if (!(model.globalAlpha > 0) || !Number.isFinite(model.globalAlpha)) {
    throw new DifFUBARError("INVALID_FITTED_MODEL", "Provided global alpha must be finite and positive.");
  }
}

function chooseBackend(kind: AnalysisOptions["backend"], minimumParallelWork: number): EvaluationBackend {
  if (kind === "webgpu") return new WebGPUBackend();
  if (kind === "wasm") return new WasmBackend();
  if (kind === "wasm-parallel") return new ParallelWasmBackend(undefined, minimumParallelWork);
  return WebGPUBackend.isAvailable() ? new WebGPUBackend() : new ParallelWasmBackend(undefined, minimumParallelWork);
}

function rescaleTree(tree: ParsedTree, scale: number): void {
  for (const node of tree.nodes) node.branchLength *= scale;
}

function cloneTree(tree: ParsedTree): ParsedTree {
  const clones = new Map<TreeNode, TreeNode>();
  for (const node of tree.nodes) {
    clones.set(node, {
      id: node.id,
      name: node.name,
      branchLength: node.branchLength,
      branchClass: node.branchClass,
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
    classCount: tree.classCount,
    hasBackground: tree.hasBackground,
    tags: [...tree.tags],
  };
}

export async function analyzeDifFUBAR(
  fasta: string | FastaAlignment,
  newick: string | ParsedTree,
  options: AnalysisOptions = {},
): Promise<AnalysisResult> {
  const started = performance.now();
  const alignment = typeof fasta === "string" ? parseFasta(fasta) : fasta;
  const tree = typeof newick === "string" ? parseTaggedNewick(newick, options.tags) : cloneTree(newick);
  options.signal?.throwIfAborted();
  options.onStage?.("initialization", 1, {
    message: `${alignment.names.length.toLocaleString()} taxa · ${alignment.codonSites.toLocaleString()} codon sites`,
  });

  const requestedBackend = options.backend ?? "auto";
  const grid = createDifFUBARGrid(tree.hasBackground, options.foregroundGrid ?? 6, options.backgroundGrid ?? 4);
  // Large analyses use the pool even for the small fit batches. This warms all
  // worker instances before the dominant grid and amortizes cold startup.
  const minimumParallelWork = grid.categoryCount * alignment.codonSites >= 150_000 ? 0 : 150_000;
  let backend = chooseBackend(requestedBackend, minimumParallelWork);
  let fitBackend: EvaluationBackend = backend instanceof WebGPUBackend ? new WasmBackend() : backend;
  const initialCompiled = compileTree(tree);
  const fitStarted = performance.now();
  let fittedModel: FittedModel;
  if (options.fittedModel !== undefined) {
    validateFittedModel(options.fittedModel);
    fittedModel = options.fittedModel;
    options.onStage?.("global-fit", 1, { message: "Using the supplied fitted model" });
  } else {
    try {
      fittedModel = await fitGlobalModel(
        alignment,
        tree,
        initialCompiled,
        fitBackend,
        options.fitMode ?? "empirical-fast",
        (fraction, detail) => options.onStage?.("global-fit", fraction, detail),
        options.signal,
      );
    } catch (error) {
      if (requestedBackend !== "auto" || !(fitBackend instanceof WebGPUBackend)) throw error;
      backend = new ParallelWasmBackend(undefined, minimumParallelWork);
      fitBackend = backend;
      fittedModel = await fitGlobalModel(
        alignment,
        tree,
        initialCompiled,
        fitBackend,
        options.fitMode ?? "empirical-fast",
        (fraction, detail) => options.onStage?.("global-fit", fraction, detail),
        options.signal,
      );
    }
  }
  const fitMs = performance.now() - fitStarted;

  // CodonMolecularEvolution rescales every branch by the fitted global alpha so
  // the downstream fixed grid is centered at alpha=1.
  options.onStage?.("grid-preparation", 0, {
    message: `Constructing ${grid.categoryCount.toLocaleString()} rate categories`,
    indeterminate: true,
  });
  rescaleTree(tree, fittedModel.globalAlpha);
  const compiled = compileTree(tree);
  const models = buildModelBank(grid, tree, fittedModel.gtrRates, fittedModel.f3x4);
  const tipStates = encodeCodonTips(alignment, tree);
  options.onStage?.("grid-preparation", 1, {
    message: `${grid.categoryCount.toLocaleString()} categories · ${models.modelCount.toLocaleString()} unique codon models`,
    current: grid.categoryCount,
    total: grid.categoryCount,
  });

  const gridStarted = performance.now();
  let likelihood;
  try {
    likelihood = await backend.evaluate({
      tree: compiled,
      tipStates,
      siteCount: alignment.codonSites,
      grid,
      models,
      equilibrium: fittedModel.codonEquilibrium,
      onProgress: (fraction, detail) => options.onStage?.("conditional-likelihoods", fraction, detail),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    if (requestedBackend !== "auto" || !(backend instanceof WebGPUBackend)) throw error;
    backend = new ParallelWasmBackend(undefined, minimumParallelWork);
    likelihood = await backend.evaluate({
      tree: compiled,
      tipStates,
      siteCount: alignment.codonSites,
      grid,
      models,
      equilibrium: fittedModel.codonEquilibrium,
      onProgress: (fraction, detail) => options.onStage?.("conditional-likelihoods", fraction, detail),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }
  const gridMs = performance.now() - gridStarted;
  const conditionals = normalizeConditionalLikelihoodsInPlace(likelihood.logLikelihoods, grid.categoryCount, alignment.codonSites);

  const samplerStarted = performance.now();
  const sampler = await new WasmBackend().sample(
    conditionals,
    grid.categories,
    grid.categoryCount,
    alignment.codonSites,
    grid.parameterCount,
    {
      ...(options.iterations === undefined ? {} : { iterations: options.iterations }),
      ...(options.burnin === undefined ? {} : { burnin: options.burnin }),
      ...(options.concentration === undefined ? {} : { concentration: options.concentration }),
      ...(options.seed === undefined ? {} : { seed: options.seed }),
      ...(options.samplerMode === undefined ? {} : { samplerMode: options.samplerMode }),
      ...(options.likelihoodCutoff === undefined ? {} : { likelihoodCutoff: options.likelihoodCutoff }),
      trackAllocations: options.trackAllocations === true || options.collectPosteriorMarginals === true,
      onProgress: (fraction, detail) => options.onStage?.("gibbs-sampler", fraction, detail),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  );
  const samplerMs = performance.now() - samplerStarted;
  options.onStage?.("tabulation", 0, { message: "Collapsing allocations into site marginals", indeterminate: true });
  const posteriorThreshold = options.posteriorThreshold ?? 0.95;
  const posteriorMarginals = options.collectPosteriorMarginals === true && sampler.allocations !== undefined
    ? collapsePosteriorMarginals(sampler.allocations, sampler.retainedIterations, grid, alignment.codonSites)
    : undefined;
  const detectedSites = sampler.sites
    .filter((site) => Math.max(site.pOmega1Greater, site.pOmega2Greater, site.pOmega1Positive, site.pOmega2Positive) > posteriorThreshold)
    .map((site) => site.site);
  options.onStage?.("tabulation", 1, {
    message: `${detectedSites.length.toLocaleString()} sites exceed the posterior threshold`,
    current: alignment.codonSites,
    total: alignment.codonSites,
  });
  options.onStage?.("complete", 1, { message: `Analysis finished with ${likelihood.backend}` });

  return {
    sites: sampler.sites,
    detectedSites,
    fittedModel,
    grid,
    ...(posteriorMarginals === undefined ? {} : { posteriorMarginals }),
    backend: likelihood.backend,
    timings: {
      fitMs,
      gridMs,
      samplerMs,
      totalMs: performance.now() - started,
    },
    diagnostics: {
      taxa: tree.tips.length,
      codonSites: alignment.codonSites,
      categories: grid.categoryCount,
      treeRegisterNumber: compiled.registerNumber,
      precision: likelihood.precision,
    },
  };
}

export function resultsToCsv(result: AnalysisResult): string {
  const header = [
    "Codon Sites", "P(ω1 > ω2)", "P(ω2 > ω1)", "P(ω1 > 1)", "P(ω2 > 1)",
    "mean(α)", "mean(ω1)", "mean(ω2)",
  ];
  const rows = result.sites.map((site) => [
    site.site,
    site.pOmega1Greater,
    site.pOmega2Greater,
    site.pOmega1Positive,
    site.pOmega2Positive,
    site.meanAlpha,
    site.meanOmega1,
    site.meanOmega2,
  ].join(","));
  return `${header.join(",")}\n${rows.join("\n")}\n`;
}

import {
  DifFUBARError,
  ParallelWasmBackend,
  WasmBackend,
  compileTree,
  encodeCodonTips,
  fitGlobalModel,
  parseFasta,
  parseNewick,
  type FittedModel,
  type ParsedTree,
  type TreeNode,
} from "@phylo-workbench/model-diffubar";
import { optimizeAlternative } from "./fit/alternative.js";
import { BsrelLikelihood } from "./fit/likelihood.js";
import { optimizeBranchNulls } from "./fit/nulls.js";
import { initialAlternativeRaw } from "./model/parameters.js";
import { bsrelPValue, holmBonferroni } from "./statistics.js";
import { compileBsrelTree } from "./tree/messages.js";
import type {
  BsrelAnalysisOptions,
  BsrelAnalysisResult,
  BsrelBranchResult,
  BsrelInput,
  BsrelTreeInput,
} from "./types.js";

type Backend = WasmBackend | ParallelWasmBackend;

function validateFittedModel(model: FittedModel): void {
  if (model.gtrRates.length !== 6 || model.f3x4.length !== 12 || model.codonEquilibrium.length !== 61) {
    throw new DifFUBARError("INVALID_FITTED_MODEL", "Provided fitted model has invalid array dimensions.");
  }
  if (!(model.globalAlpha > 0) || !Number.isFinite(model.globalAlpha)) {
    throw new DifFUBARError("INVALID_FITTED_MODEL", "Provided global alpha must be finite and positive.");
  }
}

function cloneSingleClassTree(tree: ParsedTree): ParsedTree {
  const clones = new Map<TreeNode, TreeNode>();
  for (const node of tree.nodes) clones.set(node, {
    id: node.id,
    name: node.name.replaceAll(/\{[^}]+\}/g, ""),
    branchLength: node.branchLength,
    branchClass: 0,
    parent: null,
    children: [],
    tipIndex: node.tipIndex,
  });
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

function selectedEdges(scope: BsrelAnalysisOptions["branchScope"], edgeNodes: readonly TreeNode[]): number[] {
  const branchScope = scope ?? "all";
  const result: number[] = [];
  for (let edge = 0; edge < edgeNodes.length; edge += 1) {
    const terminal = edgeNodes[edge]!.children.length === 0;
    if (branchScope === "all" || (branchScope === "terminal" && terminal) || (branchScope === "internal" && !terminal)) result.push(edge);
  }
  return result;
}

function chooseBackend(kind: BsrelAnalysisOptions["backend"]): Backend {
  return kind === "wasm" ? new WasmBackend() : new ParallelWasmBackend(undefined, 0);
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function bsrelResultsToCsv(result: BsrelAnalysisResult): string {
  const header = [
    "Branch", "Name", "Parent", "Terminal", "Tested", "Input branch length", "Fitted branch length",
    "omega-", "weight-", "omegaN", "weightN", "omega+", "weight+", "Mean omega",
    "Alternative log L", "Null log L", "LRT", "Raw p-value", "Holm p-value", "Significant",
  ];
  const rows = result.branches.map((branch) => [
    branch.branch,
    csvCell(branch.name),
    csvCell(branch.parentName),
    branch.terminal,
    branch.tested,
    branch.inputLength,
    branch.fittedLength,
    branch.omegaMinus,
    branch.weightMinus,
    branch.omegaNeutral,
    branch.weightNeutral,
    branch.omegaPositive,
    branch.weightPositive,
    branch.meanOmega,
    result.alternativeLogLikelihood,
    branch.nullLogLikelihood ?? "",
    branch.likelihoodRatio ?? "",
    branch.pValue ?? "",
    branch.pValueHolm ?? "",
    branch.significant,
  ].join(","));
  return `${header.join(",")}\n${rows.join("\n")}\n`;
}

export async function analyzeBsrel(
  fasta: BsrelInput,
  newick: BsrelTreeInput,
  options: BsrelAnalysisOptions = {},
): Promise<BsrelAnalysisResult> {
  const started = performance.now();
  const alignment = typeof fasta === "string" ? parseFasta(fasta) : fasta;
  const tree = typeof newick === "string" ? parseNewick(newick) : cloneSingleClassTree(newick);
  options.signal?.throwIfAborted();
  const compiledMessages = compileBsrelTree(tree);
  if (compiledMessages.edgeNodes.length === 0) throw new DifFUBARError("NO_BRANCHES", "BS-REL requires at least one phylogenetic branch.");
  options.onStage?.("initialization", 1, {
    message: `${alignment.names.length.toLocaleString()} taxa · ${alignment.codonSites.toLocaleString()} codon sites · ${compiledMessages.edgeNodes.length.toLocaleString()} fixed three-rate branch mixtures`,
  });

  const maximumOmega = options.maximumOmega ?? 1_000;
  if (!(maximumOmega > 1.01) || !Number.isFinite(maximumOmega)) throw new RangeError("Maximum omega must be finite and greater than one.");
  const alternativeIterations = Math.max(1, Math.round(options.alternativeIterations ?? 45));
  const nullIterations = Math.max(1, Math.round(options.nullIterations ?? 10));
  const tolerance = options.tolerance ?? 1e-5;
  const threshold = options.significanceThreshold ?? 0.05;
  if (!(threshold > 0 && threshold <= 1)) throw new RangeError("Significance threshold must lie in (0, 1].");

  const analysisBackend = chooseBackend(options.backend ?? "wasm-parallel");
  const fitBackend = new WasmBackend();
  const runtimeStarted = performance.now();
  options.onStage?.("runtime-initialization", 0, {
    message: analysisBackend instanceof ParallelWasmBackend
      ? `Compiling SIMD WASM and starting ${analysisBackend.workerCount.toLocaleString()} all-message workers`
      : "Compiling the SIMD WASM all-message kernel",
    indeterminate: true,
  });
  await Promise.all([
    fitBackend.prepare({ categoryCount: 8, siteCount: alignment.codonSites }),
    analysisBackend.prepare({ categoryCount: compiledMessages.edgeNodes.length * 6, siteCount: alignment.codonSites }),
  ]);
  const runtimeMs = performance.now() - runtimeStarted;
  options.onStage?.("runtime-initialization", 1, { message: "BS-REL message runtime ready" });

  const inputLengths = Float64Array.from(compiledMessages.edgeNodes, (node) => node.branchLength);
  const fitStarted = performance.now();
  let fittedModel: FittedModel;
  if (options.fittedModel !== undefined) {
    validateFittedModel(options.fittedModel);
    fittedModel = options.fittedModel;
    options.onStage?.("global-fit", 1, { message: "Using the supplied global codon fit" });
  } else {
    fittedModel = await fitGlobalModel(
      alignment,
      tree,
      compileTree(tree),
      fitBackend,
      options.fitMode ?? "empirical-fast",
      (fraction, detail) => options.onStage?.("global-fit", fraction, detail),
      options.signal,
    );
  }
  const fitMs = performance.now() - fitStarted;

  // As in the FUBAR pipeline, absorb fitted alpha into branch time. The
  // branch-specific optimizer then adjusts a bounded log multiplier per edge.
  for (const node of tree.nodes) node.branchLength *= fittedModel.globalAlpha;
  const baseLengths = Float64Array.from(compiledMessages.edgeNodes, (node) => Math.max(1e-8, node.branchLength));
  const tipStates = encodeCodonTips(alignment, tree);
  const likelihood = new BsrelLikelihood(
    analysisBackend,
    compiledMessages,
    tree,
    tipStates,
    alignment.codonSites,
    fittedModel,
    options.signal,
  );

  const alternativeStarted = performance.now();
  const alternative = await optimizeAlternative(
    likelihood,
    initialAlternativeRaw(baseLengths.length, maximumOmega),
    baseLengths,
    maximumOmega,
    alignment.codonSites,
    alternativeIterations,
    tolerance,
    (fraction, detail) => options.onStage?.("branch-alternative", fraction, detail),
    options.signal,
  );
  const alternativeMs = performance.now() - alternativeStarted;

  const testedEdges = selectedEdges(options.branchScope, compiledMessages.edgeNodes);
  const nullStarted = performance.now();
  const nulls = testedEdges.length === 0
    ? { raw: new Float64Array(0), logLikelihoods: new Float64Array(0), completedIterations: 0 }
    : await optimizeBranchNulls(
      likelihood,
      alternative.raw,
      alternative.models,
      testedEdges,
      baseLengths,
      nullIterations,
      (fraction, detail) => options.onStage?.("branch-nulls", fraction, detail),
      options.signal,
    );
  const nullMs = performance.now() - nullStarted;

  const testIndex = new Map(testedEdges.map((edge, index) => [edge, index]));
  const likelihoodRatios = testedEdges.map((edge) => {
    const index = testIndex.get(edge)!;
    const model = alternative.models[edge]!;
    const estimablePositiveClass = model.weightPositive * (model.omegaPositive - 1) > 1e-8;
    return estimablePositiveClass
      ? Math.max(0, 2 * (alternative.logLikelihood - nulls.logLikelihoods[index]!))
      : 0;
  });
  const rawPValues = likelihoodRatios.map(bsrelPValue);
  const adjusted = holmBonferroni(rawPValues);
  const branches: BsrelBranchResult[] = compiledMessages.edgeNodes.map((node, edge) => {
    const model = alternative.models[edge]!;
    const index = testIndex.get(edge);
    const lrt = index === undefined ? null : likelihoodRatios[index]!;
    const pValue = index === undefined ? null : rawPValues[index]!;
    const pValueHolm = index === undefined ? null : adjusted[index]!;
    const fallbackName = node.children.length === 0 ? `Tip ${node.tipIndex + 1}` : `Internal branch ${node.id}`;
    return {
      branch: edge + 1,
      nodeId: node.id,
      nodeIndex: compiledMessages.kernel.nodeForEdge[edge]!,
      name: node.name.length > 0 ? node.name : fallbackName,
      parentName: node.parent?.name || "Root",
      terminal: node.children.length === 0,
      tested: index !== undefined,
      inputLength: inputLengths[edge]!,
      fittedLength: model.length,
      omegaMinus: model.omegaMinus,
      weightMinus: model.weightMinus,
      omegaNeutral: model.omegaNeutral,
      weightNeutral: model.weightNeutral,
      omegaPositive: model.omegaPositive,
      weightPositive: model.weightPositive,
      meanOmega: model.omegaMinus * model.weightMinus + model.omegaNeutral * model.weightNeutral + model.omegaPositive * model.weightPositive,
      nullLogLikelihood: index === undefined ? null : nulls.logLikelihoods[index]!,
      likelihoodRatio: lrt,
      pValue,
      pValueHolm,
      significant: pValueHolm !== null && pValueHolm <= threshold,
    };
  });
  const totalMs = performance.now() - started;
  const significantBranches = branches.filter((branch) => branch.significant).length;
  options.onStage?.("tabulation", 1, {
    message: `${significantBranches.toLocaleString()} branches significant after Holm correction`,
    current: branches.length,
    total: branches.length,
  });
  options.onStage?.("complete", 1, { message: `BS-REL finished with ${analysisBackend.kind}` });
  return {
    branches,
    fittedModel,
    alternativeLogLikelihood: alternative.logLikelihood,
    backend: analysisBackend.kind,
    timings: { runtimeMs, fitMs, alternativeMs, nullMs, totalMs },
    diagnostics: {
      taxa: alignment.names.length,
      codonSites: alignment.codonSites,
      branches: branches.length,
      testedBranches: testedEdges.length,
      significantBranches,
      alternativeIterations: alternative.completedIterations,
      alternativeConverged: alternative.converged,
      nullIterations: nulls.completedIterations,
      maximumOmega,
      lrtCalibration: "0.50*chi2_0 + 0.05*chi2_1 + 0.45*chi2_2",
      multipleTesting: "Holm-Bonferroni",
      messageAlgorithm: "upward-downward-local-blanket",
      precision: "f64",
    },
  };
}

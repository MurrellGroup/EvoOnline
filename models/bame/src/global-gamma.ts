import {
  DifFUBARError,
  ParallelWasmBackend,
  WasmBackend,
  buildModelBank,
  compileTree,
  encodeCodonTips,
  fitGlobalModel,
  getGeneticCode,
  parseFasta,
  parseNewick,
  type BranchMixtureOperators,
  type DifFUBARGrid,
  type FittedModel,
  type ParsedTree,
  type ProgressDetail,
  type TreeNode,
} from "@phylo-workbench/model-diffubar";
import { gammaMeanSlices, logGamma, thresholdGammaSlices } from "./math/gamma.js";
import { gaussLegendreUnit } from "./model/operators.js";
import type {
  BameBackendKind,
  FlavorGrid,
  GlobalGammaAnalysisOptions,
  GlobalGammaAnalysisResult,
  GlobalGammaBranchResult,
  GlobalGammaFit,
  GlobalGammaFitPreset,
  GlobalGammaSiteResult,
} from "./types.js";

type Backend = WasmBackend | ParallelWasmBackend;

interface GammaCandidate {
  readonly omegaMean: number;
  readonly omegaShape: number;
  readonly alphaShape: number;
}

interface CompiledMessageTree {
  readonly kernel: {
    readonly parent: Int32Array;
    readonly childOffsets: Uint32Array;
    readonly children: Uint32Array;
    readonly tipForNode: Int32Array;
    readonly edgeForNode: Int32Array;
    readonly nodeForEdge: Uint32Array;
    readonly postorder: Uint32Array;
    readonly preorder: Uint32Array;
    readonly root: number;
    readonly nodeCount: number;
    readonly edgeCount: number;
    readonly tipCount: number;
  };
  readonly nodes: readonly TreeNode[];
  readonly edgeNodes: readonly TreeNode[];
}

function compileMessageTree(tree: ParsedTree): CompiledMessageTree {
  const nodes: TreeNode[] = [];
  const preorder: number[] = [];
  const postorder: number[] = [];
  const index = new Map<TreeNode, number>();
  const visit = (node: TreeNode): void => {
    const nodeIndex = nodes.length;
    nodes.push(node);
    index.set(node, nodeIndex);
    preorder.push(nodeIndex);
    for (const child of node.children) visit(child);
    postorder.push(nodeIndex);
  };
  visit(tree.root);
  const parent = new Int32Array(nodes.length).fill(-1);
  const tipForNode = new Int32Array(nodes.length).fill(-1);
  const edgeForNode = new Int32Array(nodes.length).fill(-1);
  const childOffsets = new Uint32Array(nodes.length + 1);
  const children: number[] = [];
  const edgeNodes = nodes.filter((node) => node !== tree.root);
  const edgeIndex = new Map(edgeNodes.map((node, edge) => [node, edge]));
  for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
    const node = nodes[nodeIndex]!;
    childOffsets[nodeIndex] = children.length;
    for (const child of node.children) children.push(index.get(child)!);
    if (node.parent !== null) parent[nodeIndex] = index.get(node.parent)!;
    if (node.tipIndex >= 0) tipForNode[nodeIndex] = node.tipIndex;
    const edge = edgeIndex.get(node);
    if (edge !== undefined) edgeForNode[nodeIndex] = edge;
  }
  childOffsets[nodes.length] = children.length;
  return {
    kernel: {
      parent,
      childOffsets,
      children: Uint32Array.from(children),
      tipForNode,
      edgeForNode,
      nodeForEdge: Uint32Array.from(edgeNodes, (node) => index.get(node)!),
      postorder: Uint32Array.from(postorder),
      preorder: Uint32Array.from(preorder),
      root: index.get(tree.root)!,
      nodeCount: nodes.length,
      edgeCount: edgeNodes.length,
      tipCount: tree.tips.length,
    },
    nodes,
    edgeNodes,
  };
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

function validateFittedModel(model: FittedModel, geneticCodeId: FittedModel["geneticCodeId"], stateCount: number): void {
  if (model.gtrRates.length !== 6 || model.f3x4.length !== 12 || model.codonEquilibrium.length !== stateCount) {
    throw new DifFUBARError("INVALID_FITTED_MODEL", "Provided fitted model has invalid array dimensions.");
  }
  if (model.geneticCodeId !== geneticCodeId) throw new DifFUBARError("GENETIC_CODE_MISMATCH", `Provided model uses NCBI code ${model.geneticCodeId}, but this analysis requested code ${geneticCodeId}.`);
  if (!(model.globalAlpha > 0) || !Number.isFinite(model.globalAlpha)) {
    throw new DifFUBARError("INVALID_FITTED_MODEL", "Provided global alpha must be finite and positive.");
  }
}

function chooseBackend(kind: BameBackendKind | undefined): Backend {
  return kind === "wasm" ? new WasmBackend() : new ParallelWasmBackend(undefined, 0);
}

function stage(options: GlobalGammaAnalysisOptions, name: string, fraction: number, detail?: ProgressDetail): void {
  options.onStage?.(name, fraction, detail);
}

function coarseCandidates(preset: GlobalGammaFitPreset): readonly GammaCandidate[] {
  const omegaMeans = preset === "thorough"
    ? [0.08, 0.13, 0.21, 0.34, 0.55, 0.8, 1.1, 1.55, 2.3, 3.6, 6]
    : [0.06, 0.25, 1, 4.5];
  const omegaShapes = preset === "thorough"
    ? [0.12, 0.2, 0.32, 0.5, 0.8, 1.25, 2, 3.2, 5, 8]
    : [0.08, 0.32, 1.3, 5.2];
  const alphaShapes = preset === "thorough"
    ? [0.16, 0.25, 0.4, 0.63, 1, 1.6, 2.5, 4, 6.3, 10]
    : [0.12, 0.5, 2, 8];
  const candidates: GammaCandidate[] = [];
  for (const omegaMean of omegaMeans) for (const omegaShape of omegaShapes) for (const alphaShape of alphaShapes) {
    candidates.push({ omegaMean, omegaShape, alphaShape });
  }
  return candidates;
}

function refinementCandidates(center: GammaCandidate, logRadius: number): readonly GammaCandidate[] {
  const around = (value: number, minimum: number, maximum: number): readonly number[] => {
    const values = [-logRadius, 0, logRadius].map((offset) => Math.max(minimum, Math.min(maximum, value * Math.exp(offset))));
    return [...new Set(values.map((entry) => Number(entry.toPrecision(13))))];
  };
  const means = around(center.omegaMean, 0.03, 12);
  const omegaShapes = around(center.omegaShape, 0.08, 12);
  const alphaShapes = around(center.alphaShape, 0.1, 16);
  const candidates: GammaCandidate[] = [];
  for (const omegaMean of means) for (const omegaShape of omegaShapes) for (const alphaShape of alphaShapes) {
    candidates.push({ omegaMean, omegaShape, alphaShape });
  }
  return candidates;
}

function candidateFlavorGrid(candidates: readonly GammaCandidate[], omegaSliceCount: number, alphaSliceCount: number): FlavorGrid {
  const categoryCount = candidates.length * alphaSliceCount;
  const categories = new Float64Array(categoryCount * 4);
  const muValues = Float64Array.from(candidates, (candidate) => candidate.omegaMean);
  const shapeValues = Float64Array.from(candidates, (candidate) => candidate.omegaShape);
  const alphaValues = gammaMeanSlices(1, candidates[0]!.alphaShape, alphaSliceCount);
  const muIndex = new Uint16Array(categoryCount);
  const shapeIndex = new Uint16Array(categoryCount);
  const alphaIndex = new Uint16Array(categoryCount);
  const capped = new Uint8Array(categoryCount);
  const positiveMask = new Uint8Array(categoryCount);
  const positiveBranchFraction = new Float32Array(categoryCount);
  let category = 0;
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    const candidate = candidates[candidateIndex]!;
    const alphaRates = gammaMeanSlices(1, candidate.alphaShape, alphaSliceCount);
    const omegaRates = thresholdGammaSlices(candidate.omegaMean, candidate.omegaShape, omegaSliceCount);
    const positiveFraction = omegaRates.positiveProbability;
    for (let alpha = 0; alpha < alphaSliceCount; alpha += 1) {
      const offset = category * 4;
      categories[offset] = alphaRates[alpha]!;
      categories[offset + 1] = candidate.omegaMean;
      categories[offset + 2] = candidate.omegaShape;
      categories[offset + 3] = 0;
      muIndex[category] = candidateIndex;
      shapeIndex[category] = candidateIndex;
      alphaIndex[category] = alpha;
      positiveMask[category] = positiveFraction > 0 ? 1 : 0;
      positiveBranchFraction[category] = positiveFraction;
      category += 1;
    }
  }
  return {
    alpha: alphaValues,
    omega: muValues,
    backgroundOmega: new Float64Array(0),
    categories,
    categoryCount,
    parameterCount: 4,
    hasBackground: false,
    muValues,
    shapeValues,
    alphaValues,
    muIndex,
    shapeIndex,
    alphaIndex,
    capped,
    positiveMask,
    positiveBranchFraction,
  };
}

function buildCandidateMixtures(
  grid: FlavorGrid,
  candidates: readonly GammaCandidate[],
  tree: ParsedTree,
  fittedModel: FittedModel,
  omegaSliceCount: number,
  alphaSliceCount: number,
) {
  const catalog: number[] = [];
  const catalogIds = new Map<string, number>();
  const addOmega = (omega: number): number => {
    const key = omega.toPrecision(17);
    const present = catalogIds.get(key);
    if (present !== undefined) return present;
    const id = catalog.length;
    catalog.push(omega);
    catalogIds.set(key, id);
    return id;
  };
  const distributions = candidates.map((candidate) => thresholdGammaSlices(candidate.omegaMean, candidate.omegaShape, omegaSliceCount));
  const operatorOffsets = new Uint32Array(grid.categoryCount + 1);
  const componentIds: number[] = [];
  const componentWeights: number[] = [];
  const operatorScales = new Float64Array(grid.categoryCount);
  for (let candidate = 0; candidate < candidates.length; candidate += 1) {
    const distribution = distributions[candidate]!;
    for (let alpha = 0; alpha < alphaSliceCount; alpha += 1) {
      const operator = candidate * alphaSliceCount + alpha;
      operatorOffsets[operator] = componentIds.length;
      for (let omega = 0; omega < distribution.values.length; omega += 1) {
        if (!(distribution.weights[omega]! > 0)) continue;
        componentIds.push(addOmega(distribution.values[omega]!));
        componentWeights.push(distribution.weights[omega]!);
      }
      operatorScales[operator] = grid.categories[operator * grid.parameterCount]!;
    }
  }
  operatorOffsets[grid.categoryCount] = componentIds.length;
  const models = buildModelBank(atomicGrid(Float64Array.from(catalog)), tree, fittedModel.gtrRates, fittedModel.f3x4, fittedModel.geneticCodeId);
  const operators: BranchMixtureOperators = {
    operatorCount: grid.categoryCount,
    operatorOffsets,
    componentModels: Uint32Array.from(componentIds, (id) => models.gridModels[id]!),
    componentWeights: Float64Array.from(componentWeights),
    operatorScales,
    operatorsPerCategory: 1,
    collapseWeights: new Float64Array(grid.categoryCount).fill(1),
    collapseMode: "log-mean-likelihood",
  };
  return { models, operators };
}

function logAdd(left: number, right: number): number {
  if (left === Number.NEGATIVE_INFINITY) return right;
  if (right === Number.NEGATIVE_INFINITY) return left;
  const maximum = Math.max(left, right);
  return maximum + Math.log(Math.exp(left - maximum) + Math.exp(right - maximum));
}

function candidateObjectives(logLikelihoods: Float64Array, candidateCount: number, alphaCount: number, siteCount: number): Float64Array {
  const objectives = new Float64Array(candidateCount);
  const logWeight = -Math.log(alphaCount);
  for (let candidate = 0; candidate < candidateCount; candidate += 1) {
    let objective = 0;
    for (let site = 0; site < siteCount; site += 1) {
      let marginal = Number.NEGATIVE_INFINITY;
      for (let alpha = 0; alpha < alphaCount; alpha += 1) {
        const category = candidate * alphaCount + alpha;
        marginal = logAdd(marginal, logWeight + logLikelihoods[category * siteCount + site]!);
      }
      objective += marginal;
    }
    objectives[candidate] = objective;
  }
  return objectives;
}

async function evaluateCandidates(
  candidates: readonly GammaCandidate[],
  omegaSliceCount: number,
  alphaSliceCount: number,
  tree: ParsedTree,
  fittedModel: FittedModel,
  tipStates: Uint8Array,
  siteCount: number,
  backend: Backend,
  onProgress: (fraction: number, detail?: ProgressDetail) => void,
  signal?: AbortSignal,
): Promise<{ readonly candidate: GammaCandidate; readonly logLikelihood: number }> {
  signal?.throwIfAborted();
  const grid = candidateFlavorGrid(candidates, omegaSliceCount, alphaSliceCount);
  const built = buildCandidateMixtures(grid, candidates, tree, fittedModel, omegaSliceCount, alphaSliceCount);
  const request = {
    tree: compileTree(tree),
    tipStates,
    siteCount,
    grid,
    models: built.models,
    operators: built.operators,
    equilibrium: fittedModel.codonEquilibrium,
    alphaCount: alphaSliceCount,
    interpolation: { timeStep: 0.001, tablePoints: 50, tableCap: 35 },
    onProgress,
    ...(signal === undefined ? {} : { signal }),
  } as const;
  const likelihood = await backend.evaluateFlavorInterpolated(request);
  const objectives = candidateObjectives(likelihood.logLikelihoods, candidates.length, alphaSliceCount, siteCount);
  let best = 0;
  for (let index = 1; index < objectives.length; index += 1) if (objectives[index]! > objectives[best]!) best = index;
  return { candidate: candidates[best]!, logLikelihood: objectives[best]! };
}

function atomicGrid(omegaValues: Float64Array): DifFUBARGrid {
  const categories = new Float64Array((omegaValues.length + 1) * 2);
  for (let index = 0; index < omegaValues.length; index += 1) {
    categories[index * 2] = 1;
    categories[index * 2 + 1] = omegaValues[index]!;
  }
  categories[omegaValues.length * 2] = 1;
  categories[omegaValues.length * 2 + 1] = 1;
  return {
    alpha: Float64Array.of(1),
    omega: Float64Array.from([...omegaValues, 1]),
    backgroundOmega: new Float64Array(0),
    categories,
    categoryCount: omegaValues.length + 1,
    parameterCount: 2,
    hasBackground: false,
  };
}

function finalOuterGrid(alphaValues: Float64Array): DifFUBARGrid {
  const categories = new Float64Array(alphaValues.length * 2);
  for (let index = 0; index < alphaValues.length; index += 1) {
    categories[index * 2] = alphaValues[index]!;
    categories[index * 2 + 1] = 1;
  }
  return {
    alpha: alphaValues,
    omega: Float64Array.of(1),
    backgroundOmega: new Float64Array(0),
    categories,
    categoryCount: alphaValues.length,
    parameterCount: 2,
    hasBackground: false,
  };
}

function finalOperators(
  alphaValues: Float64Array,
  omegaModels: Uint32Array,
  omegaWeights: Float64Array,
  positiveMask: Uint8Array,
  neutralModel: number,
  capped: boolean,
): BranchMixtureOperators {
  const componentCount = omegaModels.length;
  const operatorOffsets = new Uint32Array(alphaValues.length + 1);
  const componentModels = new Uint32Array(alphaValues.length * componentCount);
  const componentWeights = new Float64Array(componentModels.length);
  for (let alpha = 0; alpha < alphaValues.length; alpha += 1) {
    operatorOffsets[alpha] = alpha * componentCount;
    for (let omega = 0; omega < componentCount; omega += 1) {
      componentModels[alpha * componentCount + omega] = capped && positiveMask[omega] !== 0 ? neutralModel : omegaModels[omega]!;
      componentWeights[alpha * componentCount + omega] = omegaWeights[omega]!;
    }
  }
  operatorOffsets[alphaValues.length] = componentModels.length;
  return {
    operatorCount: alphaValues.length,
    operatorOffsets,
    componentModels,
    componentWeights,
    operatorScales: alphaValues,
    operatorsPerCategory: 1,
    collapseWeights: new Float64Array(alphaValues.length).fill(1),
    collapseMode: "log-mean-likelihood",
  };
}

function collapseAlpha(logLikelihoods: Float64Array, alphaCount: number, siteCount: number): Float64Array {
  const result = new Float64Array(siteCount);
  const logWeight = -Math.log(alphaCount);
  for (let site = 0; site < siteCount; site += 1) {
    let value = Number.NEGATIVE_INFINITY;
    for (let alpha = 0; alpha < alphaCount; alpha += 1) value = logAdd(value, logWeight + logLikelihoods[alpha * siteCount + site]!);
    result[site] = value;
  }
  return result;
}

function logOneMinusExp(logValue: number): number {
  if (logValue >= 0) return Number.NEGATIVE_INFINITY;
  return logValue < -Math.LN2 ? Math.log1p(-Math.exp(logValue)) : Math.log(-Math.expm1(logValue));
}

function eventLogOddsFromLogNoEvent(logNoEvent: number): number {
  if (logNoEvent === Number.NEGATIVE_INFINITY) return Number.POSITIVE_INFINITY;
  return logOneMinusExp(logNoEvent) - logNoEvent;
}

function logOddsDifference(posterior: number, prior: number): number {
  if (posterior === prior) return 0;
  if (!Number.isFinite(posterior) && !Number.isFinite(prior) && Math.sign(posterior) === Math.sign(prior)) return 0;
  return posterior - prior;
}

function logMixtureRatio(lambda: number, logRatio: number): number {
  return logAdd(Math.log1p(-lambda), Math.log(lambda) + logRatio);
}

function activationStatistics(logRatios: ArrayLike<number>, priorAlpha: number, priorBeta: number): {
  readonly logBayesFactor: number;
  readonly posteriorMean: number;
} {
  const rule = gaussLegendreUnit(24);
  const logNormaliser = logGamma(priorAlpha) + logGamma(priorBeta) - logGamma(priorAlpha + priorBeta);
  let denominator = Number.NEGATIVE_INFINITY;
  let numerator = Number.NEGATIVE_INFINITY;
  for (let node = 0; node < rule.nodes.length; node += 1) {
    const lambda = rule.nodes[node]!;
    let logIntegrand = Math.log(rule.weights[node]!)
      + (priorAlpha - 1) * Math.log(lambda)
      + (priorBeta - 1) * Math.log1p(-lambda)
      - logNormaliser;
    for (let site = 0; site < logRatios.length; site += 1) logIntegrand += logMixtureRatio(lambda, logRatios[site]!);
    denominator = logAdd(denominator, logIntegrand);
    numerator = logAdd(numerator, logIntegrand + Math.log(lambda));
  }
  return { logBayesFactor: denominator, posteriorMean: Math.exp(numerator - denominator) };
}

function probabilityFromLogEvidence(logEvidence: number): number {
  if (logEvidence >= 0) return 1 / (1 + Math.exp(-Math.min(745, logEvidence)));
  const exp = Math.exp(Math.max(-745, logEvidence));
  return exp / (1 + exp);
}

function ratioFromLog(logValue: number): number {
  if (logValue > 709) return Number.POSITIVE_INFINITY;
  if (logValue < -745) return 0;
  return Math.exp(logValue);
}

function csvValue(value: number | null): string | number {
  if (value === null) return "";
  return Number.isFinite(value) ? value : value > 0 ? "Infinity" : "-Infinity";
}

export function globalGammaSitesToCsv(result: GlobalGammaAnalysisResult): string {
  const header = [
    "Codon site", "Full vs all-branches omega>1-to-1 null log evidence", "Full/null evidence ratio", "Equal-prior conditional support",
    "Expected positive branches", "Maximum branch posterior",
  ];
  const rows = result.sites.map((site) => [
    site.site, site.cappedLogEvidence, csvValue(site.cappedEvidenceRatio), site.conditionalSupport,
    site.expectedPositiveBranches, site.maximumBranchPosterior,
  ].join(","));
  return `${header.join(",")}\n${rows.join("\n")}\n`;
}

export function globalGammaBranchesToCsv(result: GlobalGammaAnalysisResult): string {
  const header = [
    "Branch", "Name", "Parent", "Terminal", "Branch length", "Full vs branch omega>1-to-1 null log evidence", "Full/null evidence ratio",
    "Activation log empirical BF", "Activation empirical BF", "Posterior mean activation", "Expected positive sites",
    "P(any positive site)", "Any-site log empirical BF", "Maximum site posterior",
  ];
  const quote = (value: string): string => /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  const rows = result.branches.map((branch) => [
    branch.branch, quote(branch.name), quote(branch.parentName), branch.terminal, branch.branchLength,
    csvValue(branch.cappedLogEvidence), csvValue(branch.cappedEvidenceRatio), branch.activationLogBayesFactor,
    csvValue(branch.activationBayesFactor), branch.activationPosteriorMean, branch.expectedPositiveSites,
    branch.anySitePositivePosterior, branch.anySitePositiveLogBayesFactor, branch.maximumSitePosterior,
  ].join(","));
  return `${header.join(",")}\n${rows.join("\n")}\n`;
}

export async function analyzeGlobalGamma(
  fasta: string | ReturnType<typeof parseFasta>,
  newick: string | ParsedTree,
  options: GlobalGammaAnalysisOptions = {},
): Promise<GlobalGammaAnalysisResult> {
  const started = performance.now();
  const alignment = typeof fasta === "string" ? parseFasta(fasta) : fasta;
  const tree = typeof newick === "string" ? parseNewick(newick) : cloneSingleClassTree(newick);
  const geneticCode = getGeneticCode(options.geneticCode ?? 1);
  options.signal?.throwIfAborted();
  const compiledMessages = compileMessageTree(tree);
  if (compiledMessages.edgeNodes.length === 0) throw new DifFUBARError("NO_BRANCHES", "Glamma requires at least one phylogenetic branch.");

  const omegaSliceCount = Math.max(4, Math.min(24, Math.round(options.omegaSlices ?? 8)));
  const alphaSliceCount = Math.max(3, Math.min(12, Math.round(options.alphaSlices ?? 4)));
  const fitPreset = options.fitPreset ?? "fast";
  const priorAlpha = options.activationPriorAlpha ?? 1;
  const priorBeta = options.activationPriorBeta ?? 9;
  if (!(priorAlpha > 0) || !(priorBeta > 0) || !Number.isFinite(priorAlpha) || !Number.isFinite(priorBeta)) {
    throw new RangeError("Activation-prior parameters must be finite and positive.");
  }
  stage(options, "initialization", 1, {
    message: `${alignment.names.length.toLocaleString()} taxa · ${alignment.codonSites.toLocaleString()} codons · ${compiledMessages.edgeNodes.length.toLocaleString()} branches`,
  });

  const coarse = coarseCandidates(fitPreset);
  const backend = chooseBackend(options.backend);
  const fitBackend = new WasmBackend();
  const runtimeStarted = performance.now();
  stage(options, "runtime-initialization", 0, {
    message: backend instanceof ParallelWasmBackend
      ? `Compiling SIMD WASM and starting up to ${backend.workerCount.toLocaleString()} Glamma workers`
      : "Compiling the f64 Glamma WASM runtime",
    indeterminate: true,
  });
  await Promise.all([
    backend.prepare({ categoryCount: coarse.length * alphaSliceCount, siteCount: alignment.codonSites }),
    fitBackend.prepare({ categoryCount: 8, siteCount: alignment.codonSites }),
  ]);
  const runtimeMs = performance.now() - runtimeStarted;
  stage(options, "runtime-initialization", 1, { message: "Glamma runtime ready" });

  const globalFitStarted = performance.now();
  let fittedModel: FittedModel;
  if (options.fittedModel !== undefined) {
    validateFittedModel(options.fittedModel, geneticCode.id, geneticCode.senseCodons.length);
    fittedModel = options.fittedModel;
    stage(options, "global-fit", 1, { message: "Using the supplied global codon fit" });
  } else {
    fittedModel = await fitGlobalModel(
      alignment,
      tree,
      compileTree(tree),
      fitBackend,
      options.fitMode ?? "empirical-fast",
      (fraction, detail) => stage(options, "global-fit", fraction, detail),
      options.signal,
      geneticCode,
    );
  }
  const globalFitMs = performance.now() - globalFitStarted;
  for (const node of tree.nodes) node.branchLength *= fittedModel.globalAlpha;
  const tipStates = encodeCodonTips(alignment, tree, geneticCode);

  const gammaFitStarted = performance.now();
  stage(options, "glamma-fit", 0, {
    message: `Coarse global ML scan: ${coarse.length.toLocaleString()} candidate (mean ω, shape ω, shape α) triples`,
    current: 0,
    total: coarse.length,
    indeterminate: true,
  });
  let fitted = await evaluateCandidates(
    coarse, omegaSliceCount, alphaSliceCount, tree, fittedModel, tipStates, alignment.codonSites, backend,
    (fraction, detail) => stage(options, "glamma-fit", fraction * 0.72, {
      ...detail,
      message: detail?.message ?? "Evaluating coarse Glamma likelihoods",
    }),
    options.signal,
  );
  let refinementCount = 0;
  const refinementRounds = 2;
  for (let round = 0; round < refinementRounds; round += 1) {
    const radius = fitPreset === "thorough"
      ? (round === 0 ? 0.42 : 0.18)
      : (round === 0 ? 0.78 : 0.30);
    const candidates = refinementCandidates(fitted.candidate, radius);
    refinementCount += candidates.length;
    const base = 0.72 + round * (0.28 / refinementRounds);
    const span = 0.28 / refinementRounds;
    const next = await evaluateCandidates(
      candidates, omegaSliceCount, alphaSliceCount, tree, fittedModel, tipStates, alignment.codonSites, backend,
      (fraction, detail) => stage(options, "glamma-fit", base + fraction * span, {
        ...detail,
        message: `Refinement ${round + 1}/${refinementRounds} · ${detail?.message ?? "local Gamma likelihoods"}`,
      }),
      options.signal,
    );
    if (next.logLikelihood >= fitted.logLikelihood) fitted = next;
  }
  const fit: GlobalGammaFit = { ...fitted.candidate, logLikelihood: fitted.logLikelihood };
  const gammaFitMs = performance.now() - gammaFitStarted;
  stage(options, "glamma-fit", 1, {
    message: `Global ML fit: mean omega ${fit.omegaMean.toPrecision(4)} · omega shape ${fit.omegaShape.toPrecision(4)} · alpha shape ${fit.alphaShape.toPrecision(4)}`,
    current: coarse.length + refinementCount,
    total: coarse.length + refinementCount,
  });

  const omegaQuadrature = thresholdGammaSlices(fit.omegaMean, fit.omegaShape, omegaSliceCount);
  const omegaValues = omegaQuadrature.values;
  const alphaValues = gammaMeanSlices(1, fit.alphaShape, alphaSliceCount);
  const omegaWeights = omegaQuadrature.weights;
  const alphaWeights = new Float64Array(alphaSliceCount).fill(1 / alphaSliceCount);
  const positiveMask = omegaQuadrature.positiveMask;
  let positivePrior = 0;
  for (let omega = 0; omega < omegaSliceCount; omega += 1) if (positiveMask[omega] !== 0) positivePrior += omegaWeights[omega]!;
  const models = buildModelBank(atomicGrid(omegaValues), tree, fittedModel.gtrRates, fittedModel.f3x4, geneticCode);
  const omegaModels = models.gridModels.slice(0, omegaSliceCount);
  const neutralModel = models.gridModels[omegaSliceCount]!;
  const branchLengths = Float64Array.from(compiledMessages.edgeNodes, (node) => node.branchLength);

  const messagesStarted = performance.now();
  const messages = await backend.evaluateGlobalGammaMessages({
    tree: compiledMessages.kernel,
    tipStates,
    siteCount: alignment.codonSites,
    branchLengths,
    omegaModels,
    omegaWeights,
    positiveMask,
    neutralModel,
    alphaValues,
    alphaWeights,
    models,
    equilibrium: fittedModel.codonEquilibrium,
    onProgress: (fraction, detail) => stage(options, "glamma-messages", fraction, detail),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const messagesMs = performance.now() - messagesStarted;

  const cappedStarted = performance.now();
  const outerGrid = finalOuterGrid(alphaValues);
  const cappedLikelihood = await backend.evaluateBranchMixture({
    tree: compileTree(tree),
    tipStates,
    siteCount: alignment.codonSites,
    grid: outerGrid,
    models,
    operators: finalOperators(alphaValues, omegaModels, omegaWeights, positiveMask, neutralModel, true),
    equilibrium: fittedModel.codonEquilibrium,
    onProgress: (fraction, detail) => stage(options, "glamma-capped-sites", fraction, detail),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const cappedSiteLogLikelihoods = collapseAlpha(cappedLikelihood.logLikelihoods, alphaSliceCount, alignment.codonSites);
  const cappedMs = performance.now() - cappedStarted;

  const tabulationStarted = performance.now();
  stage(options, "glamma-tabulation", 0, { message: "Integrating activation evidence and branch/site posterior responsibilities", indeterminate: true });
  const matrixSize = compiledMessages.edgeNodes.length * alignment.codonSites;
  const tailPosterior = new Float32Array(matrixSize);
  const localLogEvidence = new Float32Array(matrixSize);
  for (let edge = 0; edge < compiledMessages.edgeNodes.length; edge += 1) {
    for (let site = 0; site < alignment.codonSites; site += 1) {
      const index = edge * alignment.codonSites + site;
      const logQ = messages.positiveEdgeLogLikelihoods[index]! - messages.siteLogLikelihoods[site]!;
      tailPosterior[index] = Math.max(0, Math.min(1, Math.exp(Math.min(0, logQ))));
      localLogEvidence[index] = messages.siteLogLikelihoods[site]! - messages.cappedEdgeLogLikelihoods[index]!;
    }
  }

  const sites: GlobalGammaSiteResult[] = [];
  for (let site = 0; site < alignment.codonSites; site += 1) {
    const cappedLogEvidence = messages.siteLogLikelihoods[site]! - cappedSiteLogLikelihoods[site]!;
    let expectedPositiveBranches = 0;
    let maximumBranchPosterior = 0;
    for (let edge = 0; edge < compiledMessages.edgeNodes.length; edge += 1) {
      const matrixIndex = edge * alignment.codonSites + site;
      const logQ = messages.positiveEdgeLogLikelihoods[matrixIndex]! - messages.siteLogLikelihoods[site]!;
      const q = Math.max(0, Math.min(1 - 1e-15, Math.exp(Math.min(0, logQ))));
      expectedPositiveBranches += q;
      maximumBranchPosterior = Math.max(maximumBranchPosterior, q);
    }
    sites.push({
      site: site + 1,
      cappedLogEvidence,
      cappedEvidenceRatio: ratioFromLog(cappedLogEvidence),
      conditionalSupport: probabilityFromLogEvidence(cappedLogEvidence),
      expectedPositiveBranches,
      maximumBranchPosterior,
    });
  }

  const branches: GlobalGammaBranchResult[] = compiledMessages.edgeNodes.map((node, edge) => {
    const logRatios = new Float64Array(alignment.codonSites);
    for (let site = 0; site < alignment.codonSites; site += 1) {
      const index = edge * alignment.codonSites + site;
      logRatios[site] = messages.siteLogLikelihoods[site]! - messages.cappedEdgeLogLikelihoods[index]!;
    }
    const activation = activationStatistics(logRatios, priorAlpha, priorBeta);
    let cappedLogEvidence = 0;
    let expectedPositiveSites = 0;
    let maximumSitePosterior = 0;
    let logNoPositiveSite = 0;
    for (let site = 0; site < alignment.codonSites; site += 1) {
      cappedLogEvidence += logRatios[site]!;
      const index = edge * alignment.codonSites + site;
      const logQ = messages.positiveEdgeLogLikelihoods[index]! - messages.siteLogLikelihoods[site]!;
      const q = Math.max(0, Math.min(1 - 1e-15, Math.exp(Math.min(0, logQ))));
      expectedPositiveSites += q;
      maximumSitePosterior = Math.max(maximumSitePosterior, q);
      logNoPositiveSite += Math.log1p(-q);
    }
    const priorLogNoPositiveSite = alignment.codonSites * Math.log1p(-Math.min(1 - 1e-15, positivePrior));
    const anySitePositiveLogBayesFactor = logOddsDifference(
      eventLogOddsFromLogNoEvent(logNoPositiveSite),
      eventLogOddsFromLogNoEvent(priorLogNoPositiveSite),
    );
    const fallbackName = node.children.length === 0 ? `Tip ${node.tipIndex + 1}` : `Internal branch ${node.id}`;
    return {
      branch: edge + 1,
      nodeId: node.id,
      nodeIndex: compiledMessages.kernel.nodeForEdge[edge]!,
      name: node.name.length > 0 ? node.name : fallbackName,
      parentName: node.parent?.name || "Root",
      terminal: node.children.length === 0,
      branchLength: node.branchLength,
      cappedLogEvidence,
      cappedEvidenceRatio: ratioFromLog(cappedLogEvidence),
      activationLogBayesFactor: activation.logBayesFactor,
      activationBayesFactor: ratioFromLog(activation.logBayesFactor),
      activationPosteriorMean: activation.posteriorMean,
      expectedPositiveSites,
      anySitePositivePosterior: -Math.expm1(logNoPositiveSite),
      anySitePositiveLogBayesFactor,
      maximumSitePosterior,
    };
  });
  const tabulationMs = performance.now() - tabulationStarted;
  stage(options, "glamma-tabulation", 1, {
    message: `${branches.length.toLocaleString()} branches × ${sites.length.toLocaleString()} codons tabulated`,
    current: matrixSize,
    total: matrixSize,
  });
  stage(options, "complete", 1, { message: `Glamma finished with ${messages.backend}` });
  return {
    method: "glamma",
    sites,
    branches,
    fittedModel,
    fit,
    omegaValues,
    alphaValues,
    positivePrior,
    posterior: { siteCount: alignment.codonSites, branchCount: branches.length, tailPosterior, localLogEvidence },
    backend: messages.backend,
    timings: {
      runtimeMs,
      globalFitMs,
      gammaFitMs,
      messagesMs,
      cappedMs,
      tabulationMs,
      totalMs: performance.now() - started,
    },
    diagnostics: {
      geneticCodeId: geneticCode.id,
      geneticCodeName: geneticCode.name,
      codonStates: geneticCode.senseCodons.length,
      taxa: alignment.names.length,
      codonSites: alignment.codonSites,
      branches: branches.length,
      omegaSlices: omegaSliceCount,
      alphaSlices: alphaSliceCount,
      fitPreset,
      coarseCandidates: coarse.length,
      refinementCandidates: refinementCount,
      activationPriorAlpha: priorAlpha,
      activationPriorBeta: priorBeta,
      messageAlgorithm: "upward-downward-local-blanket",
      alphaModel: "mean-one-global-discrete-gamma",
      omegaModel: "global-discrete-gamma-iid-branch-site",
      evidenceCalibration: "plug-in-conditional-empirical-bayes",
      fitNumerics: "coarse-to-fine-grid-ml-julia-interpolation",
      finalNumerics: "direct-f64-uniformization",
    },
  };
}

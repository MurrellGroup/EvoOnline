export type BackendKind = "auto" | "webgpu" | "wasm" | "wasm-parallel";

export interface FastaAlignment {
  readonly names: readonly string[];
  readonly sequences: readonly string[];
  readonly nucleotideSites: number;
  readonly codonSites: number;
}

export interface TreeNode {
  id: number;
  name: string;
  branchLength: number;
  branchClass: number;
  parent: TreeNode | null;
  children: TreeNode[];
  tipIndex: number;
}

export interface ParsedTree {
  readonly root: TreeNode;
  readonly nodes: readonly TreeNode[];
  readonly tips: readonly TreeNode[];
  readonly classCount: number;
  readonly hasBackground: boolean;
  readonly tags: readonly string[];
}

export const enum PruningOpCode {
  LoadTip = 0,
  Transform = 1,
  MultiplyNormalize = 2,
  LoadCache = 3,
}

/** Four u32 words per operation: opcode, slot A, slot B/class, payload. */
export interface CompiledTree {
  readonly ops: Uint32Array;
  readonly edgeLengths: Float64Array;
  readonly rootSlot: number;
  readonly slotCount: number;
  readonly tipCount: number;
  readonly classCount: number;
  readonly registerNumber: number;
  /** CPU-only dependency-aware program. GPU keeps the flat program above. */
  readonly cachedMainOps?: Uint32Array;
  /** Concatenated independent programs, one for each pure edge-subtree. */
  readonly cacheOps?: Uint32Array;
  /** Four words/cache: op word offset, op count, root slot, dependency mask. */
  readonly cacheDescriptors?: Uint32Array;
  readonly cachedEdgeLengths?: Float64Array;
  readonly cachedRootSlot?: number;
  readonly cachedSlotCount?: number;
}

export interface DifFUBARGrid {
  readonly alpha: Float64Array;
  readonly omega: Float64Array;
  readonly backgroundOmega: Float64Array;
  /** category-major [alpha, omega1, omega2, optional background omega] */
  readonly categories: Float64Array;
  readonly categoryCount: number;
  readonly parameterCount: number;
  readonly hasBackground: boolean;
}

/** Sparse uniformized transition operators for every unique (alpha, omega). */
export interface ModelBank {
  readonly stateCount: number;
  readonly maxNeighbors: number;
  readonly modelCount: number;
  readonly neighborCount: Uint32Array;
  readonly neighborIndex: Uint32Array;
  readonly rDiagonal: Float64Array;
  readonly rOffDiagonal: Float64Array;
  readonly mu: Float64Array;
  readonly modelAlpha: Float64Array;
  readonly modelOmega: Float64Array;
  /** category-major model id for each branch class. */
  readonly gridModels: Uint32Array;
}

export interface FittedModel {
  /** Six symmetric GTR exchangeabilities: AC, AG, AT, CG, CT, GT. */
  readonly gtrRates: Float64Array;
  /** Three rows by A,C,G,T, row-major. */
  readonly f3x4: Float64Array;
  /** Equilibrium frequencies in the universal-code sense-codon order. */
  readonly codonEquilibrium: Float64Array;
  readonly globalAlpha: number;
  readonly globalBeta: number;
  readonly logLikelihood: number;
  readonly fitKind: "reference-compatible" | "empirical-fast" | "provided";
}

/** Optional live telemetry attached to a stage-progress update. */
export interface ProgressDetail {
  /** Human-readable description of the work currently executing. */
  readonly message?: string;
  /** Completed units when the backend can expose a real counter. */
  readonly current?: number;
  /** Total units corresponding to `current`. */
  readonly total?: number;
  /** Label for an optimizer metric, for example "log L". */
  readonly metricLabel?: string;
  /** Current value of the optimizer metric. */
  readonly metricValue?: number;
  /** True when work is active but the fused kernel cannot report partial completion. */
  readonly indeterminate?: boolean;
}

/** Workload hint used to initialize the backend that will actually run it. */
export interface RuntimeWorkload {
  readonly categoryCount: number;
  readonly siteCount: number;
}

export interface LikelihoodRequest {
  readonly tree: CompiledTree;
  readonly tipStates: Uint8Array;
  readonly siteCount: number;
  readonly grid: DifFUBARGrid;
  readonly models: ModelBank;
  readonly equilibrium: Float64Array;
  /** Positive forces a fixed truncation; omitted selects adaptive Poisson-tail truncation. */
  readonly poissonTerms?: number;
  /** Uniformization chunk size; the adaptive WASM default is 64. */
  readonly maxLambdaPerStep?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (fraction: number, detail?: ProgressDetail) => void;
}

export interface LikelihoodResult {
  /** category-major log conditional likelihoods. */
  readonly logLikelihoods: Float64Array;
  readonly backend: "webgpu" | "wasm" | "wasm-parallel";
  readonly elapsedMs: number;
  readonly precision: "f32" | "f64";
}

/** How several branch-mixture operators are collapsed into one reported grid category. */
export type BranchMixtureCollapseMode = "log-mean-likelihood" | "mean-log-likelihood";

/**
 * Sparse description of dense branch transition mixtures.  An operator is a
 * convex combination of atomic MG94 transition matrices.  All components in
 * one operator share `operatorScales[operator]`, which multiplies the input
 * branch length and therefore supplies the common synonymous-rate scale.
 */
export interface BranchMixtureOperators {
  readonly operatorCount: number;
  /** CSR offsets into componentModels/componentWeights; length operatorCount + 1. */
  readonly operatorOffsets: Uint32Array;
  readonly componentModels: Uint32Array;
  readonly componentWeights: Float64Array;
  readonly operatorScales: Float64Array;
  /** Consecutive operators collapsed into each category in request.grid. */
  readonly operatorsPerCategory: number;
  /** Normalized quadrature/evidence weight for every operator. */
  readonly collapseWeights: Float64Array;
  readonly collapseMode: BranchMixtureCollapseMode;
}

/** Likelihood request for FAME/FLAVOR-style mixtures on every tree branch. */
export interface BranchMixtureLikelihoodRequest {
  readonly tree: CompiledTree;
  readonly tipStates: Uint8Array;
  readonly siteCount: number;
  /** The reported/inferred categories, after any operator quadrature collapse. */
  readonly grid: DifFUBARGrid;
  readonly models: ModelBank;
  readonly operators: BranchMixtureOperators;
  readonly equilibrium: Float64Array;
  readonly poissonTerms?: number;
  readonly maxLambdaPerStep?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (fraction: number, detail?: ProgressDetail) => void;
}

/**
 * FLAVOR's source-compatible transition interpolation. Every consecutive
 * `alphaCount` categories must share one component mixture and differ only in
 * operator scale; this is the ordering emitted by the FLAVOR grid builder.
 */
export interface FlavorInterpolatedLikelihoodRequest extends BranchMixtureLikelihoodRequest {
  readonly alphaCount: number;
  /** MolecularEvolution.jl defaults: 0.001, 50, and 35. */
  readonly interpolation?: {
    readonly timeStep?: number;
    readonly tablePoints?: number;
    readonly tableCap?: number;
  };
}

/**
 * Flat rooted-tree topology used by the BS-REL all-to-all message kernel.
 * Every non-root node owns exactly one edge (`edgeForNode`); children are
 * stored in CSR form so the WASM pass also handles genuine polytomies.
 */
export interface BsrelKernelTree {
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
}

/**
 * One full fixed-complexity BS-REL likelihood plus any number of exact local
 * edge substitutions. Local candidates are evaluated against two-sided
 * messages that exclude the candidate edge, so they do not re-prune the tree.
 */
export interface BsrelKernelRequest {
  readonly tree: BsrelKernelTree;
  readonly tipStates: Uint8Array;
  readonly siteCount: number;
  readonly branchLengths: Float64Array;
  /** Three model ids per edge: purifying, near-neutral, positive. */
  readonly branchModels: Uint32Array;
  /** Three normalized mixture weights per edge. */
  readonly branchWeights: Float64Array;
  readonly candidateBranches: Uint32Array;
  readonly candidateLengths: Float64Array;
  readonly candidateModels: Uint32Array;
  readonly candidateWeights: Float64Array;
  readonly models: ModelBank;
  readonly equilibrium: Float64Array;
  readonly poissonTerms?: number;
  readonly maxLambdaPerStep?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (fraction: number, detail?: ProgressDetail) => void;
}

export interface BsrelKernelResult {
  /** Baseline total log L followed by one total log L per local candidate. */
  readonly objectives: Float64Array;
  readonly backend: "wasm" | "wasm-parallel";
  readonly elapsedMs: number;
  readonly precision: "f64";
}

/**
 * Global branch/site random-effects kernel. Alpha is a site-level outer
 * mixture, while omega is integrated independently on every branch. The
 * kernel returns exact single-edge capped replacements from two-sided
 * messages, plus the unnormalised positive-tail contribution on every edge.
 */
export interface GlobalGammaMessageRequest {
  readonly tree: BsrelKernelTree;
  readonly tipStates: Uint8Array;
  readonly siteCount: number;
  readonly branchLengths: Float64Array;
  /** Atomic omega model ids shared by every branch. */
  readonly omegaModels: Uint32Array;
  readonly omegaWeights: Float64Array;
  /** One for omega categories strictly greater than one. */
  readonly positiveMask: Uint8Array;
  /** Atomic model id for omega=1, used by the capped edge operator. */
  readonly neutralModel: number;
  /** Mean-one site-rate Gamma quadrature. */
  readonly alphaValues: Float64Array;
  readonly alphaWeights: Float64Array;
  readonly models: ModelBank;
  readonly equilibrium: Float64Array;
  readonly poissonTerms?: number;
  readonly maxLambdaPerStep?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (fraction: number, detail?: ProgressDetail) => void;
}

export interface GlobalGammaMessageResult {
  /** Alpha-marginal alternative log likelihood, one value per site. */
  readonly siteLogLikelihoods: Float64Array;
  /** Exact alpha-marginal likelihood with just this edge capped; edge-major. */
  readonly cappedEdgeLogLikelihoods: Float64Array;
  /** Unnormalised likelihood mass from omega>1 on this edge; edge-major. */
  readonly positiveEdgeLogLikelihoods: Float64Array;
  readonly backend: "wasm" | "wasm-parallel";
  readonly elapsedMs: number;
  readonly precision: "f64";
}

/**
 * Additive kernel used by the optional CladeShift model.  Each retained
 * component is a compressed FUBAR null-posterior category for one site.
 * `shiftedModels` contains the corresponding omega^K model for every fixed
 * intensity value.  The kernel scores a persistent regime change on every
 * candidate edge: that edge and every edge below it use the shifted model,
 * while the rest of the tree retains the baseline model.
 */
export interface CladeShiftKernelRequest {
  readonly tree: BsrelKernelTree;
  readonly tipStates: Uint8Array;
  readonly siteCount: number;
  readonly branchLengths: Float64Array;
  /** Site-major retained null-posterior model ids: [site, component]. */
  readonly baselineModels: Uint32Array;
  /** Site-major shifted model ids: [site, component, intensity]. */
  readonly shiftedModels: Uint32Array;
  /** Renormalized null-posterior weights: [site, component]. */
  readonly posteriorWeights: Float64Array;
  readonly componentCount: number;
  readonly intensityCount: number;
  /** Edge ids that may initiate a persistent descendant-clade shift. */
  readonly candidateBranches: Uint32Array;
  readonly models: ModelBank;
  readonly equilibrium: Float64Array;
  readonly poissonTerms?: number;
  readonly maxLambdaPerStep?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (fraction: number, detail?: ProgressDetail) => void;
}

export interface CladeShiftKernelResult {
  /**
   * log BF for each fixed intensity and candidate clade, already integrated
   * over the compressed null posterior. Layout: [site, intensity, candidate].
   */
  readonly logLikelihoodRatios: Float64Array;
  readonly backend: "wasm" | "wasm-parallel";
  readonly elapsedMs: number;
  readonly precision: "f64";
}

export interface SamplerOptions {
  readonly iterations?: number;
  readonly burnin?: number;
  readonly concentration?: number;
  readonly seed?: number;
  /** Fast-exact uses an equivalent rejection draw; reference preserves the Julia-style dense transition; collapsed integrates theta out. */
  readonly samplerMode?: "fast-exact" | "reference" | "collapsed";
  /** Zero is exact dense sampling; positive values prune site likelihood ratios below the cutoff. */
  readonly likelihoodCutoff?: number;
  readonly trackAllocations?: boolean;
  readonly onProgress?: (fraction: number, detail?: ProgressDetail) => void;
  readonly signal?: AbortSignal;
}

export interface MixtureFitOptions {
  readonly iterations?: number;
  readonly concentration?: number;
  readonly tolerance?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (fraction: number, detail?: ProgressDetail) => void;
}

export interface MixtureFitResult {
  readonly theta: Float64Array;
  readonly completedIterations: number;
  readonly logLikelihood: number;
  readonly elapsedMs: number;
}

export interface AlphaBetaSamplerOptions {
  readonly iterations?: number;
  readonly burnin?: number;
  readonly concentration?: number;
  readonly seed?: number;
  readonly trackAllocations?: boolean;
  readonly signal?: AbortSignal;
  readonly onProgress?: (fraction: number, detail?: ProgressDetail) => void;
}

export interface AlphaBetaSamplerResult {
  readonly theta: Float64Array;
  readonly positive: Float64Array;
  readonly purifying: Float64Array;
  readonly meanAlpha: Float64Array;
  readonly meanBeta: Float64Array;
  readonly retainedIterations: number;
  readonly allocations?: Uint32Array;
  readonly elapsedMs: number;
}

export interface SiteResult {
  readonly site: number;
  readonly pOmega1Greater: number;
  readonly pOmega2Greater: number;
  readonly pOmega1Positive: number;
  readonly pOmega2Positive: number;
  readonly meanAlpha: number;
  readonly meanOmega1: number;
  readonly meanOmega2: number;
}

export interface SamplerResult {
  readonly sites: readonly SiteResult[];
  readonly theta: Float64Array;
  readonly retainedIterations: number;
  readonly allocations?: Uint32Array;
  readonly elapsedMs: number;
}

/**
 * Site-major marginal posterior masses on the original fixed DifFUBAR grid.
 * The three probability arrays are compact visualization products; the much
 * larger category-by-site allocation table is discarded after collapsing.
 */
export interface PosteriorMarginals {
  readonly siteCount: number;
  readonly alphaValues: Float64Array;
  readonly omegaValues: Float64Array;
  readonly alpha: Float32Array;
  readonly omega1: Float32Array;
  readonly omega2: Float32Array;
}

export interface AnalysisOptions extends SamplerOptions {
  readonly backend?: BackendKind;
  readonly foregroundGrid?: number;
  readonly backgroundGrid?: number;
  readonly posteriorThreshold?: number;
  readonly fitMode?: "empirical-fast" | "reference-compatible";
  readonly fittedModel?: FittedModel;
  readonly tags?: readonly string[];
  /** Retain compact per-site alpha/omega marginals for result visualizations. */
  readonly collectPosteriorMarginals?: boolean;
  readonly onStage?: (stage: string, fraction: number, detail?: ProgressDetail) => void;
}

export interface AnalysisResult {
  readonly sites: readonly SiteResult[];
  readonly detectedSites: readonly number[];
  readonly fittedModel: FittedModel;
  readonly grid: DifFUBARGrid;
  readonly posteriorMarginals?: PosteriorMarginals;
  readonly backend: "webgpu" | "wasm" | "wasm-parallel";
  readonly timings: Readonly<Record<string, number>>;
  readonly diagnostics: {
    readonly taxa: number;
    readonly codonSites: number;
    readonly categories: number;
    readonly treeRegisterNumber: number;
    readonly precision: "f32" | "f64";
  };
}

export class DifFUBARError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DifFUBARError";
    this.code = code;
  }
}

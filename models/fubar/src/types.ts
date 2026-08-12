import type {
  BackendKind,
  DifFUBARGrid,
  FastaAlignment,
  FittedModel,
  GeneticCodeId,
  ParsedTree,
  ProgressDetail,
} from "@phylo-workbench/model-diffubar";

export interface FubarGrid extends DifFUBARGrid {
  readonly values: Float64Array;
  readonly beta: Float64Array;
  readonly alphaIndex: Uint16Array;
  readonly betaIndex: Uint16Array;
}

export type FubarSelection = "positive" | "purifying" | "none";
export type FubarInferenceMethod = "dirichlet-em" | "gibbs";
export type ApproximateFelDirection = "positive" | "purifying" | "none";

export interface FubarSiteResult {
  readonly site: number;
  readonly pPositive: number;
  readonly pPurifying: number;
  readonly meanAlpha: number;
  readonly meanBeta: number;
  readonly selection: FubarSelection;
}

/** Compact, site-major posterior products retained for native SVG figures. */
export interface FubarPosteriorProducts {
  readonly siteCount: number;
  readonly gridSize: number;
  readonly gridValues: Float64Array;
  /** [site, alpha, beta]. */
  readonly surfaces: Float32Array;
  /** [site, alpha]. */
  readonly alpha: Float32Array;
  /** [site, beta]. */
  readonly beta: Float32Array;
}

export interface ApproximateFelSiteResult {
  readonly site: number;
  /** Standard two-sided chi-square(1) LRT p-value. */
  readonly pValue: number;
  /** One-sided signed-root LRT p-value for beta > alpha. */
  readonly pPositive: number;
  /** One-sided signed-root LRT p-value for alpha > beta. */
  readonly pPurifying: number;
  readonly likelihoodRatio: number;
  readonly gridLogLikelihoodMaximum: number;
  readonly logLikelihoodAlternative: number;
  readonly logLikelihoodNull: number;
  readonly alphaAlternative: number;
  readonly betaAlternative: number;
  readonly alphaBetaNull: number;
  /** Zero-based continuous coordinates on the uniform FUBAR grid. */
  readonly alphaCoordinate: number;
  readonly betaCoordinate: number;
  readonly nullCoordinate: number;
  readonly direction: ApproximateFelDirection;
  /** One is the full cubic surface; lower values indicate artifact guarding. */
  readonly splineTension: number;
}

/** Optional frequentist products kept separate from the FUBAR posterior. */
export interface ApproximateFelProducts {
  readonly siteCount: number;
  readonly gridSize: number;
  readonly gridValues: Float64Array;
  /** Site-major max-shifted raw conditional log likelihoods: [site, alpha, beta]. */
  readonly relativeLogLikelihoods: Float32Array;
  readonly sites: readonly ApproximateFelSiteResult[];
  readonly diagnostics: {
    readonly interpolation: "exact-tensioned-bicubic-log-likelihood";
    readonly coordinateSystem: "uniform-fubar-grid-index";
    readonly maximumNodeError: number;
    readonly minimumSplineTension: number;
    readonly guardedSites: number;
  };
}

export interface FubarAnalysisOptions {
  readonly geneticCode?: GeneticCodeId;
  readonly backend?: BackendKind;
  readonly gridPoints?: number;
  readonly inferenceMethod?: FubarInferenceMethod;
  readonly iterations?: number;
  readonly burnin?: number;
  readonly concentration?: number;
  readonly tolerance?: number;
  readonly seed?: number;
  readonly posteriorThreshold?: number;
  readonly fitMode?: "empirical-fast" | "reference-compatible";
  readonly fittedModel?: FittedModel;
  /** Reuse the raw FUBAR likelihood grid for a separate approximate FEL LRT. */
  readonly approximateFel?: boolean;
  readonly signal?: AbortSignal;
  readonly onStage?: (stage: string, fraction: number, detail?: ProgressDetail) => void;
}

export interface FubarAnalysisResult {
  readonly sites: readonly FubarSiteResult[];
  readonly positiveSites: readonly number[];
  readonly purifyingSites: readonly number[];
  readonly fittedModel: FittedModel;
  readonly grid: FubarGrid;
  readonly posterior: FubarPosteriorProducts;
  readonly approximateFel?: ApproximateFelProducts;
  readonly theta: Float64Array;
  readonly backend: "webgpu" | "wasm" | "wasm-parallel";
  readonly timings: Readonly<Record<string, number>>;
  readonly diagnostics: {
    readonly geneticCodeId: GeneticCodeId;
    readonly geneticCodeName: string;
    readonly codonStates: number;
    readonly taxa: number;
    readonly codonSites: number;
    readonly categories: number;
    readonly treeRegisterNumber: number;
    readonly precision: "f32" | "f64";
    readonly inferenceMethod: FubarInferenceMethod;
    readonly inferenceIterations: number;
    readonly inferenceBurnin: number;
    readonly inferenceLogLikelihood: number | null;
  };
}

export type FubarInput = string | FastaAlignment;
export type FubarTreeInput = string | ParsedTree;

import type {
  BackendKind,
  DifFUBARGrid,
  FastaAlignment,
  FittedModel,
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

export interface FubarAnalysisOptions {
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
  readonly theta: Float64Array;
  readonly backend: "webgpu" | "wasm" | "wasm-parallel";
  readonly timings: Readonly<Record<string, number>>;
  readonly diagnostics: {
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

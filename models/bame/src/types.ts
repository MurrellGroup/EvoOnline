import type {
  BackendKind,
  BranchMixtureOperators,
  DifFUBARGrid,
  FastaAlignment,
  FittedModel,
  ModelBank,
  ParsedTree,
  ProgressDetail,
} from "@phylo-workbench/model-diffubar";

export const MIXTURE_MODELS_COMMIT = "4c65c984b2e7ad121f5e28298de69bdc0dd427b7";

export type BameInferenceMethod = "dirichlet-em" | "gibbs";
export type BameBackendKind = Extract<BackendKind, "auto" | "wasm" | "wasm-parallel">;
export type FameWeightIntegration = "likelihood-quadrature" | "julia-draft-log-average";
export type BameGridPreset = "fast" | "julia-draft";

export interface FameGrid extends DifFUBARGrid {
  readonly alphaValues: Float64Array;
  readonly omega1Values: Float64Array;
  readonly omega2Values: Float64Array;
  readonly alphaIndex: Uint16Array;
  readonly omega1Index: Uint16Array;
  readonly omega2Index: Uint16Array;
}

export interface FlavorGrid extends DifFUBARGrid {
  readonly muValues: Float64Array;
  readonly shapeValues: Float64Array;
  readonly alphaValues: Float64Array;
  readonly muIndex: Uint16Array;
  readonly shapeIndex: Uint16Array;
  readonly alphaIndex: Uint16Array;
  readonly capped: Uint8Array;
  readonly positiveMask: Uint8Array;
  readonly positiveBranchFraction: Float32Array;
}

export interface BuiltBranchMixtureGrid<G extends DifFUBARGrid> {
  readonly grid: G;
  readonly models: ModelBank;
  readonly operators: BranchMixtureOperators;
}

export interface FameSiteResult {
  readonly site: number;
  readonly pPositive: number;
  readonly bayesFactor: number;
  readonly meanAlpha: number;
  readonly meanOmega1: number;
  readonly meanOmega2: number;
  readonly detected: boolean;
}

export interface FlavorSiteResult {
  readonly site: number;
  readonly pPositive: number;
  readonly pUncapped: number;
  readonly bayesFactor: number;
  readonly meanAlpha: number;
  readonly meanOmega: number;
  readonly meanShape: number;
  readonly meanOmegaStandardDeviation: number;
  readonly meanPositiveBranchFraction: number;
  readonly detected: boolean;
}

export interface FamePosteriorProducts {
  readonly siteCount: number;
  readonly alphaValues: Float64Array;
  readonly omega1Values: Float64Array;
  readonly omega2Values: Float64Array;
  /** Site-major [site, alpha, omega1, omega2]. */
  readonly surfaces: Float32Array;
  readonly alpha: Float32Array;
  readonly omega1: Float32Array;
  readonly omega2: Float32Array;
}

export interface FlavorPosteriorProducts {
  readonly siteCount: number;
  readonly muValues: Float64Array;
  readonly shapeValues: Float64Array;
  readonly alphaValues: Float64Array;
  /** Site-major [site, capped, mu, shape, alpha]. */
  readonly surfaces: Float32Array;
  readonly mu: Float32Array;
  readonly shape: Float32Array;
  readonly alpha: Float32Array;
  /** Two entries per site: uncapped then capped. */
  readonly capState: Float32Array;
}

export interface BameAnalysisOptions {
  readonly backend?: BameBackendKind;
  readonly inferenceMethod?: BameInferenceMethod;
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

export interface FameAnalysisOptions extends BameAnalysisOptions {
  readonly weightIntegration?: FameWeightIntegration;
  /** Used by corrected Gauss-Legendre likelihood quadrature. */
  readonly quadraturePoints?: number;
  /** Used only by exact Julia-draft reproduction; the source uses 20. */
  readonly draftWeightPoints?: number;
  readonly gridPreset?: BameGridPreset;
}

export interface FlavorAnalysisOptions extends BameAnalysisOptions {
  readonly gammaSlices?: number;
  readonly gridPreset?: BameGridPreset;
}

export interface BameDiagnostics {
  readonly taxa: number;
  readonly codonSites: number;
  readonly categories: number;
  readonly branchMixtureOperators: number;
  readonly atomicOmegaModels: number;
  readonly treeRegisterNumber: number;
  readonly precision: "f64";
  readonly inferenceMethod: BameInferenceMethod;
  readonly inferenceIterations: number;
  readonly inferenceBurnin: number;
  readonly inferenceLogLikelihood: number | null;
  readonly modelDraftCommit: typeof MIXTURE_MODELS_COMMIT;
  readonly numericalEngine: "fused-sparse-or-dense-uniformization";
}

export interface FameAnalysisResult {
  readonly method: "fame";
  readonly sites: readonly FameSiteResult[];
  readonly detectedSites: readonly number[];
  readonly fittedModel: FittedModel;
  readonly grid: FameGrid;
  readonly posterior: FamePosteriorProducts;
  readonly theta: Float64Array;
  readonly positivePrior: number;
  readonly backend: "wasm" | "wasm-parallel";
  readonly timings: Readonly<Record<string, number>>;
  readonly diagnostics: BameDiagnostics & {
    readonly weightIntegration: FameWeightIntegration;
    readonly weightPoints: number;
    readonly gridPreset: BameGridPreset;
  };
}

export interface FlavorAnalysisResult {
  readonly method: "flavor";
  readonly sites: readonly FlavorSiteResult[];
  readonly detectedSites: readonly number[];
  readonly fittedModel: FittedModel;
  readonly grid: FlavorGrid;
  readonly posterior: FlavorPosteriorProducts;
  readonly theta: Float64Array;
  readonly positivePrior: number;
  readonly backend: "wasm" | "wasm-parallel";
  readonly timings: Readonly<Record<string, number>>;
  readonly diagnostics: BameDiagnostics & {
    readonly gammaSlices: number;
    readonly cappedGridMultiplicityRetained: true;
    readonly gridPreset: BameGridPreset;
  };
}

export type BameInput = string | FastaAlignment;
export type BameTreeInput = string | ParsedTree;

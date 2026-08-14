import type {
  BackendKind,
  BranchMixtureOperators,
  DifFUBARGrid,
  FastaAlignment,
  FittedModel,
  GeneticCodeId,
  ModelBank,
  ParsedTree,
  ProgressDetail,
  RecombinationCodonTreeSet,
} from "@phylo-workbench/model-diffubar";

export const MIXTURE_MODELS_COMMIT = "4c65c984b2e7ad121f5e28298de69bdc0dd427b7";

export type BameInferenceMethod = "dirichlet-em" | "gibbs";
export type BameBackendKind = Extract<BackendKind, "auto" | "wasm" | "wasm-parallel">;
export type FameWeightIntegration = "likelihood-quadrature" | "julia-draft-log-average";
export type BameGridPreset = "fast" | "julia-draft";
export type FlavorTransitionEngine = "julia-interpolated" | "direct-uniformization";
export type GlobalGammaFitPreset = "fast" | "thorough";

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
  readonly geneticCode?: GeneticCodeId;
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
  /** Fixed-relative regional ML trees used as one partitioned likelihood. */
  readonly recombinationTrees?: RecombinationCodonTreeSet;
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
  readonly transitionEngine?: FlavorTransitionEngine;
}

export interface BameDiagnostics {
  readonly geneticCodeId: GeneticCodeId;
  readonly geneticCodeName: string;
  readonly codonStates: number;
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
  readonly numericalEngine: "fused-sparse-or-dense-uniformization" | "julia-matrix-sequence-linear-interpolation";
  readonly regionalTrees: number;
  readonly branchScalePolicy: "single-tree" | "fixed-relative";
  readonly branchLengthSource: "input-tree" | "jemspr-linked-ml" | "segment-ml" | "method-final-trees";
  readonly codonAssignment: "single-tree" | "middle-nucleotide";
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
    readonly transitionEngine: FlavorTransitionEngine;
    readonly interpolationTimeStep: 0.001;
    readonly interpolationTablePoints: 50;
    readonly interpolationTableCap: 35;
    readonly cappedGridMultiplicityRetained: true;
    readonly gridPreset: BameGridPreset;
  };
}

export interface GlobalGammaFit {
  readonly omegaMean: number;
  readonly omegaShape: number;
  /** Shape of the mean-one Gamma distribution over site-wise alpha. */
  readonly alphaShape: number;
  readonly logLikelihood: number;
}

export interface GlobalGammaSiteResult {
  readonly site: number;
  /** log L(global Gamma) - log L(all branches capped at omega<=1). */
  readonly cappedLogEvidence: number;
  readonly cappedEvidenceRatio: number;
  /** Equal-prior transform of the conditional evidence ratio, for plotting only. */
  readonly conditionalSupport: number;
  readonly expectedPositiveBranches: number;
  readonly maximumBranchPosterior: number;
}

export interface GlobalGammaBranchResult {
  readonly branch: number;
  readonly nodeId: number;
  readonly nodeIndex: number;
  readonly name: string;
  readonly parentName: string;
  readonly terminal: boolean;
  readonly branchLength: number;
  /** Sum over sites of exact one-edge capped log likelihood ratios. */
  readonly cappedLogEvidence: number;
  readonly cappedEvidenceRatio: number;
  /** Empirical-Bayes factor from the integrated branch activation model. */
  readonly activationLogBayesFactor: number;
  readonly activationBayesFactor: number;
  readonly activationPosteriorMean: number;
  readonly expectedPositiveSites: number;
  readonly anySitePositivePosterior: number;
  readonly anySitePositiveLogBayesFactor: number;
  readonly maximumSitePosterior: number;
}

export interface GlobalGammaPosteriorProducts {
  readonly siteCount: number;
  readonly branchCount: number;
  /** Edge-major P(omega>1 | data, fitted global parameters). */
  readonly tailPosterior: Float32Array;
  /** Edge-major log L(uncapped edge) - log L(capped edge). */
  readonly localLogEvidence: Float32Array;
}

export interface GlobalGammaAnalysisOptions {
  readonly geneticCode?: GeneticCodeId;
  readonly backend?: BameBackendKind;
  readonly omegaSlices?: number;
  readonly alphaSlices?: number;
  readonly fitPreset?: GlobalGammaFitPreset;
  readonly activationPriorAlpha?: number;
  readonly activationPriorBeta?: number;
  readonly fitMode?: "empirical-fast" | "reference-compatible";
  readonly fittedModel?: FittedModel;
  readonly signal?: AbortSignal;
  readonly onStage?: (stage: string, fraction: number, detail?: ProgressDetail) => void;
}

export interface GlobalGammaAnalysisResult {
  readonly method: "glamma";
  readonly sites: readonly GlobalGammaSiteResult[];
  readonly branches: readonly GlobalGammaBranchResult[];
  readonly fittedModel: FittedModel;
  readonly fit: GlobalGammaFit;
  readonly omegaValues: Float64Array;
  readonly alphaValues: Float64Array;
  readonly positivePrior: number;
  readonly posterior: GlobalGammaPosteriorProducts;
  readonly backend: "wasm" | "wasm-parallel";
  readonly timings: Readonly<Record<string, number>>;
  readonly diagnostics: {
    readonly geneticCodeId: GeneticCodeId;
    readonly geneticCodeName: string;
    readonly codonStates: number;
    readonly taxa: number;
    readonly codonSites: number;
    readonly branches: number;
    readonly omegaSlices: number;
    readonly alphaSlices: number;
    readonly fitPreset: GlobalGammaFitPreset;
    readonly coarseCandidates: number;
    readonly refinementCandidates: number;
    readonly activationPriorAlpha: number;
    readonly activationPriorBeta: number;
    readonly messageAlgorithm: "upward-downward-local-blanket";
    readonly alphaModel: "mean-one-global-discrete-gamma";
    readonly omegaModel: "global-discrete-gamma-iid-branch-site";
    readonly evidenceCalibration: "plug-in-conditional-empirical-bayes";
    readonly fitNumerics: "coarse-to-fine-grid-ml-julia-interpolation";
    readonly finalNumerics: "direct-f64-uniformization";
  };
}

export type BameInput = string | FastaAlignment;
export type BameTreeInput = string | ParsedTree;

import type {
  FastaAlignment,
  FittedModel,
  ParsedTree,
  ProgressDetail,
} from "@phylo-workbench/model-diffubar";

export type CladeShiftBackendKind = "auto" | "wasm" | "wasm-parallel";
export type CladeShiftDirection = "relaxation" | "intensification" | "none";
export type CladeShiftIntensityPreset = "fast" | "thorough";

export interface CladeShiftSiteResult {
  readonly site: number;
  readonly pShift: number;
  readonly pRelaxation: number;
  readonly pIntensification: number;
  readonly logBayesFactor: number;
  readonly relaxationLogBayesFactor: number;
  readonly intensificationLogBayesFactor: number;
  readonly direction: CladeShiftDirection;
  readonly detected: boolean;
  readonly mapBranch: number;
  readonly mapBranchName: string;
  /** Unconditional posterior that this particular branch initiated the shift. */
  readonly mapBranchPosterior: number;
  readonly mapIntensity: number;
  readonly meanIntensityGivenShift: number;
  readonly capturedNullPosteriorMass: number;
  readonly baselineMeanAlpha: number;
  readonly baselineMeanBeta: number;
}

export interface CladeShiftBranchResult {
  readonly branch: number;
  readonly nodeId: number;
  readonly nodeIndex: number;
  readonly name: string;
  readonly parentName: string;
  readonly terminal: boolean;
  readonly descendantTips: number;
  readonly eligible: boolean;
  readonly expectedShiftedSites: number;
  readonly expectedRelaxedSites: number;
  readonly expectedIntensifiedSites: number;
  readonly maximumSitePosterior: number;
  readonly mapSite: number;
}

/** Compact matrices retained for linked site/tree SVGs. All branch matrices are edge-major. */
export interface CladeShiftPosteriorProducts {
  readonly siteCount: number;
  readonly branchCount: number;
  readonly intensities: Float64Array;
  readonly branchPosterior: Float32Array;
  readonly branchRelaxation: Float32Array;
  readonly branchIntensification: Float32Array;
  /** Unconditional posterior mass for each K state: [site, intensity]. */
  readonly intensityPosterior: Float32Array;
}

export interface CladeShiftAnalysisOptions {
  readonly backend?: CladeShiftBackendKind;
  readonly gridPoints?: number;
  /** Hard cap on retained null-posterior categories per codon. */
  readonly posteriorComponents?: number;
  /** Stop retaining categories once this much null-posterior mass is covered. */
  readonly posteriorMassTarget?: number;
  readonly intensityPreset?: CladeShiftIntensityPreset;
  readonly shiftPrior?: number;
  readonly posteriorThreshold?: number;
  readonly minimumDescendantTips?: number;
  readonly inferenceIterations?: number;
  readonly concentration?: number;
  readonly fitMode?: "empirical-fast" | "reference-compatible";
  readonly fittedModel?: FittedModel;
  readonly signal?: AbortSignal;
  readonly onStage?: (stage: string, fraction: number, detail?: ProgressDetail) => void;
}

export interface CladeShiftAnalysisResult {
  readonly method: "clade-shift";
  readonly sites: readonly CladeShiftSiteResult[];
  readonly branches: readonly CladeShiftBranchResult[];
  readonly detectedSites: readonly number[];
  readonly posterior: CladeShiftPosteriorProducts;
  readonly intensities: Float64Array;
  readonly shiftPrior: number;
  readonly fittedModel: FittedModel;
  readonly backend: "wasm" | "wasm-parallel";
  readonly timings: Readonly<Record<string, number>>;
  readonly diagnostics: {
    readonly taxa: number;
    readonly codonSites: number;
    readonly branches: number;
    readonly candidateClades: number;
    readonly gridPoints: number;
    readonly baselineCategories: number;
    readonly posteriorComponents: number;
    readonly meanPosteriorComponents: number;
    readonly posteriorMassTarget: number;
    readonly intensityStates: number;
    readonly intensityPreset: CladeShiftIntensityPreset;
    readonly minimumDescendantTips: number;
    readonly minimumCapturedPosteriorMass: number;
    readonly meanCapturedPosteriorMass: number;
    readonly nullIntegration: "compressed-fubar-posterior-identity";
    readonly cladeAlgorithm: "baseline-outside-plus-shifted-subtree-inside";
    readonly evidenceCalibration: "fixed-prior-empirical-bayes";
    readonly validatedMethod: false;
    readonly precision: "f64";
  };
}

export type CladeShiftInput = string | FastaAlignment;
export type CladeShiftTreeInput = string | ParsedTree;

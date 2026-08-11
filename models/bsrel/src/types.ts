import type {
  FastaAlignment,
  FittedModel,
  ParsedTree,
  ProgressDetail,
} from "@phylo-workbench/model-diffubar";

export type BsrelBackendKind = "auto" | "wasm" | "wasm-parallel";
export type BsrelBranchScope = "all" | "internal" | "terminal";

export interface BsrelBranchResult {
  readonly branch: number;
  readonly nodeId: number;
  readonly nodeIndex: number;
  readonly name: string;
  readonly parentName: string;
  readonly terminal: boolean;
  readonly tested: boolean;
  readonly inputLength: number;
  readonly fittedLength: number;
  readonly omegaMinus: number;
  readonly weightMinus: number;
  readonly omegaNeutral: number;
  readonly weightNeutral: number;
  readonly omegaPositive: number;
  readonly weightPositive: number;
  readonly meanOmega: number;
  readonly nullLogLikelihood: number | null;
  readonly likelihoodRatio: number | null;
  readonly pValue: number | null;
  readonly pValueHolm: number | null;
  readonly significant: boolean;
}

export interface BsrelAnalysisOptions {
  readonly backend?: BsrelBackendKind;
  readonly branchScope?: BsrelBranchScope;
  readonly significanceThreshold?: number;
  readonly alternativeIterations?: number;
  readonly nullIterations?: number;
  readonly maximumOmega?: number;
  readonly tolerance?: number;
  readonly fitMode?: "empirical-fast" | "reference-compatible";
  readonly fittedModel?: FittedModel;
  readonly signal?: AbortSignal;
  readonly onStage?: (stage: string, fraction: number, detail?: ProgressDetail) => void;
}

export interface BsrelAnalysisResult {
  readonly branches: readonly BsrelBranchResult[];
  readonly fittedModel: FittedModel;
  readonly alternativeLogLikelihood: number;
  readonly backend: "wasm" | "wasm-parallel";
  readonly timings: Readonly<Record<string, number>>;
  readonly diagnostics: {
    readonly taxa: number;
    readonly codonSites: number;
    readonly branches: number;
    readonly testedBranches: number;
    readonly significantBranches: number;
    readonly alternativeIterations: number;
    readonly alternativeConverged: boolean;
    readonly nullIterations: number;
    readonly maximumOmega: number;
    readonly lrtCalibration: "0.50*chi2_0 + 0.05*chi2_1 + 0.45*chi2_2";
    readonly multipleTesting: "Holm-Bonferroni";
    readonly messageAlgorithm: "upward-downward-local-blanket";
    readonly precision: "f64";
  };
}

export type BsrelInput = string | FastaAlignment;
export type BsrelTreeInput = string | ParsedTree;

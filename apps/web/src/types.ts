import type { GeneticCodeId, PosteriorMarginals, ProgressDetail, RecombinationCodonTreeSet, SiteResult } from "@phylo-workbench/model-diffubar/browser-source";
import type { ApproximateFelProducts, FubarPosteriorProducts, FubarSiteResult } from "@phylo-workbench/model-fubar/browser-source";
import type { BsrelBranchResult } from "@phylo-workbench/model-bsrel/browser-source";
import type {
  CladeShiftBranchResult,
  CladeShiftPosteriorProducts,
  CladeShiftSiteResult,
} from "@phylo-workbench/model-cladeshift/browser-source";
import type {
  FamePosteriorProducts,
  FameSiteResult,
  FlavorPosteriorProducts,
  FlavorSiteResult,
  GlobalGammaBranchResult,
  GlobalGammaFit,
  GlobalGammaPosteriorProducts,
  GlobalGammaSiteResult,
} from "@phylo-workbench/model-bame/browser-source";

export interface DifFubarRunResult {
  readonly sites: readonly SiteResult[];
  readonly detectedSites: readonly number[];
  readonly posteriorMarginals?: PosteriorMarginals;
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
  };
  readonly tree: string;
  readonly csv: string;
}

export interface WorkerRunRequest {
  readonly type: "run";
  readonly id: string;
  readonly alignment: string;
  readonly tree: string;
  readonly parameters: Readonly<Record<string, string | number | boolean>>;
  readonly recombinationTrees?: RecombinationCodonTreeSet;
}

export interface FubarRunResult {
  readonly sites: readonly FubarSiteResult[];
  readonly positiveSites: readonly number[];
  readonly purifyingSites: readonly number[];
  readonly posterior: FubarPosteriorProducts;
  readonly approximateFel?: ApproximateFelProducts;
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
    readonly inferenceMethod: "dirichlet-em" | "gibbs";
    readonly inferenceIterations: number;
    readonly inferenceBurnin: number;
    readonly inferenceLogLikelihood: number | null;
    readonly regionalTrees: number;
    readonly branchScalePolicy: "single-tree" | "fixed-relative";
    readonly branchLengthSource: "input-tree" | "jemspr-linked-ml" | "segment-ml" | "method-final-trees";
    readonly codonAssignment: "single-tree" | "middle-nucleotide";
  };
  readonly tree: string;
  readonly csv: string;
}

export interface BsrelRunResult {
  readonly branches: readonly BsrelBranchResult[];
  readonly alternativeLogLikelihood: number;
  readonly backend: "wasm" | "wasm-parallel";
  readonly timings: Readonly<Record<string, number>>;
  readonly diagnostics: {
    readonly geneticCodeId: GeneticCodeId;
    readonly geneticCodeName: string;
    readonly codonStates: number;
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
  readonly tree: string;
  readonly csv: string;
}

export interface FameRunResult {
  readonly method: "fame";
  readonly sites: readonly FameSiteResult[];
  readonly detectedSites: readonly number[];
  readonly posterior: FamePosteriorProducts;
  readonly positivePrior: number;
  readonly backend: "wasm" | "wasm-parallel";
  readonly timings: Readonly<Record<string, number>>;
  readonly diagnostics: {
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
    readonly inferenceMethod: "dirichlet-em" | "gibbs";
    readonly inferenceIterations: number;
    readonly inferenceBurnin: number;
    readonly inferenceLogLikelihood: number | null;
    readonly modelDraftCommit: string;
    readonly numericalEngine: "fused-sparse-or-dense-uniformization" | "julia-matrix-sequence-linear-interpolation";
    readonly weightIntegration: "likelihood-quadrature" | "julia-draft-log-average";
    readonly weightPoints: number;
    readonly gridPreset: "fast" | "julia-draft";
    readonly regionalTrees: number;
    readonly branchScalePolicy: "single-tree" | "fixed-relative";
    readonly branchLengthSource: "input-tree" | "jemspr-linked-ml" | "segment-ml" | "method-final-trees";
    readonly codonAssignment: "single-tree" | "middle-nucleotide";
  };
  readonly tree: string;
  readonly csv: string;
}

export interface FlavorRunResult {
  readonly method: "flavor";
  readonly sites: readonly FlavorSiteResult[];
  readonly detectedSites: readonly number[];
  readonly posterior: FlavorPosteriorProducts;
  readonly positivePrior: number;
  readonly backend: "wasm" | "wasm-parallel";
  readonly timings: Readonly<Record<string, number>>;
  readonly diagnostics: {
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
    readonly inferenceMethod: "dirichlet-em" | "gibbs";
    readonly inferenceIterations: number;
    readonly inferenceBurnin: number;
    readonly inferenceLogLikelihood: number | null;
    readonly modelDraftCommit: string;
    readonly numericalEngine: "fused-sparse-or-dense-uniformization" | "julia-matrix-sequence-linear-interpolation";
    readonly gammaSlices: number;
    readonly transitionEngine: "julia-interpolated" | "direct-uniformization";
    readonly interpolationTimeStep: 0.001;
    readonly interpolationTablePoints: 50;
    readonly interpolationTableCap: 35;
    readonly cappedGridMultiplicityRetained: true;
    readonly gridPreset: "fast" | "julia-draft";
    readonly regionalTrees: number;
    readonly branchScalePolicy: "single-tree" | "fixed-relative";
    readonly branchLengthSource: "input-tree" | "jemspr-linked-ml" | "segment-ml" | "method-final-trees";
    readonly codonAssignment: "single-tree" | "middle-nucleotide";
  };
  readonly tree: string;
  readonly csv: string;
}

export type BameRunResult = FameRunResult | FlavorRunResult;

export interface GlobalGammaRunResult {
  readonly method: "glamma";
  readonly sites: readonly GlobalGammaSiteResult[];
  readonly branches: readonly GlobalGammaBranchResult[];
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
    readonly fitPreset: "fast" | "thorough";
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
  readonly tree: string;
  readonly siteCsv: string;
  readonly branchCsv: string;
}

export interface CladeShiftRunResult {
  readonly method: "clade-shift";
  readonly sites: readonly CladeShiftSiteResult[];
  readonly branches: readonly CladeShiftBranchResult[];
  readonly detectedSites: readonly number[];
  readonly posterior: CladeShiftPosteriorProducts;
  readonly intensities: Float64Array;
  readonly shiftPrior: number;
  readonly backend: "wasm" | "wasm-parallel";
  readonly timings: Readonly<Record<string, number>>;
  readonly diagnostics: {
    readonly geneticCodeId: GeneticCodeId;
    readonly geneticCodeName: string;
    readonly codonStates: number;
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
    readonly intensityPreset: "fast" | "thorough";
    readonly minimumDescendantTips: number;
    readonly minimumCapturedPosteriorMass: number;
    readonly meanCapturedPosteriorMass: number;
    readonly nullIntegration: "compressed-fubar-posterior-identity";
    readonly cladeAlgorithm: "baseline-outside-plus-shifted-subtree-inside";
    readonly evidenceCalibration: "fixed-prior-empirical-bayes";
    readonly validatedMethod: false;
    readonly precision: "f64";
  };
  readonly tree: string;
  readonly siteCsv: string;
  readonly branchCsv: string;
}

export interface BameWorkerRunRequest extends WorkerRunRequest {
  readonly method: "fame" | "flavor" | "glamma";
}

export type WorkerResponse =
  | { readonly type: "progress"; readonly id: string; readonly stage: string; readonly fraction: number; readonly detail?: ProgressDetail }
  | { readonly type: "result"; readonly id: string; readonly result: DifFubarRunResult }
  | { readonly type: "error"; readonly id: string; readonly error: string };

export type FubarWorkerResponse =
  | { readonly type: "progress"; readonly id: string; readonly stage: string; readonly fraction: number; readonly detail?: ProgressDetail }
  | { readonly type: "result"; readonly id: string; readonly result: FubarRunResult }
  | { readonly type: "error"; readonly id: string; readonly error: string };

export type BsrelWorkerResponse =
  | { readonly type: "progress"; readonly id: string; readonly stage: string; readonly fraction: number; readonly detail?: ProgressDetail }
  | { readonly type: "result"; readonly id: string; readonly result: BsrelRunResult }
  | { readonly type: "error"; readonly id: string; readonly error: string };

export type BameWorkerResponse =
  | { readonly type: "progress"; readonly id: string; readonly stage: string; readonly fraction: number; readonly detail?: ProgressDetail }
  | { readonly type: "result"; readonly id: string; readonly result: BameRunResult | GlobalGammaRunResult }
  | { readonly type: "error"; readonly id: string; readonly error: string };

export type CladeShiftWorkerResponse =
  | { readonly type: "progress"; readonly id: string; readonly stage: string; readonly fraction: number; readonly detail?: ProgressDetail }
  | { readonly type: "result"; readonly id: string; readonly result: CladeShiftRunResult }
  | { readonly type: "error"; readonly id: string; readonly error: string };

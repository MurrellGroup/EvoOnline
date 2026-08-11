import type { PosteriorMarginals, ProgressDetail, SiteResult } from "@phylo-workbench/model-diffubar/browser-source";
import type { ApproximateFelProducts, FubarPosteriorProducts, FubarSiteResult } from "@phylo-workbench/model-fubar/browser-source";
import type { BsrelBranchResult } from "@phylo-workbench/model-bsrel/browser-source";

export interface DifFubarRunResult {
  readonly sites: readonly SiteResult[];
  readonly detectedSites: readonly number[];
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
  readonly tree: string;
  readonly csv: string;
}

export interface WorkerRunRequest {
  readonly type: "run";
  readonly id: string;
  readonly alignment: string;
  readonly tree: string;
  readonly parameters: Readonly<Record<string, string | number | boolean>>;
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
    readonly taxa: number;
    readonly codonSites: number;
    readonly categories: number;
    readonly treeRegisterNumber: number;
    readonly precision: "f32" | "f64";
    readonly inferenceMethod: "dirichlet-em" | "gibbs";
    readonly inferenceIterations: number;
    readonly inferenceBurnin: number;
    readonly inferenceLogLikelihood: number | null;
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

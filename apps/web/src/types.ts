import type { PosteriorMarginals, ProgressDetail, SiteResult } from "@phylo-workbench/model-diffubar/browser-source";
import type { ApproximateFelProducts, FubarPosteriorProducts, FubarSiteResult } from "@phylo-workbench/model-fubar/browser-source";

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

export type WorkerResponse =
  | { readonly type: "progress"; readonly id: string; readonly stage: string; readonly fraction: number; readonly detail?: ProgressDetail }
  | { readonly type: "result"; readonly id: string; readonly result: DifFubarRunResult }
  | { readonly type: "error"; readonly id: string; readonly error: string };

export type FubarWorkerResponse =
  | { readonly type: "progress"; readonly id: string; readonly stage: string; readonly fraction: number; readonly detail?: ProgressDetail }
  | { readonly type: "result"; readonly id: string; readonly result: FubarRunResult }
  | { readonly type: "error"; readonly id: string; readonly error: string };

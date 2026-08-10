import type { PhyloWorkspaceSnapshot } from "@phylo-workbench/domain";
import {
  analyzeDifFUBAR,
  difFubarManifest,
  resultsToCsv,
  validateDifFubarWorkspace,
  type AnalysisResult,
} from "@phylo-workbench/model-diffubar";
import type { ModelManifest, ModelValidation, ParameterValues } from "@phylo-workbench/model-sdk";
import {
  analyzeFubar,
  fubarManifest,
  fubarResultsToCsv,
  validateFubarWorkspace,
  type FubarAnalysisResult,
} from "@phylo-workbench/model-fubar";

export interface ServerRunContext {
  readonly alignment: string;
  readonly tree: string;
  readonly parameters: ParameterValues;
  readonly signal: AbortSignal;
  readonly onProgress: (stage: string, fraction: number) => void;
}

export interface ServerModelRegistration {
  readonly manifest: ModelManifest;
  validate(workspace: PhyloWorkspaceSnapshot): ModelValidation;
  run(context: ServerRunContext): Promise<unknown>;
}

function numberParameter(parameters: ParameterValues, name: string, fallback: number): number {
  const value = Number(parameters[name] ?? fallback);
  return Number.isFinite(value) ? value : fallback;
}

function serialiseDifFubarResult(result: AnalysisResult) {
  return {
    sites: result.sites,
    detectedSites: result.detectedSites,
    backend: result.backend,
    timings: result.timings,
    diagnostics: result.diagnostics,
    fittedModel: {
      gtrRates: [...result.fittedModel.gtrRates],
      f3x4: [...result.fittedModel.f3x4],
      globalAlpha: result.fittedModel.globalAlpha,
      globalBeta: result.fittedModel.globalBeta,
      logLikelihood: result.fittedModel.logLikelihood,
      fitKind: result.fittedModel.fitKind,
    },
    csv: resultsToCsv(result),
  };
}

function serialiseFubarResult(result: FubarAnalysisResult, threshold: number) {
  return {
    sites: result.sites,
    positiveSites: result.positiveSites,
    purifyingSites: result.purifyingSites,
    backend: result.backend,
    timings: result.timings,
    diagnostics: result.diagnostics,
    fittedModel: {
      gtrRates: [...result.fittedModel.gtrRates],
      f3x4: [...result.fittedModel.f3x4],
      globalAlpha: result.fittedModel.globalAlpha,
      globalBeta: result.fittedModel.globalBeta,
      logLikelihood: result.fittedModel.logLikelihood,
      fitKind: result.fittedModel.fitKind,
    },
    gridValues: [...result.grid.values],
    theta: [...result.theta],
    csv: fubarResultsToCsv(result, threshold),
  };
}

export const serverModelRegistry: readonly ServerModelRegistration[] = [
  {
    manifest: difFubarManifest,
    validate: validateDifFubarWorkspace,
    run: async ({ alignment, tree, parameters, signal, onProgress }) => {
      const result = await analyzeDifFUBAR(alignment, tree, {
        // The reference server runner is deliberately conservative. Production
        // registrations can choose a native parallel or GPU runner per job.
        backend: "wasm",
        foregroundGrid: numberParameter(parameters, "foregroundGrid", 6),
        backgroundGrid: numberParameter(parameters, "backgroundGrid", 4),
        iterations: numberParameter(parameters, "iterations", 2500),
        burnin: numberParameter(parameters, "burnin", 500),
        posteriorThreshold: numberParameter(parameters, "posteriorThreshold", 0.95),
        seed: numberParameter(parameters, "seed", 1234),
        fitMode: parameters.fitMode === "reference-compatible" ? "reference-compatible" : "empirical-fast",
        samplerMode: parameters.samplerMode === "reference" || parameters.samplerMode === "collapsed"
          ? parameters.samplerMode
          : "fast-exact",
        signal,
        onStage: onProgress,
      });
      return serialiseDifFubarResult(result);
    },
  },
  {
    manifest: fubarManifest,
    validate: validateFubarWorkspace,
    run: async ({ alignment, tree, parameters, signal, onProgress }) => {
      const posteriorThreshold = numberParameter(parameters, "posteriorThreshold", 0.95);
      const result = await analyzeFubar(alignment, tree, {
        backend: "wasm",
        gridPoints: numberParameter(parameters, "gridPoints", 20),
        inferenceMethod: parameters.inferenceMethod === "gibbs" ? "gibbs" : "dirichlet-em",
        iterations: numberParameter(parameters, "iterations", 2500),
        burnin: numberParameter(parameters, "burnin", 500),
        concentration: numberParameter(parameters, "concentration", 0.5),
        seed: numberParameter(parameters, "seed", 1234),
        posteriorThreshold,
        fitMode: parameters.fitMode === "reference-compatible" ? "reference-compatible" : "empirical-fast",
        signal,
        onStage: onProgress,
      });
      return serialiseFubarResult(result, posteriorThreshold);
    },
  },
];

export function getServerModel(id: string): ServerModelRegistration | undefined {
  return serverModelRegistry.find((registration) => registration.manifest.id === id);
}

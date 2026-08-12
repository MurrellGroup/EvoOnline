import type { PhyloWorkspaceSnapshot } from "@phylo-workbench/domain";
import {
  analyzeDifFUBAR,
  difFubarManifest,
  getGeneticCode,
  resultsToCsv,
  validateDifFubarWorkspace,
  type AnalysisResult,
} from "@phylo-workbench/model-diffubar";
import type { ModelManifest, ModelValidation, ParameterValues } from "@phylo-workbench/model-sdk";
import {
  analyzeFubar,
  approximateFelResultsToCsv,
  fubarManifest,
  fubarResultsToCsv,
  validateFubarWorkspace,
  type FubarAnalysisResult,
} from "@phylo-workbench/model-fubar";
import {
  analyzeBsrel,
  bsrelManifest,
  bsrelResultsToCsv,
  validateBsrelWorkspace,
  type BsrelAnalysisResult,
} from "@phylo-workbench/model-bsrel";
import {
  analyzeFame,
  analyzeFlavor,
  analyzeGlobalGamma,
  fameManifest,
  fameResultsToCsv,
  flavorManifest,
  flavorResultsToCsv,
  globalGammaManifest,
  globalGammaSitesToCsv,
  globalGammaBranchesToCsv,
  validateBameWorkspace,
  type FameAnalysisResult,
  type FlavorAnalysisResult,
  type GlobalGammaAnalysisResult,
} from "@phylo-workbench/model-bame";
import {
  analyzeCladeShift,
  cladeShiftBranchesToCsv,
  cladeShiftManifest,
  cladeShiftSitesToCsv,
  validateCladeShiftWorkspace,
  type CladeShiftAnalysisResult,
} from "@phylo-workbench/model-cladeshift";

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

function geneticCodeParameter(parameters: ParameterValues) {
  return getGeneticCode(String(parameters.geneticCode ?? 1)).id;
}

function serialiseDifFubarResult(result: AnalysisResult) {
  return {
    sites: result.sites,
    detectedSites: result.detectedSites,
    backend: result.backend,
    timings: result.timings,
    diagnostics: result.diagnostics,
    fittedModel: {
      geneticCodeId: result.fittedModel.geneticCodeId,
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
  const approximateFel = result.approximateFel === undefined ? undefined : {
    siteCount: result.approximateFel.siteCount,
    gridSize: result.approximateFel.gridSize,
    gridValues: [...result.approximateFel.gridValues],
    relativeLogLikelihoods: [...result.approximateFel.relativeLogLikelihoods],
    sites: result.approximateFel.sites,
    diagnostics: result.approximateFel.diagnostics,
    csv: approximateFelResultsToCsv(result.approximateFel),
  };
  return {
    sites: result.sites,
    positiveSites: result.positiveSites,
    purifyingSites: result.purifyingSites,
    backend: result.backend,
    timings: result.timings,
    diagnostics: result.diagnostics,
    fittedModel: {
      geneticCodeId: result.fittedModel.geneticCodeId,
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
    ...(approximateFel === undefined ? {} : { approximateFel }),
  };
}

function serialiseBsrelResult(result: BsrelAnalysisResult) {
  return {
    branches: result.branches,
    alternativeLogLikelihood: result.alternativeLogLikelihood,
    backend: result.backend,
    timings: result.timings,
    diagnostics: result.diagnostics,
    fittedModel: {
      geneticCodeId: result.fittedModel.geneticCodeId,
      gtrRates: [...result.fittedModel.gtrRates],
      f3x4: [...result.fittedModel.f3x4],
      globalAlpha: result.fittedModel.globalAlpha,
      globalBeta: result.fittedModel.globalBeta,
      logLikelihood: result.fittedModel.logLikelihood,
      fitKind: result.fittedModel.fitKind,
    },
    csv: bsrelResultsToCsv(result),
  };
}

function serialiseBameResult(result: FameAnalysisResult | FlavorAnalysisResult, threshold: number) {
  return {
    method: result.method,
    sites: result.sites,
    detectedSites: result.detectedSites,
    positivePrior: result.positivePrior,
    backend: result.backend,
    timings: result.timings,
    diagnostics: result.diagnostics,
    fittedModel: {
      geneticCodeId: result.fittedModel.geneticCodeId,
      gtrRates: [...result.fittedModel.gtrRates],
      f3x4: [...result.fittedModel.f3x4],
      globalAlpha: result.fittedModel.globalAlpha,
      globalBeta: result.fittedModel.globalBeta,
      logLikelihood: result.fittedModel.logLikelihood,
      fitKind: result.fittedModel.fitKind,
    },
    csv: result.method === "fame" ? fameResultsToCsv(result, threshold) : flavorResultsToCsv(result, threshold),
  };
}

function serialiseGlobalGammaResult(result: GlobalGammaAnalysisResult) {
  return {
    method: result.method,
    sites: result.sites,
    branches: result.branches,
    fit: result.fit,
    omegaValues: [...result.omegaValues],
    alphaValues: [...result.alphaValues],
    positivePrior: result.positivePrior,
    posterior: {
      siteCount: result.posterior.siteCount,
      branchCount: result.posterior.branchCount,
      tailPosterior: [...result.posterior.tailPosterior],
      localLogEvidence: [...result.posterior.localLogEvidence],
    },
    backend: result.backend,
    timings: result.timings,
    diagnostics: result.diagnostics,
    fittedModel: {
      geneticCodeId: result.fittedModel.geneticCodeId,
      gtrRates: [...result.fittedModel.gtrRates],
      f3x4: [...result.fittedModel.f3x4],
      globalAlpha: result.fittedModel.globalAlpha,
      globalBeta: result.fittedModel.globalBeta,
      logLikelihood: result.fittedModel.logLikelihood,
      fitKind: result.fittedModel.fitKind,
    },
    siteCsv: globalGammaSitesToCsv(result),
    branchCsv: globalGammaBranchesToCsv(result),
  };
}

function serialiseCladeShiftResult(result: CladeShiftAnalysisResult) {
  return {
    method: result.method,
    sites: result.sites,
    branches: result.branches,
    detectedSites: result.detectedSites,
    posterior: {
      siteCount: result.posterior.siteCount,
      branchCount: result.posterior.branchCount,
      intensities: [...result.posterior.intensities],
      branchPosterior: [...result.posterior.branchPosterior],
      branchRelaxation: [...result.posterior.branchRelaxation],
      branchIntensification: [...result.posterior.branchIntensification],
      intensityPosterior: [...result.posterior.intensityPosterior],
    },
    intensities: [...result.intensities],
    shiftPrior: result.shiftPrior,
    backend: result.backend,
    timings: result.timings,
    diagnostics: result.diagnostics,
    fittedModel: {
      geneticCodeId: result.fittedModel.geneticCodeId,
      gtrRates: [...result.fittedModel.gtrRates],
      f3x4: [...result.fittedModel.f3x4],
      globalAlpha: result.fittedModel.globalAlpha,
      globalBeta: result.fittedModel.globalBeta,
      logLikelihood: result.fittedModel.logLikelihood,
      fitKind: result.fittedModel.fitKind,
    },
    siteCsv: cladeShiftSitesToCsv(result.sites),
    branchCsv: cladeShiftBranchesToCsv(result.branches),
  };
}

export const serverModelRegistry: readonly ServerModelRegistration[] = [
  {
    manifest: difFubarManifest,
    validate: validateDifFubarWorkspace,
    run: async ({ alignment, tree, parameters, signal, onProgress }) => {
      const result = await analyzeDifFUBAR(alignment, tree, {
        geneticCode: geneticCodeParameter(parameters),
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
        geneticCode: geneticCodeParameter(parameters),
        backend: "wasm",
        gridPoints: numberParameter(parameters, "gridPoints", 20),
        inferenceMethod: parameters.inferenceMethod === "gibbs" ? "gibbs" : "dirichlet-em",
        iterations: numberParameter(parameters, "iterations", 2500),
        burnin: numberParameter(parameters, "burnin", 500),
        concentration: numberParameter(parameters, "concentration", 0.5),
        seed: numberParameter(parameters, "seed", 1234),
        posteriorThreshold,
        fitMode: parameters.fitMode === "reference-compatible" ? "reference-compatible" : "empirical-fast",
        approximateFel: parameters.approximateFel === true || parameters.approximateFel === "true",
        signal,
        onStage: onProgress,
      });
      return serialiseFubarResult(result, posteriorThreshold);
    },
  },
  {
    manifest: bsrelManifest,
    validate: validateBsrelWorkspace,
    run: async ({ alignment, tree, parameters, signal, onProgress }) => {
      const branchScope = parameters.branchScope === "internal" || parameters.branchScope === "terminal"
        ? parameters.branchScope
        : "all";
      const result = await analyzeBsrel(alignment, tree, {
        geneticCode: geneticCodeParameter(parameters),
        backend: "wasm",
        branchScope,
        significanceThreshold: numberParameter(parameters, "significanceThreshold", 0.05),
        alternativeIterations: numberParameter(parameters, "alternativeIterations", 45),
        nullIterations: numberParameter(parameters, "nullIterations", 10),
        maximumOmega: numberParameter(parameters, "maximumOmega", 1000),
        fitMode: parameters.fitMode === "reference-compatible" ? "reference-compatible" : "empirical-fast",
        signal,
        onStage: onProgress,
      });
      return serialiseBsrelResult(result);
    },
  },
  {
    manifest: fameManifest,
    validate: validateBameWorkspace,
    run: async ({ alignment, tree, parameters, signal, onProgress }) => {
      const threshold = numberParameter(parameters, "posteriorThreshold", 0.9);
      const result = await analyzeFame(alignment, tree, {
        geneticCode: geneticCodeParameter(parameters),
        backend: "wasm",
        inferenceMethod: parameters.inferenceMethod === "gibbs" ? "gibbs" : "dirichlet-em",
        iterations: numberParameter(parameters, "iterations", 2500),
        burnin: numberParameter(parameters, "burnin", 500),
        concentration: numberParameter(parameters, "concentration", 0.1),
        seed: numberParameter(parameters, "seed", 1234),
        posteriorThreshold: threshold,
        gridPreset: parameters.gridPreset === "julia-draft" ? "julia-draft" : "fast",
        fitMode: parameters.fitMode === "reference-compatible" ? "reference-compatible" : "empirical-fast",
        weightIntegration: parameters.weightIntegration === "julia-draft-log-average" ? "julia-draft-log-average" : "likelihood-quadrature",
        quadraturePoints: numberParameter(parameters, "quadraturePoints", 4),
        draftWeightPoints: numberParameter(parameters, "draftWeightPoints", 20),
        signal,
        onStage: onProgress,
      });
      return serialiseBameResult(result, threshold);
    },
  },
  {
    manifest: flavorManifest,
    validate: validateBameWorkspace,
    run: async ({ alignment, tree, parameters, signal, onProgress }) => {
      const threshold = numberParameter(parameters, "posteriorThreshold", 0.9);
      const result = await analyzeFlavor(alignment, tree, {
        geneticCode: geneticCodeParameter(parameters),
        backend: "wasm",
        inferenceMethod: parameters.inferenceMethod === "gibbs" ? "gibbs" : "dirichlet-em",
        iterations: numberParameter(parameters, "iterations", 2500),
        burnin: numberParameter(parameters, "burnin", 500),
        concentration: numberParameter(parameters, "concentration", 0.1),
        seed: numberParameter(parameters, "seed", 1234),
        posteriorThreshold: threshold,
        gridPreset: parameters.gridPreset === "julia-draft" ? "julia-draft" : "fast",
        gammaSlices: numberParameter(parameters, "gammaSlices", 12),
        transitionEngine: parameters.transitionEngine === "direct-uniformization" ? "direct-uniformization" : "julia-interpolated",
        fitMode: parameters.fitMode === "reference-compatible" ? "reference-compatible" : "empirical-fast",
        signal,
        onStage: onProgress,
      });
      return serialiseBameResult(result, threshold);
    },
  },
  {
    manifest: globalGammaManifest,
    validate: validateBameWorkspace,
    run: async ({ alignment, tree, parameters, signal, onProgress }) => {
      const result = await analyzeGlobalGamma(alignment, tree, {
        geneticCode: geneticCodeParameter(parameters),
        backend: "wasm",
        omegaSlices: numberParameter(parameters, "omegaSlices", 8),
        alphaSlices: numberParameter(parameters, "alphaSlices", 4),
        fitPreset: parameters.fitPreset === "thorough" ? "thorough" : "fast",
        activationPriorAlpha: numberParameter(parameters, "activationPriorAlpha", 1),
        activationPriorBeta: numberParameter(parameters, "activationPriorBeta", 9),
        fitMode: parameters.fitMode === "reference-compatible" ? "reference-compatible" : "empirical-fast",
        signal,
        onStage: onProgress,
      });
      return serialiseGlobalGammaResult(result);
    },
  },
  {
    manifest: cladeShiftManifest,
    validate: validateCladeShiftWorkspace,
    run: async ({ alignment, tree, parameters, signal, onProgress }) => {
      const result = await analyzeCladeShift(alignment, tree, {
        geneticCode: geneticCodeParameter(parameters),
        backend: "wasm",
        gridPoints: numberParameter(parameters, "gridPoints", 16),
        posteriorComponents: numberParameter(parameters, "posteriorComponents", 96),
        posteriorMassTarget: numberParameter(parameters, "posteriorMassTarget", 0.9),
        intensityPreset: parameters.intensityPreset === "thorough" ? "thorough" : "fast",
        shiftPrior: numberParameter(parameters, "shiftPrior", 0.2),
        posteriorThreshold: numberParameter(parameters, "posteriorThreshold", 0.9),
        minimumDescendantTips: numberParameter(parameters, "minimumDescendantTips", 1),
        inferenceIterations: numberParameter(parameters, "inferenceIterations", 1000),
        concentration: numberParameter(parameters, "concentration", 0.5),
        fitMode: parameters.fitMode === "reference-compatible" ? "reference-compatible" : "empirical-fast",
        signal,
        onStage: onProgress,
      });
      return serialiseCladeShiftResult(result);
    },
  },
];

export function getServerModel(id: string): ServerModelRegistration | undefined {
  return serverModelRegistry.find((registration) => registration.manifest.id === id);
}

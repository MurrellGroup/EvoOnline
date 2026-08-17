/// <reference lib="webworker" />
import {
  analyzeFame,
  analyzeFlavor,
  analyzeGlobalGamma,
  fameResultsToCsv,
  flavorResultsToCsv,
  globalGammaSitesToCsv,
  globalGammaBranchesToCsv,
} from "@phylo-workbench/model-bame/browser-source";
import type { BameBackendKind } from "@phylo-workbench/model-bame/browser-source";
import { configureParallelWasmWorkerCount, getGeneticCode, type ProgressDetail } from "@phylo-workbench/model-diffubar/browser-source";
import type { BameRunResult, BameWorkerResponse, BameWorkerRunRequest, GlobalGammaRunResult } from "../types.js";

const scope = self as DedicatedWorkerGlobalScope;
const transferableBuffer = (value: ArrayBufferView): ArrayBuffer => value.buffer as ArrayBuffer;

scope.onmessage = (event: MessageEvent<BameWorkerRunRequest>): void => {
  const request = event.data;
  if (request.type !== "run") return;
  void (async () => {
    try {
      const parameters = request.parameters;
      const maxCpus = Number(parameters.maxCpus);
      configureParallelWasmWorkerCount(Number.isFinite(maxCpus) ? maxCpus : undefined);
      const backendValue = String(parameters.backend ?? "wasm-parallel");
      const backend: BameBackendKind = backendValue === "wasm" || backendValue === "wasm-parallel" ? backendValue : "auto";
      const threshold = Number(parameters.posteriorThreshold ?? 0.9);
      const geneticCode = getGeneticCode(String(parameters.geneticCode ?? 1)).id;
      const common = {
        geneticCode,
        backend,
        inferenceMethod: parameters.inferenceMethod === "gibbs" ? "gibbs" as const : "dirichlet-em" as const,
        iterations: Number(parameters.iterations ?? 2500),
        burnin: Number(parameters.burnin ?? 500),
        concentration: Number(parameters.concentration ?? 0.1),
        seed: Number(parameters.seed ?? 1234),
        posteriorThreshold: threshold,
        gridPreset: parameters.gridPreset === "julia-draft" ? "julia-draft" as const : "fast" as const,
        fitMode: parameters.fitMode === "reference-compatible" ? "reference-compatible" as const : "empirical-fast" as const,
        ...(request.recombinationTrees === undefined ? {} : { recombinationTrees: request.recombinationTrees }),
        onStage: (stage: string, fraction: number, detail?: ProgressDetail) => {
          const message: BameWorkerResponse = { type: "progress", id: request.id, stage, fraction, ...(detail === undefined ? {} : { detail }) };
          scope.postMessage(message);
        },
      };
      let compact: BameRunResult | GlobalGammaRunResult;
      let transfer: ArrayBuffer[];
      if (request.method === "fame") {
        const result = await analyzeFame(request.alignment, request.tree, {
          ...common,
          weightIntegration: parameters.weightIntegration === "julia-draft-log-average" ? "julia-draft-log-average" : "likelihood-quadrature",
          quadraturePoints: Number(parameters.quadraturePoints ?? 4),
          draftWeightPoints: Number(parameters.draftWeightPoints ?? 20),
        });
        compact = {
          method: "fame",
          sites: result.sites,
          detectedSites: result.detectedSites,
          posterior: result.posterior,
          positivePrior: result.positivePrior,
          backend: result.backend,
          timings: result.timings,
          diagnostics: result.diagnostics,
          tree: request.tree,
          csv: fameResultsToCsv(result, threshold),
        };
        transfer = [
          transferableBuffer(result.posterior.alphaValues), transferableBuffer(result.posterior.omega1Values), transferableBuffer(result.posterior.omega2Values),
          transferableBuffer(result.posterior.surfaces), transferableBuffer(result.posterior.alpha), transferableBuffer(result.posterior.omega1), transferableBuffer(result.posterior.omega2),
        ];
      } else if (request.method === "flavor") {
        const result = await analyzeFlavor(request.alignment, request.tree, {
          ...common,
          gammaSlices: Number(parameters.gammaSlices ?? 12),
          transitionEngine: parameters.transitionEngine === "direct-uniformization" ? "direct-uniformization" : "julia-interpolated",
        });
        compact = {
          method: "flavor",
          sites: result.sites,
          detectedSites: result.detectedSites,
          posterior: result.posterior,
          positivePrior: result.positivePrior,
          backend: result.backend,
          timings: result.timings,
          diagnostics: result.diagnostics,
          tree: request.tree,
          csv: flavorResultsToCsv(result, threshold),
        };
        transfer = [
          transferableBuffer(result.posterior.muValues), transferableBuffer(result.posterior.shapeValues), transferableBuffer(result.posterior.alphaValues),
          transferableBuffer(result.posterior.surfaces), transferableBuffer(result.posterior.mu), transferableBuffer(result.posterior.shape),
          transferableBuffer(result.posterior.alpha), transferableBuffer(result.posterior.capState),
        ];
      } else {
        const result = await analyzeGlobalGamma(request.alignment, request.tree, {
          geneticCode,
          backend,
          omegaSlices: Number(parameters.omegaSlices ?? 8),
          alphaSlices: Number(parameters.alphaSlices ?? 4),
          fitPreset: parameters.fitPreset === "thorough" ? "thorough" : "fast",
          activationPriorAlpha: Number(parameters.activationPriorAlpha ?? 1),
          activationPriorBeta: Number(parameters.activationPriorBeta ?? 9),
          fitMode: parameters.fitMode === "reference-compatible" ? "reference-compatible" : "empirical-fast",
          onStage: (stage: string, fraction: number, detail?: ProgressDetail) => {
            const message: BameWorkerResponse = { type: "progress", id: request.id, stage, fraction, ...(detail === undefined ? {} : { detail }) };
            scope.postMessage(message);
          },
        });
        compact = {
          method: "glamma",
          sites: result.sites,
          branches: result.branches,
          fit: result.fit,
          omegaValues: result.omegaValues,
          alphaValues: result.alphaValues,
          positivePrior: result.positivePrior,
          posterior: result.posterior,
          backend: result.backend,
          timings: result.timings,
          diagnostics: result.diagnostics,
          tree: request.tree,
          siteCsv: globalGammaSitesToCsv(result),
          branchCsv: globalGammaBranchesToCsv(result),
        };
        transfer = [
          transferableBuffer(result.omegaValues), transferableBuffer(result.alphaValues),
          transferableBuffer(result.posterior.tailPosterior), transferableBuffer(result.posterior.localLogEvidence),
        ];
      }
      const message: BameWorkerResponse = { type: "result", id: request.id, result: compact };
      scope.postMessage(message, transfer);
    } catch (error) {
      const message: BameWorkerResponse = { type: "error", id: request.id, error: error instanceof Error ? error.message : String(error) };
      scope.postMessage(message);
    }
  })();
};

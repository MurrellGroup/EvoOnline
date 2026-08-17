/// <reference lib="webworker" />
import { analyzeFubar, fubarResultsToCsv } from "@phylo-workbench/model-fubar/browser-source";
import { configureParallelWasmWorkerCount, getGeneticCode } from "@phylo-workbench/model-diffubar/browser-source";
import type { FubarWorkerResponse, WorkerRunRequest } from "../types.js";

const scope = self as DedicatedWorkerGlobalScope;

scope.onmessage = (event: MessageEvent<WorkerRunRequest>): void => {
  const request = event.data;
  if (request.type !== "run") return;
  void (async () => {
    try {
      const parameters = request.parameters;
      const maxCpus = Number(parameters.maxCpus);
      configureParallelWasmWorkerCount(Number.isFinite(maxCpus) ? maxCpus : undefined);
      const backendValue = String(parameters.backend ?? "wasm-parallel");
      const backend = backendValue === "webgpu" || backendValue === "wasm" || backendValue === "wasm-parallel"
        ? backendValue
        : "auto";
      const threshold = Number(parameters.posteriorThreshold ?? 0.95);
      const inferenceMethod = parameters.inferenceMethod === "gibbs" ? "gibbs" : "dirichlet-em";
      const result = await analyzeFubar(request.alignment, request.tree, {
        geneticCode: getGeneticCode(String(parameters.geneticCode ?? 1)).id,
        backend,
        gridPoints: Number(parameters.gridPoints ?? 20),
        inferenceMethod,
        iterations: Number(parameters.iterations ?? 2500),
        burnin: Number(parameters.burnin ?? 500),
        concentration: Number(parameters.concentration ?? 0.5),
        seed: Number(parameters.seed ?? 1234),
        posteriorThreshold: threshold,
        fitMode: parameters.fitMode === "reference-compatible" ? "reference-compatible" : "empirical-fast",
        approximateFel: parameters.approximateFel === true || parameters.approximateFel === "true",
        ...(request.recombinationTrees === undefined ? {} : { recombinationTrees: request.recombinationTrees }),
        onStage: (stage, fraction, detail) => {
          const message: FubarWorkerResponse = {
            type: "progress",
            id: request.id,
            stage,
            fraction,
            ...(detail === undefined ? {} : { detail }),
          };
          scope.postMessage(message);
        },
      });
      const compact = {
        sites: result.sites,
        positiveSites: result.positiveSites,
        purifyingSites: result.purifyingSites,
        posterior: result.posterior,
        ...(result.approximateFel === undefined ? {} : { approximateFel: result.approximateFel }),
        backend: result.backend,
        timings: result.timings,
        diagnostics: result.diagnostics,
        tree: request.tree,
        csv: fubarResultsToCsv(result, threshold),
      };
      const message: FubarWorkerResponse = { type: "result", id: request.id, result: compact };
      const transfer = [
        result.posterior.gridValues.buffer,
        result.posterior.surfaces.buffer,
        result.posterior.alpha.buffer,
        result.posterior.beta.buffer,
      ];
      if (result.approximateFel !== undefined) {
        transfer.push(result.approximateFel.gridValues.buffer, result.approximateFel.relativeLogLikelihoods.buffer);
      }
      scope.postMessage(message, transfer);
    } catch (error) {
      const message: FubarWorkerResponse = {
        type: "error",
        id: request.id,
        error: error instanceof Error ? error.message : String(error),
      };
      scope.postMessage(message);
    }
  })();
};

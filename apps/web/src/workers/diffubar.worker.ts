/// <reference lib="webworker" />
import { analyzeDifFUBAR, resultsToCsv } from "@phylo-workbench/model-diffubar/browser-source";
import type { WorkerResponse, WorkerRunRequest } from "../types.js";

const scope = self as DedicatedWorkerGlobalScope;

scope.onmessage = (event: MessageEvent<WorkerRunRequest>): void => {
  const request = event.data;
  if (request.type !== "run") return;
  void (async () => {
    try {
      const parameters = request.parameters;
      const backendValue = String(parameters.backend ?? "auto");
      const backend = backendValue === "webgpu" || backendValue === "wasm" || backendValue === "wasm-parallel"
        ? backendValue
        : "auto";
      const samplerValue = String(parameters.samplerMode ?? "fast-exact");
      const samplerMode = samplerValue === "reference" || samplerValue === "collapsed" ? samplerValue : "fast-exact";
      const result = await analyzeDifFUBAR(request.alignment, request.tree, {
        backend,
        foregroundGrid: Number(parameters.foregroundGrid ?? 6),
        backgroundGrid: Number(parameters.backgroundGrid ?? 4),
        iterations: Number(parameters.iterations ?? 2500),
        burnin: Number(parameters.burnin ?? 500),
        posteriorThreshold: Number(parameters.posteriorThreshold ?? 0.95),
        seed: Number(parameters.seed ?? 1234),
        fitMode: parameters.fitMode === "reference-compatible" ? "reference-compatible" : "empirical-fast",
        samplerMode,
        collectPosteriorMarginals: true,
        onStage: (stage, fraction, detail) => {
          const message: WorkerResponse = {
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
        detectedSites: result.detectedSites,
        ...(result.posteriorMarginals === undefined ? {} : { posteriorMarginals: result.posteriorMarginals }),
        backend: result.backend,
        timings: result.timings,
        diagnostics: result.diagnostics,
        csv: resultsToCsv(result),
      };
      const message: WorkerResponse = { type: "result", id: request.id, result: compact };
      const transfer = result.posteriorMarginals === undefined ? [] : [
        result.posteriorMarginals.alphaValues.buffer,
        result.posteriorMarginals.omegaValues.buffer,
        result.posteriorMarginals.alpha.buffer,
        result.posteriorMarginals.omega1.buffer,
        result.posteriorMarginals.omega2.buffer,
      ];
      scope.postMessage(message, transfer);
    } catch (error) {
      const message: WorkerResponse = {
        type: "error",
        id: request.id,
        error: error instanceof Error ? error.message : String(error),
      };
      scope.postMessage(message);
    }
  })();
};

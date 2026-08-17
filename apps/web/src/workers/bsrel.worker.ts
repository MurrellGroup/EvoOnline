/// <reference lib="webworker" />
import { analyzeBsrel, bsrelResultsToCsv } from "@phylo-workbench/model-bsrel/browser-source";
import { configureParallelWasmWorkerCount, getGeneticCode } from "@phylo-workbench/model-diffubar/browser-source";
import type { BsrelWorkerResponse, WorkerRunRequest } from "../types.js";

const scope = self as DedicatedWorkerGlobalScope;

scope.onmessage = (event: MessageEvent<WorkerRunRequest>): void => {
  const request = event.data;
  if (request.type !== "run") return;
  void (async () => {
    try {
      const parameters = request.parameters;
      const maxCpus = Number(parameters.maxCpus);
      configureParallelWasmWorkerCount(Number.isFinite(maxCpus) ? maxCpus : undefined);
      const backend = parameters.backend === "wasm" ? "wasm" : "wasm-parallel";
      const branchScope = parameters.branchScope === "internal" || parameters.branchScope === "terminal"
        ? parameters.branchScope
        : "all";
      const result = await analyzeBsrel(request.alignment, request.tree, {
        geneticCode: getGeneticCode(String(parameters.geneticCode ?? 1)).id,
        backend,
        branchScope,
        significanceThreshold: Number(parameters.significanceThreshold ?? 0.05),
        alternativeIterations: Number(parameters.alternativeIterations ?? 45),
        nullIterations: Number(parameters.nullIterations ?? 10),
        maximumOmega: Number(parameters.maximumOmega ?? 1000),
        fitMode: parameters.fitMode === "reference-compatible" ? "reference-compatible" : "empirical-fast",
        onStage: (stage, fraction, detail) => {
          const message: BsrelWorkerResponse = {
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
        branches: result.branches,
        alternativeLogLikelihood: result.alternativeLogLikelihood,
        backend: result.backend,
        timings: result.timings,
        diagnostics: result.diagnostics,
        tree: request.tree,
        csv: bsrelResultsToCsv(result),
      };
      const message: BsrelWorkerResponse = { type: "result", id: request.id, result: compact };
      scope.postMessage(message);
    } catch (error) {
      const message: BsrelWorkerResponse = {
        type: "error",
        id: request.id,
        error: error instanceof Error ? error.message : String(error),
      };
      scope.postMessage(message);
    }
  })();
};

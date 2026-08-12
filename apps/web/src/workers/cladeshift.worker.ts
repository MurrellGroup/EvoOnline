/// <reference lib="webworker" />
import {
  analyzeCladeShift,
  cladeShiftBranchesToCsv,
  cladeShiftSitesToCsv,
  type CladeShiftBackendKind,
} from "@phylo-workbench/model-cladeshift/browser-source";
import { getGeneticCode, type ProgressDetail } from "@phylo-workbench/model-diffubar/browser-source";
import type { CladeShiftRunResult, CladeShiftWorkerResponse, WorkerRunRequest } from "../types.js";

const scope = self as DedicatedWorkerGlobalScope;
const transferableBuffer = (value: ArrayBufferView): ArrayBuffer => value.buffer as ArrayBuffer;

scope.onmessage = (event: MessageEvent<WorkerRunRequest>): void => {
  const request = event.data;
  if (request.type !== "run") return;
  void (async () => {
    try {
      const parameters = request.parameters;
      const backend: CladeShiftBackendKind = parameters.backend === "wasm" ? "wasm" : "wasm-parallel";
      const threshold = Number(parameters.posteriorThreshold ?? 0.9);
      const result = await analyzeCladeShift(request.alignment, request.tree, {
        geneticCode: getGeneticCode(String(parameters.geneticCode ?? 1)).id,
        backend,
        gridPoints: Number(parameters.gridPoints ?? 16),
        posteriorComponents: Number(parameters.posteriorComponents ?? 96),
        posteriorMassTarget: Number(parameters.posteriorMassTarget ?? 0.9),
        intensityPreset: parameters.intensityPreset === "thorough" ? "thorough" : "fast",
        shiftPrior: Number(parameters.shiftPrior ?? 0.2),
        posteriorThreshold: threshold,
        minimumDescendantTips: Number(parameters.minimumDescendantTips ?? 1),
        inferenceIterations: Number(parameters.inferenceIterations ?? 1000),
        concentration: Number(parameters.concentration ?? 0.5),
        fitMode: parameters.fitMode === "reference-compatible" ? "reference-compatible" : "empirical-fast",
        onStage: (stage: string, fraction: number, detail?: ProgressDetail) => {
          const message: CladeShiftWorkerResponse = { type: "progress", id: request.id, stage, fraction, ...(detail === undefined ? {} : { detail }) };
          scope.postMessage(message);
        },
      });
      const compact: CladeShiftRunResult = {
        method: "clade-shift",
        sites: result.sites,
        branches: result.branches,
        detectedSites: result.detectedSites,
        posterior: result.posterior,
        intensities: result.intensities,
        shiftPrior: result.shiftPrior,
        backend: result.backend,
        timings: result.timings,
        diagnostics: result.diagnostics,
        tree: request.tree,
        siteCsv: cladeShiftSitesToCsv(result.sites),
        branchCsv: cladeShiftBranchesToCsv(result.branches),
      };
      const response: CladeShiftWorkerResponse = { type: "result", id: request.id, result: compact };
      scope.postMessage(response, [
        transferableBuffer(result.intensities),
        transferableBuffer(result.posterior.branchPosterior),
        transferableBuffer(result.posterior.branchRelaxation),
        transferableBuffer(result.posterior.branchIntensification),
        transferableBuffer(result.posterior.intensityPosterior),
      ]);
    } catch (error) {
      const message: CladeShiftWorkerResponse = { type: "error", id: request.id, error: error instanceof Error ? error.message : String(error) };
      scope.postMessage(message);
    }
  })();
};

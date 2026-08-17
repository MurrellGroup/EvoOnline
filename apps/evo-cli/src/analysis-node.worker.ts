import { parentPort } from "node:worker_threads";
import { configureParallelWasmWorkerCount, configureWasmBinary, type RecombinationCodonTreeSet } from "@phylo-workbench/model-diffubar";
import type { ParameterValues } from "@phylo-workbench/model-sdk";
import { runFsart, runJemspr, runMosaicSpr, runSelectionMethod, type ProgressEvent } from "./methods.js";
import type { FastTreeRuntime } from "./fasttree.js";

type AnalysisWorkerRequest =
  | {
    readonly mode: "selection";
    readonly modelId: string;
    readonly alignment: string;
    readonly tree: string;
    readonly parameters: ParameterValues;
    readonly recombinationTrees?: RecombinationCodonTreeSet;
    readonly maxCpus: number;
    readonly wasmWorkerPath?: string;
    readonly wasmBinaryPath?: string;
  }
  | {
    readonly mode: "source";
    readonly modelId: "fsart" | "mosaic-spr" | "jemspr";
    readonly alignment: string;
    readonly parameters: ParameterValues;
    readonly runtime?: FastTreeRuntime;
    readonly maxCpus: number;
    readonly wasmWorkerPath?: string;
    readonly wasmBinaryPath?: string;
  };

type AnalysisWorkerResponse =
  | { readonly type: "progress"; readonly event: ProgressEvent }
  | { readonly type: "result"; readonly result: unknown }
  | { readonly type: "error"; readonly error: string };

parentPort?.once("message", (request: AnalysisWorkerRequest) => {
  if (request.wasmBinaryPath !== undefined) configureWasmBinary(request.wasmBinaryPath);
  configureParallelWasmWorkerCount(request.maxCpus);
  const report = (event: ProgressEvent): void => parentPort?.postMessage({ type: "progress", event } satisfies AnalysisWorkerResponse);
  const run = request.mode === "selection"
    ? runSelectionMethod(request.modelId, request.alignment, request.tree, request.parameters, report, request.recombinationTrees, request.maxCpus)
    : request.modelId === "fsart"
      ? runFsart(request.alignment, request.parameters, request.runtime, report, request.maxCpus)
      : request.modelId === "mosaic-spr"
        ? runMosaicSpr(request.alignment, request.parameters, request.runtime, report, request.maxCpus)
        : runJemspr(request.alignment, request.parameters, request.runtime, report, request.maxCpus);
  void run.then(
    (result) => parentPort?.postMessage({ type: "result", result } satisfies AnalysisWorkerResponse),
    (error: unknown) => parentPort?.postMessage({ type: "error", error: error instanceof Error ? error.stack ?? error.message : String(error) } satisfies AnalysisWorkerResponse),
  );
});

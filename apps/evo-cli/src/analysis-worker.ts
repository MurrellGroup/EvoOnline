import { Worker } from "node:worker_threads";
import type { RecombinationCodonTreeSet } from "@phylo-workbench/model-diffubar";
import type { FsartAnalysisResult } from "@phylo-workbench/model-fsart";
import type { JemsprAnalysisResult } from "@phylo-workbench/model-jemspr";
import type { MosaicSprAnalysisResult } from "@phylo-workbench/model-mosaicspr";
import type { ParameterValues } from "@phylo-workbench/model-sdk";
import type { FastTreeRuntime } from "./fasttree.js";
import type { ProgressEvent, ProgressReporter } from "./methods.js";

type AnalysisWorkerResponse =
  | { readonly type: "progress"; readonly event: ProgressEvent }
  | { readonly type: "result"; readonly result: unknown }
  | { readonly type: "error"; readonly error: string };

let configuredWorkerPath: string | URL | undefined;
let configuredWasmWorkerPath: string | undefined;
let configuredWasmBinaryPath: string | undefined;

/** Configure the JavaScript sidecars shipped beside a standalone executable. */
export function configureAnalysisWorkers(workerPath: string | URL | undefined, wasmWorkerPath?: string, wasmBinaryPath?: string): void {
  configuredWorkerPath = workerPath;
  configuredWasmWorkerPath = wasmWorkerPath;
  configuredWasmBinaryPath = wasmBinaryPath;
}

function defaultWorkerPath(): URL {
  return import.meta.url.endsWith(".ts")
    ? new URL("./analysis-node.worker.ts", import.meta.url)
    : new URL("./analysis-node.worker.js", import.meta.url);
}

function runIsolated(request: object, reporter: ProgressReporter): Promise<unknown> {
  const worker = new Worker(configuredWorkerPath ?? defaultWorkerPath());
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (): void => {
      settled = true;
      worker.removeAllListeners();
      void worker.terminate();
    };
    worker.on("message", (message: AnalysisWorkerResponse) => {
      if (message.type === "progress") reporter(message.event);
      else if (message.type === "result") { finish(); resolve(message.result); }
      else { finish(); reject(new Error(message.error)); }
    });
    worker.once("error", (error) => { if (!settled) { finish(); reject(error); } });
    worker.once("exit", (code) => { if (!settled) { finish(); reject(new Error(`Analysis worker exited before returning a result (status ${code}).`)); } });
    worker.postMessage({
      ...request,
      ...(configuredWasmWorkerPath === undefined ? {} : { wasmWorkerPath: configuredWasmWorkerPath }),
      ...(configuredWasmBinaryPath === undefined ? {} : { wasmBinaryPath: configuredWasmBinaryPath }),
    });
  });
}

export function runSelectionMethodIsolated(
  modelId: string,
  alignment: string,
  tree: string,
  parameters: ParameterValues,
  reporter: ProgressReporter,
  recombinationTrees: RecombinationCodonTreeSet | undefined,
  maxCpus: number,
): Promise<unknown> {
  return runIsolated({ mode: "selection", modelId, alignment, tree, parameters, ...(recombinationTrees === undefined ? {} : { recombinationTrees }), maxCpus }, reporter);
}

export function runSourceMethodIsolated(modelId: "fsart", alignment: string, parameters: ParameterValues, runtime: FastTreeRuntime | undefined, reporter: ProgressReporter, maxCpus: number): Promise<FsartAnalysisResult>;
export function runSourceMethodIsolated(modelId: "mosaic-spr", alignment: string, parameters: ParameterValues, runtime: FastTreeRuntime | undefined, reporter: ProgressReporter, maxCpus: number): Promise<MosaicSprAnalysisResult>;
export function runSourceMethodIsolated(modelId: "jemspr", alignment: string, parameters: ParameterValues, runtime: FastTreeRuntime | undefined, reporter: ProgressReporter, maxCpus: number): Promise<JemsprAnalysisResult>;
export function runSourceMethodIsolated(
  modelId: "fsart" | "mosaic-spr" | "jemspr",
  alignment: string,
  parameters: ParameterValues,
  runtime: FastTreeRuntime | undefined,
  reporter: ProgressReporter,
  maxCpus: number,
): Promise<FsartAnalysisResult | MosaicSprAnalysisResult | JemsprAnalysisResult> {
  return runIsolated({ mode: "source", modelId, alignment, parameters, ...(runtime === undefined ? {} : { runtime }), maxCpus }, reporter) as Promise<FsartAnalysisResult | MosaicSprAnalysisResult | JemsprAnalysisResult>;
}

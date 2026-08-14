/// <reference lib="webworker" />
import { decodeSimulatorConfig, runSimulator, type SimulatorAnalysisResult, type SimulatorProgressDetail } from "@phylo-workbench/model-simulator/browser-source";
import type { ParameterValues } from "@phylo-workbench/model-sdk";

export type SimulatorWorkerRequest = { readonly type: "run"; readonly id: string; readonly parameters: ParameterValues };
export type SimulatorWorkerResponse =
  | { readonly type: "progress"; readonly id: string; readonly stage: string; readonly fraction: number; readonly detail?: SimulatorProgressDetail }
  | { readonly type: "result"; readonly id: string; readonly result: SimulatorAnalysisResult }
  | { readonly type: "error"; readonly id: string; readonly error: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = (event: MessageEvent<SimulatorWorkerRequest>): void => {
  const request = event.data;
  if (request.type !== "run") return;
  const post = (message: SimulatorWorkerResponse): void => scope.postMessage(message);
  void runSimulator(decodeSimulatorConfig(request.parameters.simulatorConfig), {
    onProgress: (stage, fraction, detail) => post({ type: "progress", id: request.id, stage, fraction, ...(detail === undefined ? {} : { detail }) }),
  }).then(
    (result) => post({ type: "result", id: request.id, result }),
    (error: unknown) => post({ type: "error", id: request.id, error: error instanceof Error ? error.message : String(error) }),
  );
};

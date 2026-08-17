import { parentPort } from "node:worker_threads";
import { runSimulator, type SimulatorAnalysisResult, type SimulatorConfig, type SimulatorProgressDetail } from "@phylo-workbench/model-simulator";

interface SimulatorWorkerRequest {
  readonly config: SimulatorConfig;
  readonly replicateIndices: readonly number[];
  readonly includeDiagnostic: boolean;
}

type SimulatorWorkerResponse =
  | { readonly type: "progress"; readonly stage: string; readonly fraction: number; readonly detail?: SimulatorProgressDetail }
  | { readonly type: "result"; readonly result: SimulatorAnalysisResult }
  | { readonly type: "error"; readonly error: string };

parentPort?.once("message", (request: SimulatorWorkerRequest) => {
  const post = (message: SimulatorWorkerResponse): void => parentPort?.postMessage(message);
  void runSimulator(request.config, {
    replicateIndices: request.replicateIndices,
    includeDiagnostic: request.includeDiagnostic,
    onProgress: (stage, fraction, detail) => post({ type: "progress", stage, fraction, ...(detail === undefined ? {} : { detail }) }),
  }).then(
    (result) => post({ type: "result", result }),
    (error: unknown) => post({ type: "error", error: error instanceof Error ? error.stack ?? error.message : String(error) }),
  );
});

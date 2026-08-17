import { Worker } from "node:worker_threads";
import { runSimulator, type SimulatorAnalysisResult, type SimulatorConfig, type SimulatorProgressDetail } from "@phylo-workbench/model-simulator";

type Progress = (stage: string, fraction: number, detail?: SimulatorProgressDetail) => void;

type SimulatorWorkerResponse =
  | { readonly type: "progress"; readonly stage: string; readonly fraction: number; readonly detail?: SimulatorProgressDetail }
  | { readonly type: "result"; readonly result: SimulatorAnalysisResult }
  | { readonly type: "error"; readonly error: string };

let configuredWorkerPath: string | URL | undefined;

/** Point a compiled standalone executable at its simulator worker sidecar. */
export function configureSimulatorWorker(path: string | URL | undefined): void {
  configuredWorkerPath = path;
}

function defaultWorkerPath(): URL {
  return import.meta.url.endsWith(".ts")
    ? new URL("./simulator-node.worker.ts", import.meta.url)
    : new URL("./simulator-node.worker.js", import.meta.url);
}

function runShard(
  config: SimulatorConfig,
  replicateIndices: readonly number[],
  includeDiagnostic: boolean,
  onProgress: Progress,
): Promise<SimulatorAnalysisResult> {
  const worker = new Worker(configuredWorkerPath ?? defaultWorkerPath());
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (): void => {
      settled = true;
      worker.removeAllListeners();
      void worker.terminate();
    };
    worker.on("message", (message: SimulatorWorkerResponse) => {
      if (settled) return;
      if (message.type === "progress") onProgress(message.stage, message.fraction, message.detail);
      else if (message.type === "result") { finish(); resolve(message.result); }
      else { finish(); reject(new Error(message.error)); }
    });
    worker.once("error", (error) => { if (!settled) { finish(); reject(error); } });
    worker.once("exit", (code) => {
      if (!settled) { finish(); reject(new Error(`Simulator worker exited before returning a result (status ${code}).`)); }
    });
    worker.postMessage({ config, replicateIndices, includeDiagnostic });
  });
}

export async function runSimulatorParallel(
  config: SimulatorConfig,
  maxCpus: number,
  onProgress: Progress,
): Promise<SimulatorAnalysisResult> {
  const workerCount = Math.max(1, Math.min(config.tree.replicates, Math.floor(maxCpus)));
  if (workerCount <= 1) return runSimulator(config, { onProgress });
  const started = performance.now();
  const assignments = Array.from({ length: workerCount }, (_, workerIndex) =>
    Array.from({ length: config.tree.replicates }, (_unused, replicate) => replicate)
      .filter((replicate) => replicate % workerCount === workerIndex));
  const fractions = new Float64Array(workerCount);
  const results = await Promise.all(assignments.map((replicateIndices, workerIndex) =>
    runShard(config, replicateIndices, workerIndex === 0, (stage, fraction, detail) => {
      fractions[workerIndex] = fraction;
      const aggregate = assignments.reduce((sum, indices, index) => sum + fractions[index]! * indices.length, 0) / config.tree.replicates;
      onProgress(stage, aggregate, {
        ...detail,
        message: `${workerCount} workers · ${detail?.message ?? stage}`,
      });
    })));
  const datasets = results.flatMap((result, workerIndex) => result.datasets.map((dataset, localIndex) => ({
    replicate: assignments[workerIndex]![localIndex]!,
    dataset,
  }))).sort((left, right) => left.replicate - right.replicate).map(({ dataset }) => dataset);
  const first = results[0]!;
  const diagnostic = results.find((result) => result.scuffDiagnostic !== undefined)?.scuffDiagnostic;
  return {
    ...first,
    datasets,
    ...(diagnostic === undefined ? {} : { scuffDiagnostic: diagnostic }),
    elapsedMs: performance.now() - started,
  };
}

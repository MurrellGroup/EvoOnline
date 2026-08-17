import type { ParameterValues } from "@phylo-workbench/model-sdk";
import { decodeSimulatorConfig, type SimulatorAnalysisResult } from "@phylo-workbench/model-simulator/browser-source";
import type { SimulatorWorkerRequest, SimulatorWorkerResponse } from "../workers/simulator.worker.js";
import type { RunProgress } from "./diffubar-client.js";

export class SimulatorClient {
  private workers: Worker[] = [];
  private rejectActive: ((error: Error) => void) | undefined;

  constructor(private readonly getMaxCpus: () => number = () => 1) {}

  async run(_alignment: string, _tree: string, parameters: ParameterValues, onProgress: (progress: RunProgress) => void): Promise<SimulatorAnalysisResult> {
    this.cancel();
    const config = decodeSimulatorConfig(parameters.simulatorConfig);
    const workerCount = Math.max(1, Math.min(config.tree.replicates, Math.floor(this.getMaxCpus())));
    const assignments = Array.from({ length: workerCount }, (_, workerIndex) =>
      Array.from({ length: config.tree.replicates }, (_unused, replicate) => replicate)
        .filter((replicate) => replicate % workerCount === workerIndex));
    const workers = assignments.map(() => new Worker(new URL("../workers/simulator.worker.ts", import.meta.url), { type: "module" }));
    this.workers = workers;
    const fractions = new Float64Array(workerCount);
    const started = performance.now();
    return new Promise<SimulatorAnalysisResult>((resolve, reject) => {
      this.rejectActive = reject;
      const shards = workers.map((worker, workerIndex) => new Promise<SimulatorAnalysisResult>((resolveShard, rejectShard) => {
        const id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `sim-${Date.now()}-${workerIndex}`;
        worker.onmessage = (event: MessageEvent<SimulatorWorkerResponse>) => {
          const message = event.data;
          if (message.id !== id) return;
          if (message.type === "progress") {
            fractions[workerIndex] = Math.max(0, Math.min(1, message.fraction));
            const fraction = assignments.reduce((sum, indices, index) => sum + fractions[index]! * indices.length, 0) / config.tree.replicates;
            onProgress({ stage: message.stage, fraction, ...message.detail, message: `${workerCount} worker${workerCount === 1 ? "" : "s"} · ${message.detail?.message ?? message.stage}` });
          } else if (message.type === "result") resolveShard(message.result);
          else rejectShard(new Error(message.error));
        };
        worker.onerror = (event) => {
          event.preventDefault();
          rejectShard(new Error(event.message || "A simulator worker stopped unexpectedly."));
        };
        const request: SimulatorWorkerRequest = {
          type: "run",
          id,
          parameters,
          replicateIndices: assignments[workerIndex]!,
          includeDiagnostic: workerIndex === 0,
        };
        worker.postMessage(request);
      }));
      void Promise.all(shards).then((results) => {
        if (this.rejectActive !== reject) return;
        const datasets = results.flatMap((result, workerIndex) => result.datasets.map((dataset, localIndex) => ({
          replicate: assignments[workerIndex]![localIndex]!,
          dataset,
        }))).sort((left, right) => left.replicate - right.replicate).map(({ dataset }) => dataset);
        const first = results[0]!;
        const scuffDiagnostic = results.find((result) => result.scuffDiagnostic !== undefined)?.scuffDiagnostic;
        this.finish();
        resolve({
          ...first,
          datasets,
          ...(scuffDiagnostic === undefined ? {} : { scuffDiagnostic }),
          elapsedMs: performance.now() - started,
        });
      }, (error: unknown) => {
        if (this.rejectActive !== reject) return;
        this.finish();
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  cancel(): void {
    for (const worker of this.workers) worker.terminate();
    this.workers = [];
    const reject = this.rejectActive;
    this.rejectActive = undefined;
    reject?.(new DOMException("Simulation cancelled.", "AbortError"));
  }

  dispose(): void { this.cancel(); }

  private finish(): void {
    for (const worker of this.workers) worker.terminate();
    this.workers = [];
    this.rejectActive = undefined;
  }
}

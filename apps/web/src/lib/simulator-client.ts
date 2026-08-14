import type { ParameterValues } from "@phylo-workbench/model-sdk";
import type { SimulatorAnalysisResult } from "@phylo-workbench/model-simulator/browser-source";
import type { SimulatorWorkerRequest, SimulatorWorkerResponse } from "../workers/simulator.worker.js";
import type { RunProgress } from "./diffubar-client.js";

export class SimulatorClient {
  private worker: Worker | undefined;
  private rejectActive: ((error: Error) => void) | undefined;

  async run(_alignment: string, _tree: string, parameters: ParameterValues, onProgress: (progress: RunProgress) => void): Promise<SimulatorAnalysisResult> {
    this.cancel();
    const worker = new Worker(new URL("../workers/simulator.worker.ts", import.meta.url), { type: "module" });
    this.worker = worker;
    const id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `sim-${Date.now()}`;
    return new Promise<SimulatorAnalysisResult>((resolve, reject) => {
      this.rejectActive = reject;
      worker.onmessage = (event: MessageEvent<SimulatorWorkerResponse>) => {
        const message = event.data;
        if (message.id !== id) return;
        if (message.type === "progress") onProgress({ stage: message.stage, fraction: message.fraction, ...message.detail });
        else if (message.type === "result") { this.finish(); resolve(message.result); }
        else { this.finish(); reject(new Error(message.error)); }
      };
      worker.onerror = (event) => {
        event.preventDefault();
        this.finish();
        reject(new Error(event.message || "The simulator worker stopped unexpectedly."));
      };
      const request: SimulatorWorkerRequest = { type: "run", id, parameters };
      worker.postMessage(request);
    });
  }

  cancel(): void {
    this.worker?.terminate();
    this.worker = undefined;
    const reject = this.rejectActive;
    this.rejectActive = undefined;
    reject?.(new DOMException("Simulation cancelled.", "AbortError"));
  }

  dispose(): void { this.cancel(); }

  private finish(): void {
    this.worker?.terminate();
    this.worker = undefined;
    this.rejectActive = undefined;
  }
}

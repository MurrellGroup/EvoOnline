import type { ParameterValues } from "@phylo-workbench/model-sdk";
import type { FubarRunResult, FubarWorkerResponse, WorkerRunRequest } from "../types.js";
import type { RunProgress } from "./diffubar-client.js";

export class FubarClient {
  private worker: Worker | undefined;
  private rejectActive: ((error: Error) => void) | undefined;

  private createWorker(): Worker {
    return new Worker(new URL("../workers/fubar.worker.ts", import.meta.url), { type: "module" });
  }

  run(
    alignment: string,
    tree: string,
    parameters: ParameterValues,
    onProgress: (progress: RunProgress) => void,
  ): Promise<FubarRunResult> {
    this.cancel();
    const worker = this.createWorker();
    this.worker = worker;
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.rejectActive = reject;
      worker.onmessage = (event: MessageEvent<FubarWorkerResponse>) => {
        const message = event.data;
        if (message.id !== id) return;
        if (message.type === "progress") {
          onProgress({ stage: message.stage, fraction: message.fraction, ...(message.detail ?? {}) });
        } else if (message.type === "result") {
          this.finish();
          resolve(message.result);
        } else {
          this.finish();
          reject(new Error(message.error));
        }
      };
      worker.onerror = (event) => {
        this.finish();
        reject(new Error(event.message || "FUBAR worker failed."));
      };
      const request: WorkerRunRequest = { type: "run", id, alignment, tree, parameters };
      worker.postMessage(request);
    });
  }

  cancel(): void {
    if (this.worker === undefined) return;
    this.worker.terminate();
    this.worker = undefined;
    this.rejectActive?.(new DOMException("Analysis cancelled.", "AbortError"));
    this.rejectActive = undefined;
  }

  private finish(): void {
    this.worker?.terminate();
    this.worker = undefined;
    this.rejectActive = undefined;
  }

  dispose(): void {
    this.cancel();
  }
}

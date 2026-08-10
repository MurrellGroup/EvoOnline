import type { DifFubarRunResult, WorkerResponse, WorkerRunRequest } from "../types.js";

export interface RunProgress {
  readonly stage: string;
  readonly fraction: number;
}

export class DifFubarClient {
  private worker: Worker | undefined;
  private rejectActive: ((error: Error) => void) | undefined;

  private createWorker(): Worker {
    return new Worker(new URL("../workers/diffubar.worker.ts", import.meta.url), { type: "module" });
  }

  run(
    alignment: string,
    tree: string,
    parameters: Readonly<Record<string, string | number | boolean>>,
    onProgress: (progress: RunProgress) => void,
  ): Promise<DifFubarRunResult> {
    this.cancel();
    const worker = this.createWorker();
    this.worker = worker;
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.rejectActive = reject;
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const message = event.data;
        if (message.id !== id) return;
        if (message.type === "progress") onProgress({ stage: message.stage, fraction: message.fraction });
        else if (message.type === "result") {
          this.finish();
          resolve(message.result);
        } else {
          this.finish();
          reject(new Error(message.error));
        }
      };
      worker.onerror = (event) => {
        this.finish();
        reject(new Error(event.message || "DifFUBAR worker failed."));
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

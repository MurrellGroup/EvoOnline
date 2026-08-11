import type { ParameterValues } from "@phylo-workbench/model-sdk";
import type { BsrelRunResult, BsrelWorkerResponse, WorkerRunRequest } from "../types.js";
import type { RunProgress } from "./diffubar-client.js";

export class BsrelClient {
  private worker: Worker | undefined;
  private rejectActive: ((error: Error) => void) | undefined;

  run(
    alignment: string,
    tree: string,
    parameters: ParameterValues,
    onProgress: (progress: RunProgress) => void,
  ): Promise<BsrelRunResult> {
    this.cancel();
    const worker = new Worker(new URL("../workers/bsrel.worker.ts", import.meta.url), { type: "module" });
    this.worker = worker;
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.rejectActive = reject;
      worker.onmessage = (event: MessageEvent<BsrelWorkerResponse>) => {
        const message = event.data;
        if (message.id !== id) return;
        if (message.type === "progress") onProgress({ stage: message.stage, fraction: message.fraction, ...(message.detail ?? {}) });
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
        reject(new Error(event.message || "BS-REL worker failed."));
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

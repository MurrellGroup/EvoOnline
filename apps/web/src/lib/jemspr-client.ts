import type { JemsprAnalysisResult } from "@phylo-workbench/model-jemspr/browser-source";
import type { ParameterValues } from "@phylo-workbench/model-sdk";
import type { JemsprWorkerRequest, JemsprWorkerResponse } from "../workers/jemspr.worker.js";
import type { RunProgress } from "./diffubar-client.js";

export class JemsprClient {
  private worker: Worker | undefined;
  private rejectActive: ((error: Error) => void) | undefined;

  run(alignment: string, _tree: string, parameters: ParameterValues, onProgress: (progress: RunProgress) => void): Promise<JemsprAnalysisResult> {
    this.cancel();
    const worker = new Worker(new URL("../workers/jemspr.worker.ts", import.meta.url), { type: "module" });
    this.worker = worker;
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.rejectActive = reject;
      worker.onmessage = (event: MessageEvent<JemsprWorkerResponse>) => {
        const message = event.data;
        if (message.id !== id) return;
        if (message.type === "progress") onProgress({ stage: message.stage, fraction: message.fraction, ...(message.detail ?? {}) });
        else if (message.type === "result") { this.finish(); resolve(message.result); }
        else { this.finish(); reject(new Error(message.error)); }
      };
      worker.onerror = (event) => { this.finish(); reject(new Error(event.message || "JEMSPR worker failed.")); };
      const request: JemsprWorkerRequest = { type: "run", id, alignment, parameters };
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

  dispose(): void { this.cancel(); }
}

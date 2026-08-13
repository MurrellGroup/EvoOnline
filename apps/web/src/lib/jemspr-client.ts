import type { JemsprAnalysisResult } from "@phylo-workbench/model-jemspr/browser-source";
import type { ParameterValues } from "@phylo-workbench/model-sdk";
import type { JemsprWorkerRequest, JemsprWorkerResponse } from "../workers/jemspr.worker.js";
import type { RunProgress } from "./diffubar-client.js";

export class JemsprClient {
  private worker: Worker | undefined;
  private rejectActive: ((error: Error) => void) | undefined;
  private generation = 0;
  private startupTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly workerFactory?: () => Worker) {}

  private createWorker(): Worker {
    return this.workerFactory?.() ?? new Worker(new URL("../workers/jemspr.worker.ts", import.meta.url), { type: "module" });
  }

  run(alignment: string, _tree: string, parameters: ParameterValues, onProgress: (progress: RunProgress) => void): Promise<JemsprAnalysisResult> {
    this.cancel();
    return new Promise((resolve, reject) => {
      const generation = ++this.generation;
      const id = typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `jemspr-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      let worker: Worker;
      try {
        onProgress({ stage: "jemspr-worker-startup", fraction: 0, message: "Starting the dedicated JEMSPR worker", indeterminate: true });
        worker = this.createWorker();
      } catch (error) {
        reject(new Error(`JEMSPR worker could not be started: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      this.worker = worker;
      this.rejectActive = reject;
      this.startupTimer = setTimeout(() => {
        if (this.worker !== worker || generation !== this.generation) return;
        this.finish(worker);
        reject(new Error("JEMSPR worker did not initialize within 15 seconds. Reload the page once; if this persists, verify that the hashed worker asset was deployed with the main app bundle."));
      }, 15_000);
      const acknowledgeStartup = (): void => {
        this.clearStartupTimer();
      };
      worker.onmessage = (event: MessageEvent<JemsprWorkerResponse>) => {
        const message = event.data;
        if (message.id !== id) return;
        acknowledgeStartup();
        if (this.worker !== worker || generation !== this.generation) return;
        if (message.type === "progress") onProgress({ stage: message.stage, fraction: message.fraction, ...(message.detail ?? {}) });
        else if (message.type === "result") { this.finish(worker); resolve(message.result); }
        else { this.finish(worker); reject(new Error(message.error || "JEMSPR worker reported an unspecified error.")); }
      };
      worker.onerror = (event) => {
        event.preventDefault();
        acknowledgeStartup();
        if (this.worker !== worker || generation !== this.generation) return;
        this.finish(worker);
        const detail = event.message.trim();
        reject(new Error(detail.length > 0
          ? `JEMSPR worker crashed: ${detail}`
          : "JEMSPR worker was terminated by the browser. This can indicate memory pressure; the bounded streaming search should prevent it, but reducing rooted-tree graph/root-placement budgets is a safe diagnostic."));
      };
      worker.onmessageerror = () => {
        acknowledgeStartup();
        if (this.worker !== worker || generation !== this.generation) return;
        this.finish(worker);
        reject(new Error("The browser could not decode the JEMSPR worker response."));
      };
      const request: JemsprWorkerRequest = { type: "run", id, alignment, parameters };
      try {
        worker.postMessage(request);
      } catch (error) {
        acknowledgeStartup();
        this.finish(worker);
        reject(new Error(`JEMSPR request could not be sent to its worker: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  }

  cancel(): void {
    const worker = this.worker;
    const reject = this.rejectActive;
    this.generation += 1;
    this.worker = undefined;
    this.rejectActive = undefined;
    this.clearStartupTimer();
    worker?.terminate();
    reject?.(new DOMException("Analysis cancelled.", "AbortError"));
  }

  private finish(worker: Worker): void {
    if (this.worker !== worker) return;
    worker.terminate();
    this.worker = undefined;
    this.rejectActive = undefined;
    this.clearStartupTimer();
  }

  private clearStartupTimer(): void {
    if (this.startupTimer === undefined) return;
    clearTimeout(this.startupTimer);
    this.startupTimer = undefined;
  }

  dispose(): void { this.cancel(); }
}

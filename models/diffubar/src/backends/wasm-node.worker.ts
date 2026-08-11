import { parentPort, workerData } from "node:worker_threads";
import { WasmBackend } from "./wasm.js";
import type { BranchMixtureLikelihoodRequest, BsrelKernelRequest, LikelihoodRequest } from "../types.js";

const backend = new WasmBackend((workerData as { readonly wasmModule?: WebAssembly.Module }).wasmModule);
parentPort?.on("message", (message: {
  readonly id: number;
  readonly kind?: "likelihood" | "branch-mixture" | "bsrel";
  readonly request: LikelihoodRequest | BranchMixtureLikelihoodRequest | BsrelKernelRequest;
}) => {
  void (async () => {
    try {
      if (message.kind === "bsrel") {
        const result = await backend.evaluateBsrel(message.request as BsrelKernelRequest);
        parentPort?.postMessage(
          { id: message.id, objectives: result.objectives, elapsedMs: result.elapsedMs },
          [result.objectives.buffer as ArrayBuffer],
        );
      } else if (message.kind === "branch-mixture") {
        const result = await backend.evaluateBranchMixture(message.request as BranchMixtureLikelihoodRequest);
        parentPort?.postMessage(
          { id: message.id, logLikelihoods: result.logLikelihoods, elapsedMs: result.elapsedMs },
          [result.logLikelihoods.buffer as ArrayBuffer],
        );
      } else {
        const result = await backend.evaluate(message.request as LikelihoodRequest);
        parentPort?.postMessage(
          { id: message.id, logLikelihoods: result.logLikelihoods, elapsedMs: result.elapsedMs },
          [result.logLikelihoods.buffer as ArrayBuffer],
        );
      }
    } catch (error) {
      parentPort?.postMessage({
        id: message.id,
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      });
    }
  })();
});

import { parentPort, workerData } from "node:worker_threads";
import { WasmBackend } from "./wasm.js";
import type { LikelihoodRequest } from "../types.js";

const backend = new WasmBackend((workerData as { readonly wasmModule?: WebAssembly.Module }).wasmModule);
parentPort?.on("message", (message: { readonly id: number; readonly request: LikelihoodRequest }) => {
  void (async () => {
    try {
      const result = await backend.evaluate(message.request);
      parentPort?.postMessage(
        { id: message.id, logLikelihoods: result.logLikelihoods, elapsedMs: result.elapsedMs },
        [result.logLikelihoods.buffer as ArrayBuffer],
      );
    } catch (error) {
      parentPort?.postMessage({
        id: message.id,
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      });
    }
  })();
});

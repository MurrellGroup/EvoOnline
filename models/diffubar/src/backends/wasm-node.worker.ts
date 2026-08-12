import { parentPort, workerData } from "node:worker_threads";
import { WasmBackend } from "./wasm.js";
import type { BranchMixtureLikelihoodRequest, BsrelKernelRequest, CladeShiftKernelRequest, FlavorInterpolatedLikelihoodRequest, GlobalGammaMessageRequest, LikelihoodRequest } from "../types.js";

const backend = new WasmBackend((workerData as { readonly wasmModule?: WebAssembly.Module }).wasmModule);
parentPort?.on("message", (message: {
  readonly id: number;
  readonly kind?: "likelihood" | "branch-mixture" | "flavor-interpolated" | "bsrel" | "global-gamma" | "clade-shift";
  readonly request: LikelihoodRequest | BranchMixtureLikelihoodRequest | FlavorInterpolatedLikelihoodRequest | BsrelKernelRequest | GlobalGammaMessageRequest | CladeShiftKernelRequest;
}) => {
  void (async () => {
    try {
      if (message.kind === "clade-shift") {
        const result = await backend.evaluateCladeShift(message.request as CladeShiftKernelRequest);
        parentPort?.postMessage(
          { id: message.id, cladeShiftValues: result.logLikelihoodRatios, elapsedMs: result.elapsedMs },
          [result.logLikelihoodRatios.buffer as ArrayBuffer],
        );
      } else if (message.kind === "global-gamma") {
        const result = await backend.evaluateGlobalGammaMessages(message.request as GlobalGammaMessageRequest);
        const values = new Float64Array(result.siteLogLikelihoods.length + result.cappedEdgeLogLikelihoods.length + result.positiveEdgeLogLikelihoods.length);
        values.set(result.siteLogLikelihoods, 0);
        values.set(result.cappedEdgeLogLikelihoods, result.siteLogLikelihoods.length);
        values.set(result.positiveEdgeLogLikelihoods, result.siteLogLikelihoods.length + result.cappedEdgeLogLikelihoods.length);
        parentPort?.postMessage({ id: message.id, globalGammaValues: values, elapsedMs: result.elapsedMs }, [values.buffer as ArrayBuffer]);
      } else if (message.kind === "bsrel") {
        const result = await backend.evaluateBsrel(message.request as BsrelKernelRequest);
        parentPort?.postMessage(
          { id: message.id, objectives: result.objectives, elapsedMs: result.elapsedMs },
          [result.objectives.buffer as ArrayBuffer],
        );
      } else if (message.kind === "flavor-interpolated") {
        const result = await backend.evaluateFlavorInterpolated(message.request as FlavorInterpolatedLikelihoodRequest);
        parentPort?.postMessage(
          { id: message.id, logLikelihoods: result.logLikelihoods, elapsedMs: result.elapsedMs },
          [result.logLikelihoods.buffer as ArrayBuffer],
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

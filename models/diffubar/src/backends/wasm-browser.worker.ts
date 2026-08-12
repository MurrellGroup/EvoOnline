import { WasmBackend } from "./wasm.js";
import type { BranchMixtureLikelihoodRequest, BsrelKernelRequest, CladeShiftKernelRequest, FlavorInterpolatedLikelihoodRequest, GlobalGammaMessageRequest, LikelihoodRequest } from "../types.js";

interface InitializeMessage {
  readonly type: "initialize";
  readonly wasmModule: WebAssembly.Module;
}

interface RequestMessage {
  readonly id: number;
  readonly kind?: "likelihood" | "branch-mixture" | "flavor-interpolated" | "bsrel" | "global-gamma" | "clade-shift";
  readonly request: LikelihoodRequest | BranchMixtureLikelihoodRequest | FlavorInterpolatedLikelihoodRequest | BsrelKernelRequest | GlobalGammaMessageRequest | CladeShiftKernelRequest;
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<InitializeMessage | RequestMessage>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;
let backend: WasmBackend | undefined;
scope.onmessage = (event: MessageEvent<InitializeMessage | RequestMessage>) => {
  const message = event.data;
  if ("type" in message && message.type === "initialize") {
    backend = new WasmBackend(message.wasmModule);
    void backend.prepare().then(() => scope.postMessage({ type: "ready" })).catch((error) => scope.postMessage({
      type: "ready",
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    }));
    return;
  }
  const requestMessage = message as RequestMessage;
  void (async () => {
    try {
      if (backend === undefined) throw new Error("Parallel WASM worker was not initialized.");
      if (requestMessage.kind === "clade-shift") {
        const result = await backend.evaluateCladeShift(requestMessage.request as CladeShiftKernelRequest);
        scope.postMessage(
          { id: requestMessage.id, cladeShiftValues: result.logLikelihoodRatios, elapsedMs: result.elapsedMs },
          [result.logLikelihoodRatios.buffer as ArrayBuffer],
        );
      } else if (requestMessage.kind === "global-gamma") {
        const result = await backend.evaluateGlobalGammaMessages(requestMessage.request as GlobalGammaMessageRequest);
        const values = new Float64Array(result.siteLogLikelihoods.length + result.cappedEdgeLogLikelihoods.length + result.positiveEdgeLogLikelihoods.length);
        values.set(result.siteLogLikelihoods, 0);
        values.set(result.cappedEdgeLogLikelihoods, result.siteLogLikelihoods.length);
        values.set(result.positiveEdgeLogLikelihoods, result.siteLogLikelihoods.length + result.cappedEdgeLogLikelihoods.length);
        scope.postMessage({ id: requestMessage.id, globalGammaValues: values, elapsedMs: result.elapsedMs }, [values.buffer as ArrayBuffer]);
      } else if (requestMessage.kind === "bsrel") {
        const result = await backend.evaluateBsrel(requestMessage.request as BsrelKernelRequest);
        scope.postMessage(
          { id: requestMessage.id, objectives: result.objectives, elapsedMs: result.elapsedMs },
          [result.objectives.buffer as ArrayBuffer],
        );
      } else if (requestMessage.kind === "flavor-interpolated") {
        const result = await backend.evaluateFlavorInterpolated(requestMessage.request as FlavorInterpolatedLikelihoodRequest);
        scope.postMessage(
          { id: requestMessage.id, logLikelihoods: result.logLikelihoods, elapsedMs: result.elapsedMs },
          [result.logLikelihoods.buffer as ArrayBuffer],
        );
      } else if (requestMessage.kind === "branch-mixture") {
        const result = await backend.evaluateBranchMixture(requestMessage.request as BranchMixtureLikelihoodRequest);
        scope.postMessage(
          { id: requestMessage.id, logLikelihoods: result.logLikelihoods, elapsedMs: result.elapsedMs },
          [result.logLikelihoods.buffer as ArrayBuffer],
        );
      } else {
        const result = await backend.evaluate(requestMessage.request as LikelihoodRequest);
        scope.postMessage(
          { id: requestMessage.id, logLikelihoods: result.logLikelihoods, elapsedMs: result.elapsedMs },
          [result.logLikelihoods.buffer as ArrayBuffer],
        );
      }
    } catch (error) {
      scope.postMessage({
        id: requestMessage.id,
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      });
    }
  })();
};

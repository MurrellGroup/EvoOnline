import { WasmBackend } from "./wasm.js";
import type { BsrelKernelRequest, LikelihoodRequest } from "../types.js";

interface InitializeMessage {
  readonly type: "initialize";
  readonly wasmModule: WebAssembly.Module;
}

interface RequestMessage {
  readonly id: number;
  readonly kind?: "likelihood" | "bsrel";
  readonly request: LikelihoodRequest | BsrelKernelRequest;
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
      if (requestMessage.kind === "bsrel") {
        const result = await backend.evaluateBsrel(requestMessage.request as BsrelKernelRequest);
        scope.postMessage(
          { id: requestMessage.id, objectives: result.objectives, elapsedMs: result.elapsedMs },
          [result.objectives.buffer as ArrayBuffer],
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

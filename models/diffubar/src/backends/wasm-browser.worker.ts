import { WasmBackend } from "./wasm.js";
import type { LikelihoodRequest } from "../types.js";

interface InitializeMessage {
  readonly type: "initialize";
  readonly wasmModule: WebAssembly.Module;
}

interface RequestMessage {
  readonly id: number;
  readonly request: LikelihoodRequest;
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
      const result = await backend.evaluate(requestMessage.request);
      scope.postMessage(
        { id: requestMessage.id, logLikelihoods: result.logLikelihoods, elapsedMs: result.elapsedMs },
        [result.logLikelihoods.buffer as ArrayBuffer],
      );
    } catch (error) {
      scope.postMessage({
        id: requestMessage.id,
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      });
    }
  })();
};

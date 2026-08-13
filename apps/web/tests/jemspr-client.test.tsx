import assert from "node:assert/strict";
import test from "node:test";
import type { JemsprAnalysisResult } from "@phylo-workbench/model-jemspr/browser-source";
import { JemsprClient } from "../src/lib/jemspr-client.js";
import type { JemsprWorkerRequest, JemsprWorkerResponse } from "../src/workers/jemspr.worker.js";

class FakeWorker {
  onmessage: ((event: MessageEvent<JemsprWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  terminated = false;

  constructor(private readonly respond: (worker: FakeWorker, request: JemsprWorkerRequest) => void) {}

  postMessage(request: JemsprWorkerRequest): void {
    this.respond(this, request);
  }

  terminate(): void { this.terminated = true; }

  message(message: JemsprWorkerResponse): void {
    this.onmessage?.({ data: message } as MessageEvent<JemsprWorkerResponse>);
  }

  fail(message = ""): void {
    this.onerror?.({ message, preventDefault: () => undefined } as ErrorEvent);
  }
}

const fakeResult = {
  method: "jemspr",
  schemaVersion: 1,
  network: { templates: [], occurrences: [], runs: [] },
} as unknown as JemsprAnalysisResult;

test("JEMSPR browser client reports worker progress and resolves the matching result", async () => {
  let worker: FakeWorker | undefined;
  const progress: string[] = [];
  const client = new JemsprClient(() => {
    worker = new FakeWorker((current, request) => queueMicrotask(() => {
      current.message({ type: "progress", id: request.id, stage: "jemspr-initialization", fraction: 0.5, detail: { message: "parsed" } });
      current.message({ type: "result", id: request.id, result: fakeResult });
    }));
    return worker as unknown as Worker;
  });
  const result = await client.run(">a\nA\n>b\nA\n>c\nG\n>d\nG\n", "", {}, (entry) => progress.push(entry.stage));
  assert.equal(result, fakeResult);
  assert.deepEqual(progress, ["jemspr-worker-startup", "jemspr-initialization"]);
  assert.equal(worker?.terminated, true);
});

test("JEMSPR browser client turns a message-less worker death into an actionable error", async () => {
  const client = new JemsprClient(() => new FakeWorker((worker) => queueMicrotask(() => worker.fail())) as unknown as Worker);
  await assert.rejects(
    client.run(">a\nA\n>b\nA\n>c\nG\n>d\nG\n", "", {}, () => undefined),
    /terminated by the browser.*memory pressure/i,
  );
});

test("cancelling JEMSPR invalidates late messages from the old worker", async () => {
  let worker: FakeWorker | undefined;
  const client = new JemsprClient(() => {
    worker = new FakeWorker(() => undefined);
    return worker as unknown as Worker;
  });
  const pending = client.run(">a\nA\n>b\nA\n>c\nG\n>d\nG\n", "", {}, () => undefined);
  client.cancel();
  await assert.rejects(pending, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
  assert.equal(worker?.terminated, true);
});

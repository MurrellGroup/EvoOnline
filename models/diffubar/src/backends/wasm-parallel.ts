import type { LikelihoodRequest, LikelihoodResult, RuntimeWorkload } from "../types.js";
import { WasmBackend, compileWasmModule } from "./wasm.js";

interface WorkerMessage {
  readonly id?: number;
  readonly type?: "ready";
  readonly logLikelihoods?: Float64Array;
  readonly error?: string;
}

interface WorkerLike {
  postMessage(message: unknown): void;
  terminate(): unknown;
  addEventListener?: (type: "message", listener: (event: MessageEvent<WorkerMessage>) => void) => void;
  removeEventListener?: (type: "message", listener: (event: MessageEvent<WorkerMessage>) => void) => void;
  on?: (type: "message", listener: (message: WorkerMessage) => void) => void;
  off?: (type: "message", listener: (message: WorkerMessage) => void) => void;
  unref?: () => void;
}

function defaultWorkerCount(): number {
  const hardware = typeof navigator === "undefined" ? 4 : navigator.hardwareConcurrency;
  return Math.max(1, Math.min(16, hardware || 4));
}

async function createWorker(wasmModule: WebAssembly.Module): Promise<WorkerLike> {
  if (typeof process !== "undefined" && process.versions?.node) {
    const { Worker: NodeWorker } = await import("node:worker_threads");
    const worker = new NodeWorker(new URL("./wasm-node.worker.js", import.meta.url), {
      workerData: { wasmModule },
    }) as unknown as WorkerLike;
    worker.unref?.();
    return worker;
  }
  const worker = new Worker(new URL("./wasm-browser.worker.js", import.meta.url), { type: "module" });
  await new Promise<void>((resolve, reject) => {
    const ready = (event: MessageEvent<WorkerMessage>): void => {
      if (event.data.type !== "ready") return;
      worker.removeEventListener("message", ready);
      if (event.data.error !== undefined) reject(new Error(event.data.error));
      else resolve();
    };
    worker.addEventListener("message", ready);
    worker.postMessage({ type: "initialize", wasmModule });
  });
  return worker;
}

/** Persistent site-parallel WASM pool; small optimizer requests stay local. */
export class ParallelWasmBackend {
  readonly kind = "wasm-parallel" as const;
  private readonly local = new WasmBackend();
  private workersPromise: Promise<WorkerLike[]> | undefined;
  private nextMessageId = 1;

  constructor(
    readonly workerCount = defaultWorkerCount(),
    private readonly minimumCategorySites = 150_000,
  ) {}

  private workers(): Promise<WorkerLike[]> {
    this.workersPromise ??= compileWasmModule().then((wasmModule) =>
      Promise.all(Array.from({ length: this.workerCount }, () => createWorker(wasmModule))),
    );
    return this.workersPromise;
  }

  /** Compile once and fully initialize either the local engine or worker pool. */
  async prepare(workload?: RuntimeWorkload): Promise<void> {
    const categorySites = workload === undefined ? Infinity : workload.categoryCount * workload.siteCount;
    const siteCount = workload?.siteCount ?? 2;
    if (this.workerCount <= 1 || categorySites < this.minimumCategorySites || siteCount < 2) {
      await this.local.prepare(workload);
      return;
    }
    await this.workers();
  }

  private call(worker: WorkerLike, request: LikelihoodRequest): Promise<Float64Array> {
    const id = this.nextMessageId++;
    return new Promise((resolve, reject) => {
      const receive = (message: WorkerMessage): void => {
        if (message.id !== id) return;
        cleanup();
        if (message.error !== undefined) reject(new Error(message.error));
        else if (message.logLikelihoods === undefined) reject(new Error("Parallel WASM worker returned no likelihood matrix."));
        else resolve(message.logLikelihoods);
      };
      const receiveEvent = (event: MessageEvent<WorkerMessage>): void => receive(event.data);
      const cleanup = (): void => {
        worker.removeEventListener?.("message", receiveEvent);
        worker.off?.("message", receive);
      };
      worker.addEventListener?.("message", receiveEvent);
      worker.on?.("message", receive);
      worker.postMessage({ id, request });
    });
  }

  async evaluate(request: LikelihoodRequest): Promise<LikelihoodResult> {
    request.signal?.throwIfAborted();
    const categoryCount = request.grid.categoryCount;
    const categorySites = categoryCount * request.siteCount;
    if (this.workerCount <= 1 || categorySites < this.minimumCategorySites || request.siteCount < 2) {
      return this.local.evaluate(request);
    }
    const started = performance.now();
    request.onProgress?.(0, {
      message: `Starting ${Math.min(this.workerCount, request.siteCount)} parallel WASM workers`,
      current: 0,
      total: categorySites,
      indeterminate: true,
    });
    const pool = await this.workers();
    const activeCount = Math.min(pool.length, request.siteCount);
    request.onProgress?.(0, {
      message: `0/${request.siteCount.toLocaleString()} site blocks complete · ${categoryCount.toLocaleString()} categories per site`,
      current: 0,
      total: categorySites,
      indeterminate: true,
    });
    const jobs: Array<{ readonly start: number; readonly count: number; readonly result: Promise<Float64Array> }> = [];
    for (let index = 0; index < activeCount; index += 1) {
      const start = Math.floor(index * request.siteCount / activeCount);
      const end = Math.floor((index + 1) * request.siteCount / activeCount);
      const count = end - start;
      const tips = new Uint8Array(request.tree.tipCount * count);
      for (let tip = 0; tip < request.tree.tipCount; tip += 1) {
        tips.set(
          request.tipStates.subarray(tip * request.siteCount + start, tip * request.siteCount + end),
          tip * count,
        );
      }
      const workerRequest: LikelihoodRequest = {
        tree: request.tree,
        tipStates: tips,
        siteCount: count,
        grid: request.grid,
        models: request.models,
        equilibrium: request.equilibrium,
        ...(request.poissonTerms === undefined ? {} : { poissonTerms: request.poissonTerms }),
        ...(request.maxLambdaPerStep === undefined ? {} : { maxLambdaPerStep: request.maxLambdaPerStep }),
      };
      jobs.push({ start, count, result: this.call(pool[index]!, workerRequest) });
    }
    let completedSites = 0;
    const pieces = await Promise.all(jobs.map(async (job) => {
      const piece = await job.result;
      completedSites += job.count;
      request.onProgress?.(completedSites / request.siteCount, {
        message: `${completedSites.toLocaleString()}/${request.siteCount.toLocaleString()} site blocks complete · ${categoryCount.toLocaleString()} categories per site`,
        current: completedSites * categoryCount,
        total: categorySites,
      });
      return piece;
    }));
    request.signal?.throwIfAborted();
    const logLikelihoods = new Float64Array(request.grid.categoryCount * request.siteCount);
    for (let job = 0; job < jobs.length; job += 1) {
      const { start, count } = jobs[job]!;
      const piece = pieces[job]!;
      for (let category = 0; category < request.grid.categoryCount; category += 1) {
        logLikelihoods.set(
          piece.subarray(category * count, (category + 1) * count),
          category * request.siteCount + start,
        );
      }
    }
    return {
      logLikelihoods,
      backend: "wasm-parallel",
      elapsedMs: performance.now() - started,
      precision: "f64",
    };
  }

  async dispose(): Promise<void> {
    if (this.workersPromise === undefined) return;
    const workers = await this.workersPromise;
    await Promise.all(workers.map(async (worker) => { await worker.terminate(); }));
    this.workersPromise = undefined;
  }
}

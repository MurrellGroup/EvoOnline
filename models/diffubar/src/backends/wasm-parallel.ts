import type {
  BranchMixtureLikelihoodRequest,
  CladeShiftKernelRequest,
  CladeShiftKernelResult,
  FlavorInterpolatedLikelihoodRequest,
  BsrelKernelRequest,
  BsrelKernelResult,
  GlobalGammaMessageRequest,
  GlobalGammaMessageResult,
  LikelihoodRequest,
  LikelihoodResult,
  ModelBank,
  RuntimeWorkload,
} from "../types.js";
import { WasmBackend, compileWasmModule } from "./wasm.js";

interface WorkerMessage {
  readonly id?: number;
  readonly type?: "ready";
  readonly logLikelihoods?: Float64Array;
  readonly objectives?: Float64Array;
  readonly globalGammaValues?: Float64Array;
  readonly cladeShiftValues?: Float64Array;
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

/**
 * Category-parallel interpolation workers only need the atomic rate models
 * referenced by their own Gamma distributions. Sending the complete model
 * bank to every worker multiplies both structured-clone traffic and retained
 * memory by the worker count, which is particularly costly for Glamma's
 * coarse global parameter scan.
 */
function compactModelBank(
  models: ModelBank,
  sourceComponents: Uint32Array,
): { readonly models: ModelBank; readonly componentModels: Uint32Array } {
  const oldIds: number[] = [];
  const newIdByOld = new Map<number, number>();
  const componentModels = new Uint32Array(sourceComponents.length);
  for (let entry = 0; entry < sourceComponents.length; entry += 1) {
    const oldId = sourceComponents[entry]!;
    let newId = newIdByOld.get(oldId);
    if (newId === undefined) {
      if (oldId >= models.modelCount) throw new RangeError(`Atomic model id ${oldId} is outside the model bank.`);
      newId = oldIds.length;
      oldIds.push(oldId);
      newIdByOld.set(oldId, newId);
    }
    componentModels[entry] = newId;
  }
  if (oldIds.length === models.modelCount) return { models, componentModels };
  const diagonalStride = models.stateCount;
  const offDiagonalStride = models.stateCount * models.maxNeighbors;
  const rDiagonal = new Float64Array(oldIds.length * diagonalStride);
  const rOffDiagonal = new Float64Array(oldIds.length * offDiagonalStride);
  const mu = new Float64Array(oldIds.length);
  const modelAlpha = new Float64Array(oldIds.length);
  const modelOmega = new Float64Array(oldIds.length);
  for (let newId = 0; newId < oldIds.length; newId += 1) {
    const oldId = oldIds[newId]!;
    rDiagonal.set(models.rDiagonal.subarray(oldId * diagonalStride, (oldId + 1) * diagonalStride), newId * diagonalStride);
    rOffDiagonal.set(
      models.rOffDiagonal.subarray(oldId * offDiagonalStride, (oldId + 1) * offDiagonalStride),
      newId * offDiagonalStride,
    );
    mu[newId] = models.mu[oldId]!;
    modelAlpha[newId] = models.modelAlpha[oldId]!;
    modelOmega[newId] = models.modelOmega[oldId]!;
  }
  return {
    componentModels,
    models: {
      stateCount: models.stateCount,
      maxNeighbors: models.maxNeighbors,
      modelCount: oldIds.length,
      neighborCount: models.neighborCount,
      neighborIndex: models.neighborIndex,
      rDiagonal,
      rOffDiagonal,
      mu,
      modelAlpha,
      modelOmega,
      gridModels: Uint32Array.from(oldIds, (_oldId, newId) => newId),
    },
  };
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
      worker.postMessage({ id, kind: "likelihood", request });
    });
  }

  private callBranchMixture(worker: WorkerLike, request: BranchMixtureLikelihoodRequest): Promise<Float64Array> {
    const id = this.nextMessageId++;
    return new Promise((resolve, reject) => {
      const receive = (message: WorkerMessage): void => {
        if (message.id !== id) return;
        cleanup();
        if (message.error !== undefined) reject(new Error(message.error));
        else if (message.logLikelihoods === undefined) reject(new Error("Parallel WASM worker returned no branch-mixture likelihood matrix."));
        else resolve(message.logLikelihoods);
      };
      const receiveEvent = (event: MessageEvent<WorkerMessage>): void => receive(event.data);
      const cleanup = (): void => {
        worker.removeEventListener?.("message", receiveEvent);
        worker.off?.("message", receive);
      };
      worker.addEventListener?.("message", receiveEvent);
      worker.on?.("message", receive);
      worker.postMessage({ id, kind: "branch-mixture", request });
    });
  }

  private callFlavorInterpolated(worker: WorkerLike, request: FlavorInterpolatedLikelihoodRequest): Promise<Float64Array> {
    const id = this.nextMessageId++;
    return new Promise((resolve, reject) => {
      const receive = (message: WorkerMessage): void => {
        if (message.id !== id) return;
        cleanup();
        if (message.error !== undefined) reject(new Error(message.error));
        else if (message.logLikelihoods === undefined) reject(new Error("Parallel WASM worker returned no interpolated FLAVOR likelihood matrix."));
        else resolve(message.logLikelihoods);
      };
      const receiveEvent = (event: MessageEvent<WorkerMessage>): void => receive(event.data);
      const cleanup = (): void => {
        worker.removeEventListener?.("message", receiveEvent);
        worker.off?.("message", receive);
      };
      worker.addEventListener?.("message", receiveEvent);
      worker.on?.("message", receive);
      worker.postMessage({ id, kind: "flavor-interpolated", request });
    });
  }

  private callBsrel(worker: WorkerLike, request: BsrelKernelRequest): Promise<Float64Array> {
    const id = this.nextMessageId++;
    return new Promise((resolve, reject) => {
      const receive = (message: WorkerMessage): void => {
        if (message.id !== id) return;
        cleanup();
        if (message.error !== undefined) reject(new Error(message.error));
        else if (message.objectives === undefined) reject(new Error("Parallel WASM worker returned no BS-REL objectives."));
        else resolve(message.objectives);
      };
      const receiveEvent = (event: MessageEvent<WorkerMessage>): void => receive(event.data);
      const cleanup = (): void => {
        worker.removeEventListener?.("message", receiveEvent);
        worker.off?.("message", receive);
      };
      worker.addEventListener?.("message", receiveEvent);
      worker.on?.("message", receive);
      worker.postMessage({ id, kind: "bsrel", request });
    });
  }

  private callGlobalGamma(worker: WorkerLike, request: GlobalGammaMessageRequest): Promise<Float64Array> {
    const id = this.nextMessageId++;
    return new Promise((resolve, reject) => {
      const receive = (message: WorkerMessage): void => {
        if (message.id !== id) return;
        cleanup();
        if (message.error !== undefined) reject(new Error(message.error));
        else if (message.globalGammaValues === undefined) reject(new Error("Parallel WASM worker returned no Glamma messages."));
        else resolve(message.globalGammaValues);
      };
      const receiveEvent = (event: MessageEvent<WorkerMessage>): void => receive(event.data);
      const cleanup = (): void => {
        worker.removeEventListener?.("message", receiveEvent);
        worker.off?.("message", receive);
      };
      worker.addEventListener?.("message", receiveEvent);
      worker.on?.("message", receive);
      worker.postMessage({ id, kind: "global-gamma", request });
    });
  }

  private callCladeShift(worker: WorkerLike, request: CladeShiftKernelRequest): Promise<Float64Array> {
    const id = this.nextMessageId++;
    return new Promise((resolve, reject) => {
      const receive = (message: WorkerMessage): void => {
        if (message.id !== id) return;
        cleanup();
        if (message.error !== undefined) reject(new Error(message.error));
        else if (message.cladeShiftValues === undefined) reject(new Error("Parallel WASM worker returned no CladeShift likelihood ratios."));
        else resolve(message.cladeShiftValues);
      };
      const receiveEvent = (event: MessageEvent<WorkerMessage>): void => receive(event.data);
      const cleanup = (): void => {
        worker.removeEventListener?.("message", receiveEvent);
        worker.off?.("message", receive);
      };
      worker.addEventListener?.("message", receiveEvent);
      worker.on?.("message", receive);
      worker.postMessage({ id, kind: "clade-shift", request });
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

  async evaluateBranchMixture(request: BranchMixtureLikelihoodRequest): Promise<LikelihoodResult> {
    request.signal?.throwIfAborted();
    const operatorSites = request.operators.operatorCount * request.siteCount;
    if (this.workerCount <= 1 || operatorSites < this.minimumCategorySites || request.siteCount < 2) {
      return this.local.evaluateBranchMixture(request);
    }
    const started = performance.now();
    const pool = await this.workers();
    // Typed model arrays are cloned into each ordinary Web Worker on hosts
    // without cross-origin isolation (including GitHub Pages). Bound aggregate
    // copies so FLAVOR's atomic omega bank cannot exhaust browser memory.
    const modelBytes = request.models.rDiagonal.byteLength + request.models.rOffDiagonal.byteLength
      + request.models.mu.byteLength + request.models.neighborCount.byteLength + request.models.neighborIndex.byteLength;
    const memoryBoundWorkers = Math.max(1, Math.floor((192 * 1024 * 1024) / Math.max(1, modelBytes)));
    // Branch-mixture grids are far wider than ordinary FUBAR grids. Partition
    // categories, not sites: every worker then fills the 16-site SIMD block and
    // avoids repeating the entire operator grid for one or two demo sites.
    const activeCount = Math.min(pool.length, request.grid.categoryCount, memoryBoundWorkers);
    request.onProgress?.(0, {
      message: `Starting ${activeCount.toLocaleString()} category-parallel branch-mixture workers · ${request.operators.operatorCount.toLocaleString()} operators`,
      current: 0,
      total: operatorSites,
      indeterminate: true,
    });
    const jobs: Array<{ readonly start: number; readonly count: number; readonly operatorCount: number; readonly result: Promise<Float64Array> }> = [];
    for (let index = 0; index < activeCount; index += 1) {
      const start = Math.floor(index * request.grid.categoryCount / activeCount);
      const end = Math.floor((index + 1) * request.grid.categoryCount / activeCount);
      const count = end - start;
      const operatorsPerCategory = request.operators.operatorsPerCategory;
      const operatorStart = start * operatorsPerCategory;
      const operatorEnd = end * operatorsPerCategory;
      const componentStart = request.operators.operatorOffsets[operatorStart]!;
      const componentEnd = request.operators.operatorOffsets[operatorEnd]!;
      const operatorOffsets = new Uint32Array(operatorEnd - operatorStart + 1);
      for (let operator = operatorStart; operator <= operatorEnd; operator += 1) {
        operatorOffsets[operator - operatorStart] = request.operators.operatorOffsets[operator]! - componentStart;
      }
      const grid = {
        ...request.grid,
        categories: request.grid.categories.slice(start * request.grid.parameterCount, end * request.grid.parameterCount),
        categoryCount: count,
      };
      const workerRequest: BranchMixtureLikelihoodRequest = {
        tree: request.tree,
        tipStates: request.tipStates,
        siteCount: request.siteCount,
        grid,
        models: request.models,
        operators: {
          operatorCount: operatorEnd - operatorStart,
          operatorOffsets,
          componentModels: request.operators.componentModels.slice(componentStart, componentEnd),
          componentWeights: request.operators.componentWeights.slice(componentStart, componentEnd),
          operatorScales: request.operators.operatorScales.slice(operatorStart, operatorEnd),
          operatorsPerCategory,
          collapseWeights: request.operators.collapseWeights.slice(operatorStart, operatorEnd),
          collapseMode: request.operators.collapseMode,
        },
        equilibrium: request.equilibrium,
        ...(request.poissonTerms === undefined ? {} : { poissonTerms: request.poissonTerms }),
        ...(request.maxLambdaPerStep === undefined ? {} : { maxLambdaPerStep: request.maxLambdaPerStep }),
      };
      jobs.push({ start, count, operatorCount: operatorEnd - operatorStart, result: this.callBranchMixture(pool[index]!, workerRequest) });
    }
    let completedOperators = 0;
    const pieces = await Promise.all(jobs.map(async (job) => {
      const piece = await job.result;
      completedOperators += job.operatorCount;
      request.onProgress?.(completedOperators / request.operators.operatorCount, {
        message: `${completedOperators.toLocaleString()}/${request.operators.operatorCount.toLocaleString()} branch-mixture operators complete · all codon sites`,
        current: completedOperators * request.siteCount,
        total: operatorSites,
      });
      return piece;
    }));
    request.signal?.throwIfAborted();
    const logLikelihoods = new Float64Array(request.grid.categoryCount * request.siteCount);
    for (let job = 0; job < jobs.length; job += 1) {
      const { start } = jobs[job]!;
      const piece = pieces[job]!;
      logLikelihoods.set(piece, start * request.siteCount);
    }
    return { logLikelihoods, backend: "wasm-parallel", elapsedMs: performance.now() - started, precision: "f64" };
  }

  /** Partition FLAVOR only at complete Gamma-distribution alpha blocks. */
  async evaluateFlavorInterpolated(request: FlavorInterpolatedLikelihoodRequest): Promise<LikelihoodResult> {
    request.signal?.throwIfAborted();
    const alphaCount = request.alphaCount;
    const distributionCount = request.grid.categoryCount / alphaCount;
    const categorySites = request.grid.categoryCount * request.siteCount;
    if (
      this.workerCount <= 1
      || categorySites < this.minimumCategorySites
      || request.siteCount < 2
      || !Number.isInteger(distributionCount)
      || distributionCount < 2
    ) return this.local.evaluateFlavorInterpolated(request);
    const started = performance.now();
    const pool = await this.workers();
    const activeCount = Math.min(pool.length, distributionCount);
    request.onProgress?.(0, {
      message: `Starting ${activeCount.toLocaleString()} FLAVOR interpolation workers · ${distributionCount.toLocaleString()} shared Gamma tables`,
      current: 0,
      total: distributionCount,
      indeterminate: true,
    });
    const jobs: Array<{ readonly categoryStart: number; readonly distributionCount: number; readonly result: Promise<Float64Array> }> = [];
    for (let index = 0; index < activeCount; index += 1) {
      const distributionStart = Math.floor(index * distributionCount / activeCount);
      const distributionEnd = Math.floor((index + 1) * distributionCount / activeCount);
      const categoryStart = distributionStart * alphaCount;
      const categoryEnd = distributionEnd * alphaCount;
      const componentStart = request.operators.operatorOffsets[categoryStart]!;
      const componentEnd = request.operators.operatorOffsets[categoryEnd]!;
      const compact = compactModelBank(
        request.models,
        request.operators.componentModels.slice(componentStart, componentEnd),
      );
      const operatorOffsets = new Uint32Array(categoryEnd - categoryStart + 1);
      for (let operator = categoryStart; operator <= categoryEnd; operator += 1) {
        operatorOffsets[operator - categoryStart] = request.operators.operatorOffsets[operator]! - componentStart;
      }
      const grid = {
        ...request.grid,
        categories: request.grid.categories.slice(categoryStart * request.grid.parameterCount, categoryEnd * request.grid.parameterCount),
        categoryCount: categoryEnd - categoryStart,
      };
      const workerRequest: FlavorInterpolatedLikelihoodRequest = {
        tree: request.tree,
        tipStates: request.tipStates,
        siteCount: request.siteCount,
        grid,
        models: compact.models,
        operators: {
          operatorCount: categoryEnd - categoryStart,
          operatorOffsets,
          componentModels: compact.componentModels,
          componentWeights: request.operators.componentWeights.slice(componentStart, componentEnd),
          operatorScales: request.operators.operatorScales.slice(categoryStart, categoryEnd),
          operatorsPerCategory: 1,
          collapseWeights: request.operators.collapseWeights.slice(categoryStart, categoryEnd),
          collapseMode: request.operators.collapseMode,
        },
        equilibrium: request.equilibrium,
        alphaCount,
        ...(request.interpolation === undefined ? {} : { interpolation: request.interpolation }),
        ...(request.poissonTerms === undefined ? {} : { poissonTerms: request.poissonTerms }),
        ...(request.maxLambdaPerStep === undefined ? {} : { maxLambdaPerStep: request.maxLambdaPerStep }),
      };
      jobs.push({
        categoryStart,
        distributionCount: distributionEnd - distributionStart,
        result: this.callFlavorInterpolated(pool[index]!, workerRequest),
      });
    }
    let completedDistributions = 0;
    const pieces = await Promise.all(jobs.map(async (job) => {
      const piece = await job.result;
      completedDistributions += job.distributionCount;
      request.onProgress?.(completedDistributions / distributionCount, {
        message: `${completedDistributions.toLocaleString()}/${distributionCount.toLocaleString()} shared Gamma transition tables and alpha blocks complete`,
        current: completedDistributions,
        total: distributionCount,
      });
      return piece;
    }));
    request.signal?.throwIfAborted();
    const logLikelihoods = new Float64Array(request.grid.categoryCount * request.siteCount);
    for (let index = 0; index < jobs.length; index += 1) {
      logLikelihoods.set(pieces[index]!, jobs[index]!.categoryStart * request.siteCount);
    }
    return { logLikelihoods, backend: "wasm-parallel", elapsedMs: performance.now() - started, precision: "f64" };
  }

  async evaluateBsrel(request: BsrelKernelRequest): Promise<BsrelKernelResult> {
    request.signal?.throwIfAborted();
    if (this.workerCount <= 1 || request.siteCount < 32) return this.local.evaluateBsrel(request);
    const started = performance.now();
    const pool = await this.workers();
    const activeCount = Math.min(pool.length, Math.max(1, Math.ceil(request.siteCount / 32)));
    request.onProgress?.(0, {
      message: `Starting ${activeCount.toLocaleString()} site-parallel all-message workers`,
      current: 0,
      total: request.siteCount,
      indeterminate: true,
    });
    const jobs: Array<{ readonly count: number; readonly result: Promise<Float64Array> }> = [];
    for (let index = 0; index < activeCount; index += 1) {
      const start = Math.floor(index * request.siteCount / activeCount);
      const end = Math.floor((index + 1) * request.siteCount / activeCount);
      const count = end - start;
      const tips = new Uint8Array(request.tree.tipCount * count);
      for (let tip = 0; tip < request.tree.tipCount; tip += 1) {
        tips.set(request.tipStates.subarray(tip * request.siteCount + start, tip * request.siteCount + end), tip * count);
      }
      const { signal: _signal, onProgress: _onProgress, ...workerSafeRequest } = request;
      const workerRequest: BsrelKernelRequest = {
        ...workerSafeRequest,
        tipStates: tips,
        siteCount: count,
      };
      jobs.push({ count, result: this.callBsrel(pool[index]!, workerRequest) });
    }
    const objectives = new Float64Array(request.candidateBranches.length + 1);
    let completedSites = 0;
    const pieces = await Promise.all(jobs.map(async (job) => {
      const piece = await job.result;
      completedSites += job.count;
      request.onProgress?.(completedSites / request.siteCount, {
        message: `${completedSites.toLocaleString()}/${request.siteCount.toLocaleString()} codon sites messaged`,
        current: completedSites,
        total: request.siteCount,
      });
      return piece;
    }));
    for (const piece of pieces) {
      for (let index = 0; index < objectives.length; index += 1) objectives[index] = objectives[index]! + piece[index]!;
    }
    request.signal?.throwIfAborted();
    return { objectives, backend: "wasm-parallel", elapsedMs: performance.now() - started, precision: "f64" };
  }

  async evaluateGlobalGammaMessages(request: GlobalGammaMessageRequest): Promise<GlobalGammaMessageResult> {
    request.signal?.throwIfAborted();
    if (this.workerCount <= 1 || request.siteCount < 32) return this.local.evaluateGlobalGammaMessages(request);
    const started = performance.now();
    const pool = await this.workers();
    const activeCount = Math.min(pool.length, Math.max(1, Math.ceil(request.siteCount / 32)));
    request.onProgress?.(0, {
      message: `Starting ${activeCount.toLocaleString()} site-parallel Glamma message workers`,
      current: 0,
      total: request.siteCount,
      indeterminate: true,
    });
    const jobs: Array<{ readonly start: number; readonly count: number; readonly result: Promise<Float64Array> }> = [];
    for (let index = 0; index < activeCount; index += 1) {
      const start = Math.floor(index * request.siteCount / activeCount);
      const end = Math.floor((index + 1) * request.siteCount / activeCount);
      const count = end - start;
      const tips = new Uint8Array(request.tree.tipCount * count);
      for (let tip = 0; tip < request.tree.tipCount; tip += 1) {
        tips.set(request.tipStates.subarray(tip * request.siteCount + start, tip * request.siteCount + end), tip * count);
      }
      const { signal: _signal, onProgress: _onProgress, ...workerSafeRequest } = request;
      const workerRequest: GlobalGammaMessageRequest = { ...workerSafeRequest, tipStates: tips, siteCount: count };
      jobs.push({ start, count, result: this.callGlobalGamma(pool[index]!, workerRequest) });
    }
    const siteLogLikelihoods = new Float64Array(request.siteCount);
    const matrixSize = request.tree.edgeCount * request.siteCount;
    const cappedEdgeLogLikelihoods = new Float64Array(matrixSize);
    const positiveEdgeLogLikelihoods = new Float64Array(matrixSize);
    let completedSites = 0;
    const pieces = await Promise.all(jobs.map(async (job) => {
      const piece = await job.result;
      completedSites += job.count;
      request.onProgress?.(completedSites / request.siteCount, {
        message: `${completedSites.toLocaleString()}/${request.siteCount.toLocaleString()} codon sites messaged`,
        current: completedSites,
        total: request.siteCount,
      });
      return piece;
    }));
    for (let jobIndex = 0; jobIndex < jobs.length; jobIndex += 1) {
      const job = jobs[jobIndex]!;
      const piece = pieces[jobIndex]!;
      const pieceMatrixSize = request.tree.edgeCount * job.count;
      siteLogLikelihoods.set(piece.subarray(0, job.count), job.start);
      const cappedOffset = job.count;
      const positiveOffset = job.count + pieceMatrixSize;
      for (let edge = 0; edge < request.tree.edgeCount; edge += 1) {
        const destination = edge * request.siteCount + job.start;
        cappedEdgeLogLikelihoods.set(piece.subarray(cappedOffset + edge * job.count, cappedOffset + (edge + 1) * job.count), destination);
        positiveEdgeLogLikelihoods.set(piece.subarray(positiveOffset + edge * job.count, positiveOffset + (edge + 1) * job.count), destination);
      }
    }
    request.signal?.throwIfAborted();
    return {
      siteLogLikelihoods,
      cappedEdgeLogLikelihoods,
      positiveEdgeLogLikelihoods,
      backend: "wasm-parallel",
      elapsedMs: performance.now() - started,
      precision: "f64",
    };
  }

  async evaluateCladeShift(request: CladeShiftKernelRequest): Promise<CladeShiftKernelResult> {
    request.signal?.throwIfAborted();
    if (this.workerCount <= 1 || request.siteCount < 16) return this.local.evaluateCladeShift(request);
    const started = performance.now();
    const pool = await this.workers();
    const activeCount = Math.min(pool.length, Math.max(1, Math.ceil(request.siteCount / 8)));
    request.onProgress?.(0, {
      message: `Starting ${activeCount.toLocaleString()} site-parallel CladeShift workers`,
      current: 0,
      total: request.siteCount,
      indeterminate: true,
    });
    const jobs: Array<{ readonly start: number; readonly count: number; readonly result: Promise<Float64Array> }> = [];
    const componentCount = request.componentCount;
    const intensityCount = request.intensityCount;
    for (let index = 0; index < activeCount; index += 1) {
      const start = Math.floor(index * request.siteCount / activeCount);
      const end = Math.floor((index + 1) * request.siteCount / activeCount);
      const count = end - start;
      const tips = new Uint8Array(request.tree.tipCount * count);
      for (let tip = 0; tip < request.tree.tipCount; tip += 1) {
        tips.set(request.tipStates.subarray(tip * request.siteCount + start, tip * request.siteCount + end), tip * count);
      }
      const baselineStart = start * componentCount;
      const baselineEnd = end * componentCount;
      const shiftedStart = baselineStart * intensityCount;
      const shiftedEnd = baselineEnd * intensityCount;
      const sourceModels = new Uint32Array((baselineEnd - baselineStart) + (shiftedEnd - shiftedStart));
      sourceModels.set(request.baselineModels.subarray(baselineStart, baselineEnd));
      sourceModels.set(request.shiftedModels.subarray(shiftedStart, shiftedEnd), baselineEnd - baselineStart);
      const compact = compactModelBank(request.models, sourceModels);
      const baselineLength = baselineEnd - baselineStart;
      const { signal: _signal, onProgress: _onProgress, ...workerSafeRequest } = request;
      const workerRequest: CladeShiftKernelRequest = {
        ...workerSafeRequest,
        tipStates: tips,
        siteCount: count,
        baselineModels: compact.componentModels.slice(0, baselineLength),
        shiftedModels: compact.componentModels.slice(baselineLength),
        posteriorWeights: request.posteriorWeights.slice(baselineStart, baselineEnd),
        models: compact.models,
      };
      jobs.push({ start, count, result: this.callCladeShift(pool[index]!, workerRequest) });
    }
    let completedSites = 0;
    const pieces = await Promise.all(jobs.map(async (job) => {
      const piece = await job.result;
      completedSites += job.count;
      request.onProgress?.(completedSites / request.siteCount, {
        message: `${completedSites.toLocaleString()}/${request.siteCount.toLocaleString()} codon sites scanned across every eligible clade`,
        current: completedSites,
        total: request.siteCount,
      });
      return piece;
    }));
    const stride = intensityCount * request.candidateBranches.length;
    const logLikelihoodRatios = new Float64Array(request.siteCount * stride);
    for (let index = 0; index < jobs.length; index += 1) {
      logLikelihoodRatios.set(pieces[index]!, jobs[index]!.start * stride);
    }
    request.signal?.throwIfAborted();
    return {
      logLikelihoodRatios,
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

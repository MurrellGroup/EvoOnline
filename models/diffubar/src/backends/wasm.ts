import * as loader from "@assemblyscript/loader";
import type {
  AlphaBetaSamplerOptions,
  AlphaBetaSamplerResult,
  BranchMixtureLikelihoodRequest,
  FlavorInterpolatedLikelihoodRequest,
  BsrelKernelRequest,
  BsrelKernelResult,
  GlobalGammaMessageRequest,
  GlobalGammaMessageResult,
  LikelihoodRequest,
  LikelihoodResult,
  MixtureFitOptions,
  MixtureFitResult,
  SamplerOptions,
  SamplerResult,
  SiteResult,
  RuntimeWorkload,
} from "../types.js";

type WasmExports = Record<string, any> & {
  memory: WebAssembly.Memory;
  Uint8Array_ID: WebAssembly.Global;
  Uint32Array_ID: WebAssembly.Global;
  Int32Array_ID: WebAssembly.Global;
  Float64Array_ID: WebAssembly.Global;
  evaluateBranchMixtureLikelihoodDense(...args: number[]): number;
  evaluateBranchMixtureLikelihood(...args: number[]): number;
  evaluateFlavorInterpolatedLikelihood(...args: number[]): number;
  evaluateBsrelAllMessages(...args: number[]): number;
  evaluateGlobalGammaAllMessages(...args: number[]): number;
  evaluateLikelihood(...args: number[]): number;
  evaluateLikelihoodCached(...args: number[]): number;
  runWeightEM(...args: number[]): number;
  runFubarGibbsRejection(...args: number[]): number;
  runGibbs(...args: number[]): number;
  runGibbsRejection(...args: number[]): number;
  runGibbsSparse(...args: number[]): number;
  runCollapsedGibbs(...args: number[]): number;
  getLastAllocations(): number;
  __newArray(id: number, values: ArrayLike<number>): number;
  __getFloat64Array(pointer: number): Float64Array;
  __getUint32Array(pointer: number): Uint32Array;
  __pin(pointer: number): number;
  __unpin(pointer: number): void;
  __collect(): void;
};

let compiledModulePromise: Promise<WebAssembly.Module> | undefined;
let defaultInstancePromise: Promise<WasmExports> | undefined;

async function wasmBytes(): Promise<ArrayBuffer> {
  const url = new URL("../wasm/diffubar.wasm", import.meta.url);
  if (url.protocol === "file:") {
    const { readFile } = await import("node:fs/promises");
    const bytes = await readFile(url);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Unable to load ${url}: ${response.status} ${response.statusText}`);
  return response.arrayBuffer();
}

/** Compile once per JS realm; WebAssembly.Module is structured-cloneable to workers. */
export async function compileWasmModule(): Promise<WebAssembly.Module> {
  compiledModulePromise ??= wasmBytes().then((bytes) => WebAssembly.compile(bytes));
  return compiledModulePromise;
}

async function instantiateWasm(module: WebAssembly.Module): Promise<WasmExports> {
  const instantiated = await loader.instantiate(module, {});
  return instantiated.exports as unknown as WasmExports;
}

function getDefaultInstance(): Promise<WasmExports> {
  defaultInstancePromise ??= compileWasmModule().then(instantiateWasm);
  return defaultInstancePromise;
}

function globalValue(value: WebAssembly.Global | number): number {
  return typeof value === "number" ? value : Number(value.value);
}

class PinnedArrays {
  readonly pointers: number[] = [];

  constructor(private readonly wasm: WasmExports) {}

  add(id: number, values: ArrayLike<number>): number {
    const pointer = this.wasm.__pin(this.wasm.__newArray(id, values));
    this.pointers.push(pointer);
    return pointer;
  }

  release(): void {
    for (const pointer of this.pointers) this.wasm.__unpin(pointer);
    this.pointers.length = 0;
  }
}

interface CacheTables {
  readonly descriptors: Uint32Array;
  readonly combinationModels: Uint32Array;
  readonly combinationCategories: Uint32Array;
  readonly categoryMap: Uint32Array;
  readonly entryCount: number;
  readonly workingBytes: number;
}

const WASM_SITE_BLOCK = 16;
const MAX_CACHE_WORKING_BYTES = 192 * 1024 * 1024;

function buildCacheTables(request: LikelihoodRequest): CacheTables | undefined {
  const source = request.tree.cacheDescriptors;
  if (source === undefined || source.length === 0) return undefined;
  const cacheCount = source.length / 4;
  const descriptors = new Uint32Array(cacheCount * 8);
  const categoryMap = new Uint32Array(cacheCount * request.grid.categoryCount);
  const combinationModels: number[] = [];
  const combinationCategories: number[] = [];
  let entryCount = 0;
  for (let cache = 0; cache < cacheCount; cache += 1) {
    const input = cache * 4;
    const output = cache * 8;
    const dependencyMask = source[input + 3]!;
    const combinations = new Map<string, number>();
    const combinationModelOffset = combinationModels.length;
    const categoryMapOffset = cache * request.grid.categoryCount;
    for (let category = 0; category < request.grid.categoryCount; category += 1) {
      const keyParts: number[] = [];
      for (let branchClass = 0; branchClass < request.tree.classCount; branchClass += 1) {
        if ((dependencyMask & (1 << branchClass)) !== 0) {
          keyParts.push(request.models.gridModels[category * request.tree.classCount + branchClass]!);
        }
      }
      const key = keyParts.join(",");
      let local = combinations.get(key);
      if (local === undefined) {
        local = combinations.size;
        combinations.set(key, local);
        combinationCategories.push(category);
        for (let branchClass = 0; branchClass < request.tree.classCount; branchClass += 1) {
          combinationModels.push(request.models.gridModels[category * request.tree.classCount + branchClass]!);
        }
      }
      categoryMap[categoryMapOffset + category] = local;
    }
    const localCount = combinations.size;
    descriptors.set([
      source[input]!, source[input + 1]!, source[input + 2]!, dependencyMask,
      combinationModelOffset, localCount, entryCount, categoryMapOffset,
    ], output);
    entryCount += localCount;
  }
  const workingBytes = entryCount * (request.models.stateCount + 1) * WASM_SITE_BLOCK * Float64Array.BYTES_PER_ELEMENT;
  return {
    descriptors,
    combinationModels: Uint32Array.from(combinationModels),
    combinationCategories: Uint32Array.from(combinationCategories),
    categoryMap,
    entryCount,
    workingBytes,
  };
}

export class WasmBackend {
  readonly kind = "wasm" as const;
  private readonly instancePromise: Promise<WasmExports> | undefined;

  constructor(module?: WebAssembly.Module) {
    this.instancePromise = module === undefined ? undefined : instantiateWasm(module);
  }

  private instance(): Promise<WasmExports> {
    return this.instancePromise ?? getDefaultInstance();
  }

  /** Fetch, compile, and instantiate before a long-running analysis stage. */
  async prepare(_workload?: RuntimeWorkload): Promise<void> {
    await this.instance();
  }

  async evaluate(request: LikelihoodRequest): Promise<LikelihoodResult> {
    request.signal?.throwIfAborted();
    const totalPairs = request.grid.categoryCount * request.siteCount;
    request.onProgress?.(0, {
      message: "Running the fused SIMD likelihood kernel",
      current: 0,
      total: totalPairs,
      indeterminate: true,
    });
    const wasm = await this.instance();
    const pinned = new PinnedArrays(wasm);
    const u8 = globalValue(wasm.Uint8Array_ID);
    const u32 = globalValue(wasm.Uint32Array_ID);
    const f64 = globalValue(wasm.Float64Array_ID);
    const started = performance.now();
    try {
      const poissonTerms = request.poissonTerms ?? 0;
      if (!Number.isInteger(poissonTerms) || poissonTerms < 0) {
        throw new RangeError("Poisson terms must be a non-negative integer (zero selects adaptive truncation).");
      }
      const maxLambdaPerStep = request.maxLambdaPerStep ?? (poissonTerms > 0 ? 2 : 64);
      if (!(maxLambdaPerStep > 0) || !Number.isFinite(maxLambdaPerStep)) {
        throw new RangeError("Maximum lambda per step must be finite and positive.");
      }
      const pointers = [
        pinned.add(u32, request.tree.ops),
        pinned.add(f64, request.tree.edgeLengths),
        pinned.add(u8, request.tipStates),
        pinned.add(u32, request.models.gridModels),
        pinned.add(u32, request.models.neighborCount),
        pinned.add(u32, request.models.neighborIndex),
        pinned.add(f64, request.models.rDiagonal),
        pinned.add(f64, request.models.rOffDiagonal),
        pinned.add(f64, request.models.mu),
        pinned.add(f64, request.equilibrium),
      ];
      const cache = buildCacheTables(request);
      let rawResult: number;
      if (
        cache !== undefined
        && cache.workingBytes <= MAX_CACHE_WORKING_BYTES
        && request.tree.cachedMainOps !== undefined
        && request.tree.cacheOps !== undefined
        && request.tree.cachedEdgeLengths !== undefined
        && request.tree.cachedRootSlot !== undefined
        && request.tree.cachedSlotCount !== undefined
      ) {
        rawResult = wasm.evaluateLikelihoodCached(
          pinned.add(u32, request.tree.cachedMainOps),
          pinned.add(u32, request.tree.cacheOps),
          pinned.add(u32, cache.descriptors),
          pinned.add(u32, cache.combinationModels),
          pinned.add(u32, cache.combinationCategories),
          pinned.add(u32, cache.categoryMap),
          pinned.add(f64, request.tree.cachedEdgeLengths),
          pointers[2]!, pointers[3]!, pointers[4]!, pointers[5]!, pointers[6]!, pointers[7]!, pointers[8]!, pointers[9]!,
          request.siteCount,
          request.grid.categoryCount,
          request.tree.classCount,
          request.models.stateCount,
          request.models.maxNeighbors,
          request.tree.cachedSlotCount,
          request.tree.cachedRootSlot,
          cache.descriptors.length / 8,
          cache.entryCount,
          poissonTerms,
          maxLambdaPerStep,
        );
      } else {
        rawResult = wasm.evaluateLikelihood(
          ...pointers,
          request.siteCount,
          request.grid.categoryCount,
          request.tree.classCount,
          request.models.stateCount,
          request.models.maxNeighbors,
          request.tree.slotCount,
          request.tree.rootSlot,
          poissonTerms,
          maxLambdaPerStep,
        );
      }
      const resultPointer = wasm.__pin(rawResult);
      const logLikelihoods = wasm.__getFloat64Array(resultPointer).slice();
      wasm.__unpin(resultPointer);
      request.onProgress?.(1, {
        message: "Likelihood grid evaluated",
        current: totalPairs,
        total: totalPairs,
      });
      request.signal?.throwIfAborted();
      return { logLikelihoods, backend: "wasm", elapsedMs: performance.now() - started, precision: "f64" };
    } finally {
      pinned.release();
      wasm.__collect();
    }
  }

  /** Exact branch-wise transition mixtures used by FAME and FLAVOR. */
  async evaluateBranchMixture(request: BranchMixtureLikelihoodRequest): Promise<LikelihoodResult> {
    request.signal?.throwIfAborted();
    const operators = request.operators;
    const totalPairs = operators.operatorCount * request.siteCount;
    if (request.tree.classCount !== 1) throw new RangeError("Branch-mixture likelihoods require an untagged single-class tree.");
    if (
      operators.operatorCount !== request.grid.categoryCount * operators.operatorsPerCategory
      || operators.operatorOffsets.length !== operators.operatorCount + 1
      || operators.operatorScales.length !== operators.operatorCount
      || operators.collapseWeights.length !== operators.operatorCount
      || operators.componentModels.length !== operators.componentWeights.length
      || operators.operatorOffsets[operators.operatorCount] !== operators.componentModels.length
    ) throw new RangeError("Branch-mixture operator dimensions are inconsistent.");
    for (let operator = 0; operator < operators.operatorCount; operator += 1) {
      const start = operators.operatorOffsets[operator]!;
      const end = operators.operatorOffsets[operator + 1]!;
      if (!(end > start) || !(operators.operatorScales[operator]! > 0)) {
        throw new RangeError(`Branch-mixture operator ${operator + 1} is empty or has an invalid scale.`);
      }
      let componentTotal = 0;
      for (let entry = start; entry < end; entry += 1) {
        if (operators.componentModels[entry]! >= request.models.modelCount) throw new RangeError("Branch-mixture operator references an unknown atomic model.");
        componentTotal += operators.componentWeights[entry]!;
      }
      if (Math.abs(componentTotal - 1) > 1e-10) throw new RangeError(`Branch-mixture operator ${operator + 1} weights do not sum to one.`);
    }
    for (let category = 0; category < request.grid.categoryCount; category += 1) {
      let collapseTotal = 0;
      const start = category * operators.operatorsPerCategory;
      for (let member = 0; member < operators.operatorsPerCategory; member += 1) collapseTotal += operators.collapseWeights[start + member]!;
      if (Math.abs(collapseTotal - 1) > 1e-10) throw new RangeError(`Branch-mixture category ${category + 1} evidence weights do not sum to one.`);
    }
    request.onProgress?.(0, {
      message: `Fused branch-mixture kernel: ${operators.operatorCount.toLocaleString()} operators × ${request.siteCount.toLocaleString()} sites`,
      current: 0,
      total: totalPairs,
      indeterminate: true,
    });
    const wasm = await this.instance();
    const pinned = new PinnedArrays(wasm);
    const u8 = globalValue(wasm.Uint8Array_ID);
    const u32 = globalValue(wasm.Uint32Array_ID);
    const f64 = globalValue(wasm.Float64Array_ID);
    const started = performance.now();
    try {
      const poissonTerms = request.poissonTerms ?? 0;
      if (!Number.isInteger(poissonTerms) || poissonTerms < 0) throw new RangeError("Poisson terms must be a non-negative integer.");
      const maxLambdaPerStep = request.maxLambdaPerStep ?? (poissonTerms > 0 ? 2 : 64);
      if (!(maxLambdaPerStep > 0) || !Number.isFinite(maxLambdaPerStep)) throw new RangeError("Maximum lambda per step must be finite and positive.");
      // Dense streaming amortizes component exponentiation over every site.
      // Below 64 sites, directly propagating the sparse components is cheaper.
      const evaluator = request.siteCount >= 64
        ? wasm.evaluateBranchMixtureLikelihoodDense
        : wasm.evaluateBranchMixtureLikelihood;
      const raw = evaluator(
        pinned.add(u32, request.tree.ops),
        pinned.add(f64, request.tree.edgeLengths),
        pinned.add(u8, request.tipStates),
        pinned.add(u32, operators.operatorOffsets),
        pinned.add(u32, operators.componentModels),
        pinned.add(f64, operators.componentWeights),
        pinned.add(f64, operators.operatorScales),
        pinned.add(f64, operators.collapseWeights),
        pinned.add(u32, request.models.neighborCount),
        pinned.add(u32, request.models.neighborIndex),
        pinned.add(f64, request.models.rDiagonal),
        pinned.add(f64, request.models.rOffDiagonal),
        pinned.add(f64, request.models.mu),
        pinned.add(f64, request.equilibrium),
        request.siteCount,
        request.grid.categoryCount,
        operators.operatorsPerCategory,
        operators.collapseMode === "mean-log-likelihood" ? 1 : 0,
        request.models.stateCount,
        request.models.maxNeighbors,
        request.tree.slotCount,
        request.tree.rootSlot,
        poissonTerms,
        maxLambdaPerStep,
      );
      const resultPointer = wasm.__pin(raw);
      const logLikelihoods = wasm.__getFloat64Array(resultPointer).slice();
      wasm.__unpin(resultPointer);
      request.signal?.throwIfAborted();
      request.onProgress?.(1, { message: "Branch-mixture likelihood grid evaluated", current: totalPairs, total: totalPairs });
      return { logLikelihoods, backend: "wasm", elapsedMs: performance.now() - started, precision: "f64" };
    } finally {
      pinned.release();
      wasm.__collect();
    }
  }

  /** FLAVOR-only Julia-style element-wise transition-matrix interpolation. */
  async evaluateFlavorInterpolated(request: FlavorInterpolatedLikelihoodRequest): Promise<LikelihoodResult> {
    request.signal?.throwIfAborted();
    const operators = request.operators;
    const alphaCount = request.alphaCount;
    if (request.tree.classCount !== 1) throw new RangeError("FLAVOR interpolation requires an untagged single-class tree.");
    if (!Number.isInteger(alphaCount) || alphaCount < 1 || request.grid.categoryCount % alphaCount !== 0) {
      throw new RangeError("FLAVOR interpolation requires complete contiguous alpha blocks.");
    }
    if (
      operators.operatorsPerCategory !== 1
      || operators.operatorCount !== request.grid.categoryCount
      || operators.operatorOffsets.length !== operators.operatorCount + 1
      || operators.operatorScales.length !== operators.operatorCount
      || operators.componentModels.length !== operators.componentWeights.length
      || operators.operatorOffsets[operators.operatorCount] !== operators.componentModels.length
    ) throw new RangeError("FLAVOR interpolation operator dimensions are inconsistent.");
    for (let groupStart = 0; groupStart < operators.operatorCount; groupStart += alphaCount) {
      const referenceStart = operators.operatorOffsets[groupStart]!;
      const referenceEnd = operators.operatorOffsets[groupStart + 1]!;
      if (!(referenceEnd > referenceStart)) throw new RangeError("FLAVOR interpolation found an empty Gamma mixture.");
      let weightTotal = 0;
      for (let entry = referenceStart; entry < referenceEnd; entry += 1) weightTotal += operators.componentWeights[entry]!;
      if (Math.abs(weightTotal - 1) > 1e-10) throw new RangeError("FLAVOR Gamma-mixture weights do not sum to one.");
      for (let alpha = 1; alpha < alphaCount; alpha += 1) {
        const operator = groupStart + alpha;
        const start = operators.operatorOffsets[operator]!;
        const end = operators.operatorOffsets[operator + 1]!;
        if (end - start !== referenceEnd - referenceStart) throw new RangeError("FLAVOR alpha categories do not share one Gamma mixture.");
        for (let offset = 0; offset < end - start; offset += 1) {
          if (
            operators.componentModels[start + offset] !== operators.componentModels[referenceStart + offset]
            || Math.abs(operators.componentWeights[start + offset]! - operators.componentWeights[referenceStart + offset]!) > 1e-14
          ) throw new RangeError("FLAVOR alpha categories do not share one Gamma mixture.");
        }
      }
    }
    const timeStep = request.interpolation?.timeStep ?? 0.001;
    const tablePoints = request.interpolation?.tablePoints ?? 50;
    const tableCap = request.interpolation?.tableCap ?? 35;
    if (!(timeStep > 0) || !Number.isFinite(timeStep)) throw new RangeError("FLAVOR interpolation time step must be finite and positive.");
    if (!Number.isInteger(tablePoints) || tablePoints < 3 || tablePoints > 128) throw new RangeError("FLAVOR interpolation table points must be an integer from 3 to 128.");
    if (!Number.isInteger(tableCap) || tableCap < 2 || tableCap >= tablePoints) throw new RangeError("FLAVOR interpolation cap must lie inside the time table.");
    const totalPairs = request.grid.categoryCount * request.siteCount;
    request.onProgress?.(0, {
      message: `Building shared Julia-style transition tables for ${(request.grid.categoryCount / alphaCount).toLocaleString()} Gamma distributions`,
      current: 0,
      total: totalPairs,
      indeterminate: true,
    });
    const wasm = await this.instance();
    const pinned = new PinnedArrays(wasm);
    const u8 = globalValue(wasm.Uint8Array_ID);
    const u32 = globalValue(wasm.Uint32Array_ID);
    const f64 = globalValue(wasm.Float64Array_ID);
    const started = performance.now();
    try {
      const poissonTerms = request.poissonTerms ?? 0;
      if (!Number.isInteger(poissonTerms) || poissonTerms < 0) throw new RangeError("Poisson terms must be a non-negative integer.");
      const maxLambdaPerStep = request.maxLambdaPerStep ?? (poissonTerms > 0 ? 2 : 64);
      if (!(maxLambdaPerStep > 0) || !Number.isFinite(maxLambdaPerStep)) throw new RangeError("Maximum lambda per step must be finite and positive.");
      const raw = wasm.evaluateFlavorInterpolatedLikelihood(
        pinned.add(u32, request.tree.ops),
        pinned.add(f64, request.tree.edgeLengths),
        pinned.add(u8, request.tipStates),
        pinned.add(u32, operators.operatorOffsets),
        pinned.add(u32, operators.componentModels),
        pinned.add(f64, operators.componentWeights),
        pinned.add(f64, operators.operatorScales),
        pinned.add(u32, request.models.neighborCount),
        pinned.add(u32, request.models.neighborIndex),
        pinned.add(f64, request.models.rDiagonal),
        pinned.add(f64, request.models.rOffDiagonal),
        pinned.add(f64, request.models.mu),
        pinned.add(f64, request.equilibrium),
        request.siteCount,
        request.grid.categoryCount,
        alphaCount,
        request.models.stateCount,
        request.models.maxNeighbors,
        request.tree.slotCount,
        request.tree.rootSlot,
        poissonTerms,
        maxLambdaPerStep,
        timeStep,
        tablePoints,
        tableCap,
      );
      const resultPointer = wasm.__pin(raw);
      const logLikelihoods = wasm.__getFloat64Array(resultPointer).slice();
      wasm.__unpin(resultPointer);
      request.signal?.throwIfAborted();
      request.onProgress?.(1, { message: "Interpolated FLAVOR likelihood grid evaluated", current: totalPairs, total: totalPairs });
      return { logLikelihoods, backend: "wasm", elapsedMs: performance.now() - started, precision: "f64" };
    } finally {
      pinned.release();
      wasm.__collect();
    }
  }

  /**
   * Evaluate one complete fixed three-rate branch-site model and a batch of
   * exact single-edge replacements using upward/downward Felsenstein messages.
   */
  async evaluateBsrel(request: BsrelKernelRequest): Promise<BsrelKernelResult> {
    request.signal?.throwIfAborted();
    const candidateCount = request.candidateBranches.length;
    if (
      request.branchLengths.length !== request.tree.edgeCount
      || request.branchModels.length !== request.tree.edgeCount * 3
      || request.branchWeights.length !== request.tree.edgeCount * 3
      || request.candidateLengths.length !== candidateCount
      || request.candidateModels.length !== candidateCount * 3
      || request.candidateWeights.length !== candidateCount * 3
    ) throw new RangeError("BS-REL kernel array dimensions are inconsistent.");
    request.onProgress?.(0, {
      message: `${request.tree.edgeCount.toLocaleString()} branch mixtures · ${candidateCount.toLocaleString()} local replacements`,
      current: 0,
      total: request.siteCount,
      indeterminate: true,
    });
    const wasm = await this.instance();
    const pinned = new PinnedArrays(wasm);
    const u8 = globalValue(wasm.Uint8Array_ID);
    const u32 = globalValue(wasm.Uint32Array_ID);
    const i32 = globalValue(wasm.Int32Array_ID);
    const f64 = globalValue(wasm.Float64Array_ID);
    const started = performance.now();
    try {
      const poissonTerms = request.poissonTerms ?? 0;
      const maxLambdaPerStep = request.maxLambdaPerStep ?? (poissonTerms > 0 ? 2 : 64);
      const raw = wasm.evaluateBsrelAllMessages(
        pinned.add(u32, request.tree.childOffsets),
        pinned.add(u32, request.tree.children),
        pinned.add(i32, request.tree.tipForNode),
        pinned.add(i32, request.tree.edgeForNode),
        pinned.add(u32, request.tree.nodeForEdge),
        pinned.add(u32, request.tree.postorder),
        pinned.add(u32, request.tree.preorder),
        pinned.add(u8, request.tipStates),
        pinned.add(f64, request.branchLengths),
        pinned.add(u32, request.branchModels),
        pinned.add(f64, request.branchWeights),
        pinned.add(u32, request.candidateBranches),
        pinned.add(f64, request.candidateLengths),
        pinned.add(u32, request.candidateModels),
        pinned.add(f64, request.candidateWeights),
        pinned.add(u32, request.models.neighborCount),
        pinned.add(u32, request.models.neighborIndex),
        pinned.add(f64, request.models.rDiagonal),
        pinned.add(f64, request.models.rOffDiagonal),
        pinned.add(f64, request.models.mu),
        pinned.add(f64, request.equilibrium),
        request.siteCount,
        request.tree.nodeCount,
        request.tree.edgeCount,
        request.models.stateCount,
        request.models.maxNeighbors,
        request.tree.root,
        poissonTerms,
        maxLambdaPerStep,
      );
      const resultPointer = wasm.__pin(raw);
      const objectives = wasm.__getFloat64Array(resultPointer).slice();
      wasm.__unpin(resultPointer);
      request.signal?.throwIfAborted();
      request.onProgress?.(1, {
        message: "Two-sided branch messages evaluated",
        current: request.siteCount,
        total: request.siteCount,
      });
      return { objectives, backend: "wasm", elapsedMs: performance.now() - started, precision: "f64" };
    } finally {
      pinned.release();
      wasm.__collect();
    }
  }

  /**
   * Evaluate a globally shared Gamma(omega) mixture under a site-level
   * Gamma(alpha) mixture and expose exact capped-edge/tail local likelihoods.
   */
  async evaluateGlobalGammaMessages(request: GlobalGammaMessageRequest): Promise<GlobalGammaMessageResult> {
    request.signal?.throwIfAborted();
    const edgeCount = request.tree.edgeCount;
    const omegaCount = request.omegaModels.length;
    const alphaCount = request.alphaValues.length;
    if (
      request.branchLengths.length !== edgeCount
      || omegaCount < 2
      || request.omegaWeights.length !== omegaCount
      || request.positiveMask.length !== omegaCount
      || alphaCount < 2
      || request.alphaWeights.length !== alphaCount
      || request.neutralModel < 0
      || request.neutralModel >= request.models.modelCount
    ) throw new RangeError("Global-Gamma message-kernel array dimensions are inconsistent.");
    const omegaTotal = request.omegaWeights.reduce((sum, value) => sum + value, 0);
    const alphaTotal = request.alphaWeights.reduce((sum, value) => sum + value, 0);
    if (Math.abs(omegaTotal - 1) > 1e-10 || Math.abs(alphaTotal - 1) > 1e-10) {
      throw new RangeError("Global-Gamma quadrature weights must each sum to one.");
    }
    request.onProgress?.(0, {
      message: `${alphaCount} alpha rates × ${omegaCount} omega rates · ${edgeCount.toLocaleString()} exact local blankets`,
      current: 0,
      total: request.siteCount,
      indeterminate: true,
    });
    const wasm = await this.instance();
    const pinned = new PinnedArrays(wasm);
    const u8 = globalValue(wasm.Uint8Array_ID);
    const u32 = globalValue(wasm.Uint32Array_ID);
    const i32 = globalValue(wasm.Int32Array_ID);
    const f64 = globalValue(wasm.Float64Array_ID);
    const started = performance.now();
    try {
      const poissonTerms = request.poissonTerms ?? 0;
      const maxLambdaPerStep = request.maxLambdaPerStep ?? (poissonTerms > 0 ? 2 : 64);
      const raw = wasm.evaluateGlobalGammaAllMessages(
        pinned.add(u32, request.tree.childOffsets),
        pinned.add(u32, request.tree.children),
        pinned.add(i32, request.tree.tipForNode),
        pinned.add(i32, request.tree.edgeForNode),
        pinned.add(u32, request.tree.nodeForEdge),
        pinned.add(u32, request.tree.postorder),
        pinned.add(u32, request.tree.preorder),
        pinned.add(u8, request.tipStates),
        pinned.add(f64, request.branchLengths),
        pinned.add(u32, request.omegaModels),
        pinned.add(f64, request.omegaWeights),
        pinned.add(u8, request.positiveMask),
        request.neutralModel,
        pinned.add(f64, request.alphaValues),
        pinned.add(f64, request.alphaWeights),
        pinned.add(u32, request.models.neighborCount),
        pinned.add(u32, request.models.neighborIndex),
        pinned.add(f64, request.models.rDiagonal),
        pinned.add(f64, request.models.rOffDiagonal),
        pinned.add(f64, request.models.mu),
        pinned.add(f64, request.equilibrium),
        request.siteCount,
        request.tree.nodeCount,
        edgeCount,
        request.models.stateCount,
        request.models.maxNeighbors,
        request.tree.root,
        poissonTerms,
        maxLambdaPerStep,
      );
      const resultPointer = wasm.__pin(raw);
      const values = wasm.__getFloat64Array(resultPointer).slice();
      wasm.__unpin(resultPointer);
      const matrixSize = edgeCount * request.siteCount;
      if (values.length !== request.siteCount + matrixSize * 2) throw new Error("Global-Gamma WASM kernel returned an invalid result length.");
      request.signal?.throwIfAborted();
      request.onProgress?.(1, {
        message: "Alternative, capped-edge, and positive-tail messages evaluated",
        current: request.siteCount,
        total: request.siteCount,
      });
      return {
        siteLogLikelihoods: values.slice(0, request.siteCount),
        cappedEdgeLogLikelihoods: values.slice(request.siteCount, request.siteCount + matrixSize),
        positiveEdgeLogLikelihoods: values.slice(request.siteCount + matrixSize),
        backend: "wasm",
        elapsedMs: performance.now() - started,
        precision: "f64",
      };
    } finally {
      pinned.release();
      wasm.__collect();
    }
  }

  async sample(
    conditionals: Float64Array,
    categories: Float64Array,
    gridCount: number,
    siteCount: number,
    parameterCount: number,
    options: SamplerOptions = {},
  ): Promise<SamplerResult> {
    options.signal?.throwIfAborted();
    const wasm = await this.instance();
    const pinned = new PinnedArrays(wasm);
    const f64 = globalValue(wasm.Float64Array_ID);
    const iterations = options.iterations ?? 2_500;
    const burnin = options.burnin ?? Math.floor(iterations / 5);
    if (!(iterations > 0 && burnin >= 0 && burnin < iterations)) throw new RangeError("Sampler burn-in must be smaller than iterations.");
    options.onProgress?.(0, {
      message: `${iterations.toLocaleString()} Gibbs iterations in the fused WASM sampler`,
      indeterminate: true,
    });
    const started = performance.now();
    try {
      const categoriesPointer = pinned.add(f64, categories);
      const cutoff = options.likelihoodCutoff ?? 0;
      if (!(cutoff >= 0 && cutoff <= 1 && Number.isFinite(cutoff))) {
        throw new RangeError("Sampler likelihood cutoff must be finite and between zero and one.");
      }
      let resultPointer: number;
      if (options.samplerMode === "collapsed") {
        const siteMajor = transposeConditionals(conditionals, gridCount, siteCount, cutoff);
        resultPointer = wasm.__pin(wasm.runCollapsedGibbs(
          pinned.add(f64, siteMajor),
          categoriesPointer,
          gridCount,
          siteCount,
          parameterCount,
          iterations,
          burnin,
          options.concentration ?? 0.1,
          options.seed ?? 0x5eed1234,
          options.trackAllocations ? 1 : 0,
        ));
      } else if (options.samplerMode === "reference" && cutoff > 0) {
        const sparse = sparsifyConditionals(conditionals, gridCount, siteCount, cutoff);
        resultPointer = wasm.__pin(wasm.runGibbsSparse(
          pinned.add(f64, sparse.values),
          pinned.add(globalValue(wasm.Uint32Array_ID), sparse.offsets),
          pinned.add(globalValue(wasm.Uint32Array_ID), sparse.indices),
          categoriesPointer,
          gridCount,
          siteCount,
          parameterCount,
          iterations,
          burnin,
          options.concentration ?? 0.1,
          options.seed ?? 0x5eed1234,
          options.trackAllocations ? 1 : 0,
        ));
      } else if (options.samplerMode === "reference") {
        const siteMajor = transposeConditionals(conditionals, gridCount, siteCount, 0);
        resultPointer = wasm.__pin(wasm.runGibbs(
          pinned.add(f64, siteMajor),
          categoriesPointer,
          gridCount,
          siteCount,
          parameterCount,
          iterations,
          burnin,
          options.concentration ?? 0.1,
          options.seed ?? 0x5eed1234,
          0,
          options.trackAllocations ? 1 : 0,
        ));
      } else {
        resultPointer = wasm.__pin(wasm.runGibbsRejection(
          pinned.add(f64, conditionals),
          categoriesPointer,
          gridCount,
          siteCount,
          parameterCount,
          iterations,
          burnin,
          options.concentration ?? 0.1,
          options.seed ?? 0x5eed1234,
          cutoff,
          options.trackAllocations ? 1 : 0,
        ));
      }
      const flat = wasm.__getFloat64Array(resultPointer).slice();
      wasm.__unpin(resultPointer);
      const theta = flat.slice(0, gridCount);
      const sites: SiteResult[] = [];
      for (let site = 0; site < siteCount; site += 1) {
        const offset = gridCount + site * 7;
        sites.push({
          site: site + 1,
          pOmega1Greater: flat[offset]!,
          pOmega2Greater: flat[offset + 1]!,
          pOmega1Positive: flat[offset + 2]!,
          pOmega2Positive: flat[offset + 3]!,
          meanAlpha: flat[offset + 4]!,
          meanOmega1: flat[offset + 5]!,
          meanOmega2: flat[offset + 6]!,
        });
      }
      let allocations: Uint32Array | undefined;
      if (options.trackAllocations) allocations = wasm.__getUint32Array(wasm.getLastAllocations()).slice();
      options.onProgress?.(1, {
        message: "Posterior sampling complete",
        current: iterations,
        total: iterations,
      });
      options.signal?.throwIfAborted();
      return {
        sites,
        theta,
        retainedIterations: iterations - burnin,
        ...(allocations === undefined ? {} : { allocations }),
        elapsedMs: performance.now() - started,
      };
    } finally {
      pinned.release();
      wasm.__collect();
    }
  }

  async fitMixtureWeights(
    conditionals: Float64Array,
    gridCount: number,
    siteCount: number,
    options: MixtureFitOptions = {},
  ): Promise<MixtureFitResult> {
    options.signal?.throwIfAborted();
    if (conditionals.length !== gridCount * siteCount) throw new RangeError("Conditional likelihood dimensions do not match the FUBAR grid.");
    const iterations = options.iterations ?? 2_500;
    const concentration = options.concentration ?? 0.5;
    const tolerance = options.tolerance ?? 1e-10;
    if (!(iterations > 0 && Number.isInteger(iterations))) throw new RangeError("EM iterations must be a positive integer.");
    if (!(concentration > 0 && Number.isFinite(concentration))) throw new RangeError("EM concentration must be finite and positive.");
    if (!(tolerance >= 0 && Number.isFinite(tolerance))) throw new RangeError("EM tolerance must be finite and non-negative.");
    options.onProgress?.(0, {
      message: `Fused Dirichlet EM · up to ${iterations.toLocaleString()} steps`,
      current: 0,
      total: iterations,
    });
    const wasm = await this.instance();
    const pinned = new PinnedArrays(wasm);
    const f64 = globalValue(wasm.Float64Array_ID);
    let theta = new Float64Array(gridCount).fill(1 / gridCount);
    const started = performance.now();
    try {
      const conditionalsPointer = pinned.add(f64, conditionals);
      const chunkSize = 64;
      let completedIterations = 0;
      let logLikelihood = -Infinity;
      while (completedIterations < iterations) {
        options.signal?.throwIfAborted();
        const requestedChunk = Math.min(chunkSize, iterations - completedIterations);
        const thetaPointer = wasm.__pin(wasm.__newArray(f64, theta));
        const resultPointer = wasm.__pin(wasm.runWeightEM(
          conditionalsPointer,
          thetaPointer,
          gridCount,
          siteCount,
          requestedChunk,
          concentration,
          tolerance,
        ));
        wasm.__unpin(thetaPointer);
        const flat = wasm.__getFloat64Array(resultPointer).slice();
        wasm.__unpin(resultPointer);
        const completedChunk = Math.round(flat[gridCount]!);
        theta = flat.slice(0, gridCount);
        logLikelihood = flat[gridCount + 1]!;
        completedIterations += completedChunk;
        options.onProgress?.(completedIterations / iterations, {
          message: `Dirichlet EM step ${completedIterations.toLocaleString()}`,
          current: completedIterations,
          total: iterations,
          metricLabel: "mixture log L",
          metricValue: logLikelihood,
        });
        if (completedChunk < requestedChunk) break;
        // The kernel stays fused for useful batches, but yielding between them
        // lets the worker publish real iteration/likelihood telemetry and abort.
        if (completedIterations < iterations) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      options.onProgress?.(1, {
        message: `Dirichlet EM converged after ${completedIterations.toLocaleString()} steps`,
        current: completedIterations,
        total: completedIterations,
        metricLabel: "mixture log L",
        metricValue: logLikelihood,
      });
      options.signal?.throwIfAborted();
      return {
        theta,
        completedIterations,
        logLikelihood,
        elapsedMs: performance.now() - started,
      };
    } finally {
      pinned.release();
      wasm.__collect();
    }
  }

  async sampleAlphaBeta(
    conditionals: Float64Array,
    categories: Float64Array,
    gridCount: number,
    siteCount: number,
    options: AlphaBetaSamplerOptions = {},
  ): Promise<AlphaBetaSamplerResult> {
    options.signal?.throwIfAborted();
    if (conditionals.length !== gridCount * siteCount || categories.length !== gridCount * 2) {
      throw new RangeError("Alpha-beta sampler dimensions do not match the FUBAR grid.");
    }
    const iterations = options.iterations ?? 2_500;
    const burnin = options.burnin ?? Math.floor(iterations / 5);
    const concentration = options.concentration ?? 0.5;
    if (!(Number.isInteger(iterations) && Number.isInteger(burnin) && iterations > 0 && burnin >= 0 && burnin < iterations)) {
      throw new RangeError("Gibbs iterations and burn-in must be integers, with burn-in smaller than iterations.");
    }
    if (!(concentration > 0 && Number.isFinite(concentration))) {
      throw new RangeError("Gibbs concentration must be finite and positive.");
    }
    options.onProgress?.(0, {
      message: `${iterations.toLocaleString()} exact Gibbs iterations in the fused WASM sampler`,
      current: 0,
      total: iterations,
      indeterminate: true,
    });
    const wasm = await this.instance();
    const pinned = new PinnedArrays(wasm);
    const f64 = globalValue(wasm.Float64Array_ID);
    const started = performance.now();
    try {
      const resultPointer = wasm.__pin(wasm.runFubarGibbsRejection(
        pinned.add(f64, conditionals),
        pinned.add(f64, categories),
        gridCount,
        siteCount,
        iterations,
        burnin,
        concentration,
        options.seed ?? 0x5eed1234,
        options.trackAllocations ? 1 : 0,
      ));
      const flat = wasm.__getFloat64Array(resultPointer).slice();
      wasm.__unpin(resultPointer);
      const positive = new Float64Array(siteCount);
      const purifying = new Float64Array(siteCount);
      const meanAlpha = new Float64Array(siteCount);
      const meanBeta = new Float64Array(siteCount);
      for (let site = 0; site < siteCount; site += 1) {
        const offset = gridCount + site * 4;
        positive[site] = flat[offset]!;
        purifying[site] = flat[offset + 1]!;
        meanAlpha[site] = flat[offset + 2]!;
        meanBeta[site] = flat[offset + 3]!;
      }
      let allocations: Uint32Array | undefined;
      if (options.trackAllocations) allocations = wasm.__getUint32Array(wasm.getLastAllocations()).slice();
      options.onProgress?.(1, {
        message: "FUBAR Gibbs sampling complete",
        current: iterations,
        total: iterations,
      });
      options.signal?.throwIfAborted();
      return {
        theta: flat.slice(0, gridCount),
        positive,
        purifying,
        meanAlpha,
        meanBeta,
        retainedIterations: iterations - burnin,
        ...(allocations === undefined ? {} : { allocations }),
        elapsedMs: performance.now() - started,
      };
    } finally {
      pinned.release();
      wasm.__collect();
    }
  }
}

interface SparseConditionals {
  readonly values: Float64Array;
  readonly offsets: Uint32Array;
  readonly indices: Uint32Array;
}

/** Transpose once so the collapsed sampler streams each site's categories. */
function transposeConditionals(
  conditionals: Float64Array,
  gridCount: number,
  siteCount: number,
  cutoff: number,
): Float64Array {
  const siteMajor = new Float64Array(conditionals.length);
  for (let site = 0; site < siteCount; site += 1) {
    let retained = 0;
    const destination = site * gridCount;
    for (let category = 0; category < gridCount; category += 1) {
      const value = conditionals[category * siteCount + site]!;
      if (value >= cutoff) {
        siteMajor[destination + category] = value;
        retained += 1;
      }
    }
    if (retained === 0) throw new RangeError(`Likelihood cutoff removed every grid category at site ${site + 1}.`);
  }
  return siteMajor;
}

/** Build a site-major CSR view without retaining a second dense matrix. */
function sparsifyConditionals(
  conditionals: Float64Array,
  gridCount: number,
  siteCount: number,
  cutoff: number,
): SparseConditionals {
  const offsets = new Uint32Array(siteCount + 1);
  let nonzero = 0;
  for (let site = 0; site < siteCount; site += 1) {
    for (let category = 0; category < gridCount; category += 1) {
      if (conditionals[category * siteCount + site]! >= cutoff) nonzero += 1;
    }
    if (nonzero > 0xffff_ffff) throw new RangeError("Sparse conditional table exceeds the WASM u32 addressable range.");
    offsets[site + 1] = nonzero;
  }
  const values = new Float64Array(nonzero);
  const indices = new Uint32Array(nonzero);
  let cursor = 0;
  for (let site = 0; site < siteCount; site += 1) {
    for (let category = 0; category < gridCount; category += 1) {
      const value = conditionals[category * siteCount + site]!;
      if (value >= cutoff) {
        values[cursor] = value;
        indices[cursor] = category;
        cursor += 1;
      }
    }
    if (offsets[site + 1] === offsets[site]) {
      throw new RangeError(`Likelihood cutoff removed every grid category at site ${site + 1}.`);
    }
  }
  return { values, offsets, indices };
}

export function normalizeConditionalLikelihoods(logLikelihoods: Float64Array, gridCount: number, siteCount: number): Float64Array {
  return normalizeConditionalLikelihoodsInPlace(logLikelihoods.slice(), gridCount, siteCount);
}

/** Convert category-major log likelihoods in place, avoiding a second grid matrix. */
export function normalizeConditionalLikelihoodsInPlace(
  logLikelihoods: Float64Array,
  gridCount: number,
  siteCount: number,
): Float64Array {
  for (let site = 0; site < siteCount; site += 1) {
    let maximum = -Infinity;
    for (let category = 0; category < gridCount; category += 1) {
      maximum = Math.max(maximum, logLikelihoods[category * siteCount + site]!);
    }
    for (let category = 0; category < gridCount; category += 1) {
      const index = category * siteCount + site;
      logLikelihoods[index] = Math.exp(logLikelihoods[index]! - maximum);
    }
  }
  return logLikelihoods;
}

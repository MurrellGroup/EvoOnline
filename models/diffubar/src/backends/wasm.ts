import * as loader from "@assemblyscript/loader";
import type { LikelihoodRequest, LikelihoodResult, SamplerOptions, SamplerResult, SiteResult } from "../types.js";

type WasmExports = Record<string, any> & {
  memory: WebAssembly.Memory;
  Uint8Array_ID: WebAssembly.Global;
  Uint32Array_ID: WebAssembly.Global;
  Float64Array_ID: WebAssembly.Global;
  evaluateLikelihood(...args: number[]): number;
  evaluateLikelihoodCached(...args: number[]): number;
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

import { DifFUBARError, type LikelihoodRequest, type LikelihoodResult, type RuntimeWorkload } from "../types.js";
import { GPU_MAX_SLOTS, likelihoodShader } from "./likelihood.wgsl.js";

function toF32Bits(values: ArrayLike<number>): Uint32Array {
  const floats = Float32Array.from(values);
  return new Uint32Array(floats.buffer);
}

class WordBufferBuilder {
  private readonly chunks: Uint32Array[] = [];
  length = 0;

  add(values: Uint32Array): number {
    const offset = this.length;
    this.chunks.push(values);
    this.length += values.length;
    return offset;
  }

  addF32(values: ArrayLike<number>): number {
    return this.add(toF32Bits(values));
  }

  finish(): Uint32Array {
    const result = new Uint32Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }
}

function createBuffer(device: GPUDevice, data: ArrayBufferView, usage: GPUBufferUsageFlags, label: string): GPUBuffer {
  const size = Math.max(4, Math.ceil(data.byteLength / 4) * 4);
  const buffer = device.createBuffer({ label, size, usage, mappedAtCreation: true });
  const mapped = new Uint8Array(buffer.getMappedRange());
  mapped.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  buffer.unmap();
  return buffer;
}

function packTipChunk(tips: Uint8Array, tipCount: number, totalSites: number, siteOffset: number, siteCount: number): Uint32Array {
  const bytes = new Uint8Array(Math.ceil(tipCount * siteCount / 4) * 4);
  for (let tip = 0; tip < tipCount; tip += 1) {
    const sourceStart = tip * totalSites + siteOffset;
    bytes.set(tips.subarray(sourceStart, sourceStart + siteCount), tip * siteCount);
  }
  return new Uint32Array(bytes.buffer);
}

interface PackedStaticData {
  readonly metadata: Uint32Array;
  readonly modelData: Uint32Array;
  readonly offsets: readonly number[];
}

function packStaticData(request: LikelihoodRequest): PackedStaticData {
  const metadata = new WordBufferBuilder();
  const opsOffset = metadata.add(request.tree.ops);
  const edgesOffset = metadata.addF32(request.tree.edgeLengths);
  const neighborCountOffset = metadata.add(request.models.neighborCount);
  const neighborIndexOffset = metadata.add(request.models.neighborIndex);
  const equilibriumOffset = metadata.addF32(request.equilibrium);

  const models = new WordBufferBuilder();
  const gridModelsOffset = models.add(request.models.gridModels);
  const diagonalOffset = models.addF32(request.models.rDiagonal);
  const ratesOffset = models.addF32(request.models.rOffDiagonal);
  const muOffset = models.addF32(request.models.mu);
  return {
    metadata: metadata.finish(),
    modelData: models.finish(),
    offsets: [
      opsOffset, edgesOffset, neighborCountOffset, neighborIndexOffset,
      equilibriumOffset, gridModelsOffset, diagonalOffset, ratesOffset, muOffset,
    ],
  };
}

function makeParameters(request: LikelihoodRequest, offsets: readonly number[], siteOffset: number, siteCount: number): ArrayBuffer {
  const buffer = new ArrayBuffer(112);
  const words = new Uint32Array(buffer);
  const floats = new Float32Array(buffer);
  words.set([
    siteOffset, siteCount, request.siteCount, request.grid.categoryCount,
    request.tree.classCount, request.tree.ops.length / 4, request.models.stateCount, request.models.maxNeighbors,
    request.tree.slotCount, request.tree.rootSlot, request.poissonTerms ?? 0, request.tree.tipCount,
    offsets[0]!, offsets[1]!, offsets[2]!, offsets[3]!,
    offsets[4]!, offsets[5]!, offsets[6]!, offsets[7]!,
    offsets[8]!, request.models.modelCount, 0, 0,
  ]);
  floats[24] = request.maxLambdaPerStep ?? ((request.poissonTerms ?? 0) > 0 ? 2 : 64);
  return buffer;
}

export class WebGPUBackend {
  readonly kind = "webgpu" as const;
  private devicePromise: Promise<GPUDevice> | undefined;
  private pipelinePromise: Promise<GPUComputePipeline> | undefined;

  static isAvailable(): boolean {
    return typeof navigator !== "undefined" && navigator.gpu !== undefined;
  }

  private async device(): Promise<GPUDevice> {
    this.devicePromise ??= (async () => {
      if (!WebGPUBackend.isAvailable()) throw new DifFUBARError("WEBGPU_UNAVAILABLE", "This browser does not expose WebGPU.");
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
      if (adapter === null) throw new DifFUBARError("WEBGPU_NO_ADAPTER", "No WebGPU adapter is available.");
      if (adapter.limits.maxComputeInvocationsPerWorkgroup < 64 || adapter.limits.maxComputeWorkgroupStorageSize < 8192) {
        throw new DifFUBARError("WEBGPU_LIMITS", "The WebGPU adapter has insufficient compute limits for the 61-state kernel.");
      }
      return adapter.requestDevice();
    })();
    return this.devicePromise;
  }

  private pipeline(device: GPUDevice): Promise<GPUComputePipeline> {
    this.pipelinePromise ??= (async () => {
      device.pushErrorScope("validation");
      const module = device.createShaderModule({ label: "difFUBAR sparse pruning", code: likelihoodShader() });
      const pipeline = await device.createComputePipelineAsync({
        label: "difFUBAR likelihood pipeline",
        layout: "auto",
        compute: { module, entryPoint: "main" },
      });
      const pipelineError = await device.popErrorScope();
      if (pipelineError !== null) throw new DifFUBARError("WGSL_VALIDATION", pipelineError.message);
      return pipeline;
    })();
    return this.pipelinePromise;
  }

  /** Request the adapter and compile/validate WGSL before likelihood work. */
  async prepare(_workload?: RuntimeWorkload): Promise<void> {
    const device = await this.device();
    await this.pipeline(device);
  }

  async evaluate(request: LikelihoodRequest): Promise<LikelihoodResult> {
    request.signal?.throwIfAborted();
    request.onProgress?.(0, {
      message: "Preparing the WebGPU likelihood pipeline",
      indeterminate: true,
    });
    if (request.models.stateCount < 2 || request.models.stateCount > 61) {
      throw new DifFUBARError("GPU_STATE_COUNT", "The WebGPU pruning kernel supports between 2 and 61 states.");
    }
    if (request.tree.slotCount > GPU_MAX_SLOTS) {
      throw new DifFUBARError("GPU_TREE_SLOTS", `Tree requires ${request.tree.slotCount} slots; GPU kernel limit is ${GPU_MAX_SLOTS}.`);
    }
    const device = await this.device();
    const started = performance.now();
    const packed = packStaticData(request);
    const maximumBinding = Number(device.limits.maxStorageBufferBindingSize);
    if (packed.metadata.byteLength > maximumBinding || packed.modelData.byteLength > maximumBinding) {
      throw new DifFUBARError("GPU_BUFFER_LIMIT", "Static model data exceeds the adapter's storage-buffer limit.");
    }

    const pipeline = await this.pipeline(device);

    const metadataBuffer = createBuffer(device, packed.metadata, GPUBufferUsage.STORAGE, "difFUBAR metadata");
    const modelBuffer = createBuffer(device, packed.modelData, GPUBufferUsage.STORAGE, "difFUBAR models");
    const parameterBuffer = device.createBuffer({
      label: "difFUBAR parameters",
      size: 112,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const result = new Float64Array(request.grid.categoryCount * request.siteCount);
    if (request.grid.categoryCount > Number(device.limits.maxComputeWorkgroupsPerDimension)) {
      throw new DifFUBARError("GPU_GRID_LIMIT", "Grid dimension exceeds this adapter's dispatch limit; use the WASM backend.");
    }
    const maxSitesByOutput = Math.max(1, Math.floor(maximumBinding / (request.grid.categoryCount * 4)));
    const maxSitesByTips = Math.max(1, Math.floor(maximumBinding / request.tree.tipCount));
    const chunkSize = Math.min(
      request.siteCount,
      maxSitesByOutput,
      maxSitesByTips,
      Number(device.limits.maxComputeWorkgroupsPerDimension),
    );
    const categorySites = request.grid.categoryCount * request.siteCount;
    request.onProgress?.(0, {
      message: `GPU dispatch: ${request.grid.categoryCount.toLocaleString()} categories × ${request.siteCount.toLocaleString()} sites`,
      current: 0,
      total: categorySites,
      indeterminate: true,
    });

    try {
      for (let siteOffset = 0; siteOffset < request.siteCount; siteOffset += chunkSize) {
        request.signal?.throwIfAborted();
        const siteCount = Math.min(chunkSize, request.siteCount - siteOffset);
        const tipChunk = packTipChunk(request.tipStates, request.tree.tipCount, request.siteCount, siteOffset, siteCount);
        const tipBuffer = createBuffer(device, tipChunk, GPUBufferUsage.STORAGE, "difFUBAR tip chunk");
        const outputBytes = request.grid.categoryCount * siteCount * 4;
        const outputBuffer = device.createBuffer({
          label: "difFUBAR likelihood chunk",
          size: outputBytes,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        });
        const stagingBuffer = device.createBuffer({
          label: "difFUBAR readback",
          size: outputBytes,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        device.queue.writeBuffer(parameterBuffer, 0, makeParameters(request, packed.offsets, siteOffset, siteCount));
        const bindGroup = device.createBindGroup({
          label: "difFUBAR likelihood bindings",
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: parameterBuffer } },
            { binding: 1, resource: { buffer: metadataBuffer } },
            { binding: 2, resource: { buffer: modelBuffer } },
            { binding: 3, resource: { buffer: tipBuffer } },
            { binding: 4, resource: { buffer: outputBuffer } },
          ],
        });
        const encoder = device.createCommandEncoder({ label: "difFUBAR likelihood commands" });
        const pass = encoder.beginComputePass({ label: "difFUBAR pruning" });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(siteCount, request.grid.categoryCount, 1);
        pass.end();
        encoder.copyBufferToBuffer(outputBuffer, 0, stagingBuffer, 0, outputBytes);
        device.queue.submit([encoder.finish()]);
        await stagingBuffer.mapAsync(GPUMapMode.READ);
        const chunk = new Float32Array(stagingBuffer.getMappedRange());
        for (let category = 0; category < request.grid.categoryCount; category += 1) {
          const sourceOffset = category * siteCount;
          const destinationOffset = category * request.siteCount + siteOffset;
          for (let site = 0; site < siteCount; site += 1) result[destinationOffset + site] = chunk[sourceOffset + site]!;
        }
        stagingBuffer.unmap();
        stagingBuffer.destroy();
        outputBuffer.destroy();
        tipBuffer.destroy();
        request.onProgress?.((siteOffset + siteCount) / request.siteCount, {
          message: `${(siteOffset + siteCount).toLocaleString()}/${request.siteCount.toLocaleString()} site chunks read back · all ${request.grid.categoryCount.toLocaleString()} categories per site`,
          current: (siteOffset + siteCount) * request.grid.categoryCount,
          total: categorySites,
        });
      }
    } finally {
      parameterBuffer.destroy();
      metadataBuffer.destroy();
      modelBuffer.destroy();
    }
    return { logLikelihoods: result, backend: "webgpu", elapsedMs: performance.now() - started, precision: "f32" };
  }
}

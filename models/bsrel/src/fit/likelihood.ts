import {
  buildModelBank,
  type BsrelKernelRequest,
  type DifFUBARGrid,
  type FittedModel,
  type ModelBank,
  type ParsedTree,
  type WasmBackend,
  type ParallelWasmBackend,
} from "@phylo-workbench/model-diffubar";
import type { CompiledBsrelTree } from "../tree/messages.js";
import type { DecodedBranchModel } from "../model/parameters.js";

type KernelBackend = Pick<WasmBackend | ParallelWasmBackend, "evaluateBsrel">;

export interface LocalBranchCandidate {
  readonly edge: number;
  readonly model: DecodedBranchModel;
}

function modelGrid(omegas: Float64Array): DifFUBARGrid {
  const categories = new Float64Array(omegas.length * 2);
  for (let index = 0; index < omegas.length; index += 1) {
    categories[index * 2] = 1;
    categories[index * 2 + 1] = omegas[index]!;
  }
  return {
    alpha: new Float64Array(omegas.length).fill(1),
    omega: omegas,
    backgroundOmega: new Float64Array(0),
    categories,
    categoryCount: omegas.length,
    parameterCount: 2,
    hasBackground: false,
  };
}

function packModels(
  tree: ParsedTree,
  fittedModel: FittedModel,
  baseline: readonly DecodedBranchModel[],
  candidates: readonly LocalBranchCandidate[],
): {
  readonly bank: ModelBank;
  readonly branchModels: Uint32Array;
  readonly candidateModels: Uint32Array;
} {
  const omegas = new Float64Array((baseline.length + candidates.length) * 3);
  let offset = 0;
  for (const model of baseline) {
    omegas[offset++] = model.omegaMinus;
    omegas[offset++] = model.omegaNeutral;
    omegas[offset++] = model.omegaPositive;
  }
  for (const candidate of candidates) {
    omegas[offset++] = candidate.model.omegaMinus;
    omegas[offset++] = candidate.model.omegaNeutral;
    omegas[offset++] = candidate.model.omegaPositive;
  }
  const bank = buildModelBank(modelGrid(omegas), tree, fittedModel.gtrRates, fittedModel.f3x4, fittedModel.geneticCodeId);
  return {
    bank,
    branchModels: bank.gridModels.slice(0, baseline.length * 3),
    candidateModels: bank.gridModels.slice(baseline.length * 3),
  };
}

export class BsrelLikelihood {
  constructor(
    private readonly backend: KernelBackend,
    private readonly compiled: CompiledBsrelTree,
    private readonly tree: ParsedTree,
    private readonly tipStates: Uint8Array,
    private readonly siteCount: number,
    private readonly fittedModel: FittedModel,
    private readonly signal?: AbortSignal,
  ) {}

  async evaluate(
    baseline: readonly DecodedBranchModel[],
    candidates: readonly LocalBranchCandidate[] = [],
  ): Promise<{ readonly objectives: Float64Array; readonly backend: "wasm" | "wasm-parallel"; readonly elapsedMs: number }> {
    this.signal?.throwIfAborted();
    const { bank, branchModels, candidateModels } = packModels(this.tree, this.fittedModel, baseline, candidates);
    const branchLengths = Float64Array.from(baseline, (model) => model.length);
    const branchWeights = new Float64Array(baseline.length * 3);
    for (let edge = 0; edge < baseline.length; edge += 1) {
      const model = baseline[edge]!;
      branchWeights.set([model.weightMinus, model.weightNeutral, model.weightPositive], edge * 3);
    }
    const candidateBranches = Uint32Array.from(candidates, (candidate) => candidate.edge);
    const candidateLengths = Float64Array.from(candidates, (candidate) => candidate.model.length);
    const candidateWeights = new Float64Array(candidates.length * 3);
    for (let index = 0; index < candidates.length; index += 1) {
      const model = candidates[index]!.model;
      candidateWeights.set([model.weightMinus, model.weightNeutral, model.weightPositive], index * 3);
    }
    const request: BsrelKernelRequest = {
      tree: this.compiled.kernel,
      tipStates: this.tipStates,
      siteCount: this.siteCount,
      branchLengths,
      branchModels,
      branchWeights,
      candidateBranches,
      candidateLengths,
      candidateModels,
      candidateWeights,
      models: bank,
      equilibrium: this.fittedModel.codonEquilibrium,
      ...(this.signal === undefined ? {} : { signal: this.signal }),
    };
    return this.backend.evaluateBsrel(request);
  }
}

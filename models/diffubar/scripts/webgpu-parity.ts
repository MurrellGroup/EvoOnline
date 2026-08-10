import { create, globals } from "webgpu";
import {
  WasmBackend,
  WebGPUBackend,
  buildModelBank,
  codonEquilibriumFromF3x4,
  compileTree,
  countF3x4,
  createDifFUBARGrid,
  encodeCodonTips,
  parseFasta,
  parseTaggedNewick,
} from "../src/index.js";

Object.assign(globalThis, globals);
let gpu = create([]);
const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
if (adapter === null) {
  process.stdout.write("WebGPU execution skipped: Dawn found no physical or software adapter.\n");
  gpu = undefined as unknown as ReturnType<typeof create>;
} else {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { gpu } });
  try {
    const alignment = parseFasta(">a\nAAACCC\n>b\nAAGCCC\n>c\nGGGTTT\n>d\nGGATTC\n");
    const tree = parseTaggedNewick("((a{G1}:0.07,b{G1}:0.09){G1}:0.03,(c{G2}:0.08,d{G2}:0.06){G2}:0.04);");
    const grid = createDifFUBARGrid(false, 1, 1);
    const f3x4 = countF3x4(alignment);
    const request = {
      tree: compileTree(tree),
      tipStates: encodeCodonTips(alignment, tree),
      siteCount: alignment.codonSites,
      grid,
      models: buildModelBank(grid, tree, Float64Array.of(1, 1, 1, 1, 1, 1), f3x4),
      equilibrium: codonEquilibriumFromF3x4(f3x4),
      poissonTerms: 20,
      maxLambdaPerStep: 1,
    } as const;
    const reference = await new WasmBackend().evaluate(request);
    const candidate = await new WebGPUBackend().evaluate(request);
    let maximumAbsoluteError = 0;
    for (let index = 0; index < reference.logLikelihoods.length; index += 1) {
      const error = Math.abs(reference.logLikelihoods[index]! - candidate.logLikelihoods[index]!);
      if (!Number.isFinite(error)) throw new Error(`Non-finite GPU result at output ${index}.`);
      maximumAbsoluteError = Math.max(maximumAbsoluteError, error);
    }
    if (maximumAbsoluteError > 5e-3) {
      throw new Error(`WebGPU f32 parity failed: max |Δ log L|=${maximumAbsoluteError}.`);
    }
    process.stdout.write(`WebGPU execution parity passed; max |Δ log L|=${maximumAbsoluteError.toExponential(3)}.\n`);
  } finally {
    delete (globalThis as { navigator?: unknown }).navigator;
    gpu = undefined as unknown as ReturnType<typeof create>;
  }
}

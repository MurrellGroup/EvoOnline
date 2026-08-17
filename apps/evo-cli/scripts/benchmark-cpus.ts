import { availableCpuCount } from "../src/cpu.js";
import { runSelectionMethodIsolated, runSourceMethodIsolated } from "../src/analysis-worker.js";
import type { ParameterValues } from "@phylo-workbench/model-sdk";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { inferFastTree, type FastTreeRuntime } from "../src/fasttree.js";
import { DEFAULT_SIMULATOR_CONFIG } from "@phylo-workbench/model-simulator";
import { runSimulatorParallel } from "../src/simulator-parallel.js";

const alignment = await readFile(new URL("../tests/fixtures/smoke.fasta", import.meta.url), "utf8");
const ordinaryTree = "((A:0.08,B:0.1):0.05,(C:0.12,(D:0.09,E:0.1):0.04):0.05);";
const taggedTree = "((A{G1}:0.08,B{G1}:0.1){G1}:0.05,(C{G2}:0.12,(D{G2}:0.09,E{G2}:0.1){G2}:0.04){G2}:0.05);";
const parallelCpus = Math.min(4, availableCpuCount());

interface BenchmarkCase {
  readonly id: string;
  readonly tree: string;
  readonly parameters: ParameterValues;
}

const cases: readonly BenchmarkCase[] = [
  { id: "diffubar", tree: taggedTree, parameters: { foregroundGrid: 3, backgroundGrid: 2, iterations: 20, burnin: 4, seed: 7 } },
  { id: "fubar", tree: ordinaryTree, parameters: { gridPoints: 8, iterations: 20, inferenceMethod: "dirichlet-em" } },
  { id: "bsrel", tree: ordinaryTree, parameters: { alternativeIterations: 1, nullIterations: 1 } },
  { id: "fame", tree: ordinaryTree, parameters: { gridPreset: "fast", iterations: 20, quadraturePoints: 2 } },
  { id: "flavor", tree: ordinaryTree, parameters: { gridPreset: "fast", iterations: 20, gammaSlices: 4 } },
  { id: "glamma", tree: ordinaryTree, parameters: { omegaSlices: 3, alphaSlices: 2, fitPreset: "fast" } },
  { id: "clade-shift", tree: ordinaryTree, parameters: { gridPoints: 6, posteriorComponents: 16, inferenceIterations: 20, intensityPreset: "fast" } },
];

process.stdout.write(`CPU benchmark · ${availableCpuCount()} logical CPUs · ${parallelCpus} independent analyses per method\n`);
process.stdout.write("method\tsequential wall ms\tparallel wall ms\tspeedup\n");
for (const entry of cases) {
  const job = () => runSelectionMethodIsolated(entry.id, alignment, entry.tree, entry.parameters, () => {}, undefined, 1);
  // Prime filesystem and runtime caches so one cold first worker cannot make a
  // throughput ratio appear super-linear.
  await job();
  let started = performance.now();
  for (let index = 0; index < parallelCpus; index += 1) await job();
  const sequentialMs = performance.now() - started;
  started = performance.now();
  await Promise.all(Array.from({ length: parallelCpus }, job));
  const parallelMs = performance.now() - started;
  process.stdout.write(`${entry.id}\t${sequentialMs.toFixed(1)}\t${parallelMs.toFixed(1)}\t${(sequentialMs / parallelMs).toFixed(2)}x\n`);
}

process.stdout.write("\nThis measures the CLI's route/dataset worker layer, including worker startup. Larger single analyses additionally use each method's tested internal site/category worker pool. Results depend on core count, memory bandwidth, and input size.\n");

const measureBatch = async (job: () => Promise<unknown>): Promise<{ readonly sequentialMs: number; readonly parallelMs: number }> => {
  let started = performance.now();
  for (let index = 0; index < parallelCpus; index += 1) await job();
  const sequentialMs = performance.now() - started;
  started = performance.now();
  await Promise.all(Array.from({ length: parallelCpus }, job));
  return { sequentialMs, parallelMs: performance.now() - started };
};

const mockRuntime: FastTreeRuntime = {
  binary: fileURLToPath(new URL("../tests/fixtures/mock-fasttree.mjs", import.meta.url)),
  label: "benchmark mock FastTree",
};
const previousDelay = process.env.MOCK_FASTTREE_DELAY_MS;
process.env.MOCK_FASTTREE_DELAY_MS = "75";
try {
  process.stdout.write("\nsource method\tsequential wall ms\tparallel wall ms\tspeedup\n");
  const sourceCases = [
    { id: "fsart" as const, parameters: { runFastTree: true, runTreeHmm: false, maximumTriplets: 100, minimumSegmentLength: 12 } },
    { id: "mosaic-spr" as const, parameters: { useBreakpointProposals: false, minimumSegmentLength: 12, maximumSprStates: 8, maximumSprIterations: 2, sprBeamWidth: 2, maximumSprStarts: 1 } },
    { id: "jemspr" as const, parameters: { linkedLikelihood: true, likelihoodRefinement: false, minimumWindow: 12, maximumDyadicTrees: 4, rootPlacements: 1, maximumGraphStates: 8, maximumGraphIterations: 1, neighbourScreen: 8, frontierStates: 2, maximumReticulations: 1, networkBeamWidth: 2, eventPoolSize: 4 } },
  ] as const;
  for (const entry of sourceCases) {
    const job = () => runSourceMethodIsolated(entry.id, alignment, entry.parameters, mockRuntime, () => {}, 1);
    await job();
    const measured = await measureBatch(job);
    process.stdout.write(`${entry.id}\t${measured.sequentialMs.toFixed(1)}\t${measured.parallelMs.toFixed(1)}\t${(measured.sequentialMs / measured.parallelMs).toFixed(2)}x\n`);
  }
  const fastTreeJob = () => inferFastTree(mockRuntime, alignment, true, 1);
  await fastTreeJob();
  const fastTree = await measureBatch(fastTreeJob);
  process.stdout.write(`fasttree\t${fastTree.sequentialMs.toFixed(1)}\t${fastTree.parallelMs.toFixed(1)}\t${(fastTree.sequentialMs / fastTree.parallelMs).toFixed(2)}x\n`);
} finally {
  if (previousDelay === undefined) delete process.env.MOCK_FASTTREE_DELAY_MS;
  else process.env.MOCK_FASTTREE_DELAY_MS = previousDelay;
}

const simulatorConfig = {
  ...DEFAULT_SIMULATOR_CONFIG,
  tree: { ...DEFAULT_SIMULATOR_CONFIG.tree, observedTips: 30, initialTips: 30, replicates: 8 },
  codon: { ...DEFAULT_SIMULATOR_CONFIG.codon, sites: 2_000 },
};
await runSimulatorParallel(simulatorConfig, 1, () => {});
let started = performance.now();
const serialSimulation = await runSimulatorParallel(simulatorConfig, 1, () => {});
const simulatorSerialMs = performance.now() - started;
started = performance.now();
const parallelSimulation = await runSimulatorParallel(simulatorConfig, parallelCpus, () => {});
const simulatorParallelMs = performance.now() - started;
if (serialSimulation.datasets.map((dataset) => dataset.fasta).join("\n") !== parallelSimulation.datasets.map((dataset) => dataset.fasta).join("\n")) {
  throw new Error("Parallel simulator output differs from the seeded serial output.");
}
process.stdout.write(`\nsimulator replicates\t${simulatorSerialMs.toFixed(1)}\t${simulatorParallelMs.toFixed(1)}\t${(simulatorSerialMs / simulatorParallelMs).toFixed(2)}x\n`);

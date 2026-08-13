import { mkdir, readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { analyzeJemspr } from "../../jemspr/src/pipeline.js";
import type { JemsprAnalysisResult, JemsprOptions } from "../../jemspr/src/types.js";
import { createFastTreeEvaluator } from "../../fsart/simulations/fasttree.js";
import { isFullyResolvedTopology } from "../../fsart/src/tree-discordance.js";
import { parseMosaicSprFasta } from "../src/alignment.js";
import { proposeMosaicSprBreakpoints } from "../src/proposals.js";
import { reconstructSprHistory } from "../src/reconstruction.js";
import { topologySignature, topologySplitDistance } from "../src/spr-tree.js";
import type { SprReconstructionResult } from "../src/types.js";
import { mosaicSprTreeWindows } from "../src/windows.js";

interface TruthRun { readonly start: number; readonly end: number; readonly tree: string }
interface BreakpointScore { readonly predicted: number; readonly truePositive: number; readonly precision: number | null; readonly recall: number; readonly f1: number; readonly mae: number | null }
interface ComparisonRow {
  readonly replicate: number;
  readonly method: "JEMSPR fixed web defaults" | "JEMSPR expanded search" | "MosaicSPR web defaults";
  readonly runtimeMs: number;
  readonly proposalMs: number;
  readonly treeFitMs: number;
  readonly reconstructionMs: number;
  readonly siteUnrootedRf: number;
  readonly exactTreeFraction: number;
  readonly breakpoint: BreakpointScore;
  readonly runs: number;
  readonly distinctTrees: number;
  readonly templates: number | null;
  readonly occurrences: number | null;
  readonly maximumOverlap: number | null;
  readonly breakpointEvents: number;
  readonly totalSprEdits: number | null;
  readonly maximumMasterSprDistance: number | null;
  readonly proposalCount: number | null;
  readonly seedTreeCount: number | null;
}

const JEMSPR_DEFAULTS: JemsprOptions = {
  scoreMethod: "fitch",
  minimumWindow: 120,
  maximumDyadicTrees: 16,
  rootPlacements: 3,
  maximumGraphStates: 36,
  maximumGraphIterations: 10,
  neighbourScreen: 72,
  frontierStates: 4,
  nearImprovers: 2,
  pathBreakpointPenalty: 4,
  pathEndpointPenalty: 1,
  pathSpanPenalty: 0.002,
  maximumReticulations: 5,
  overlapCap: 3,
  networkBeamWidth: 8,
  eventPoolSize: 20,
  eventOpenPenalty: 2,
  eventClosePenalty: 0,
  networkBreakpointPenalty: 2,
  eventSpanPenalty: 0.002,
  reticulationPenalty: 2,
  boundaryConvention: "open",
  boundaryCensorPenalty: 2,
  uncertaintyTolerance: 2,
  transitionCost: 0.5,
  transversionCost: 1,
};

const JEMSPR_EXPANDED: JemsprOptions = {
  ...JEMSPR_DEFAULTS,
  maximumGraphStates: 48,
  maximumGraphIterations: 12,
  neighbourScreen: 96,
  frontierStates: 5,
  nearImprovers: 4,
  networkBeamWidth: 10,
  eventPoolSize: 24,
};

function parseTruthRuns(text: string): TruthRun[] {
  return text.trim().split("\n").slice(1).map((line) => {
    const [start, end, _signature, tree] = line.split("\t");
    if (tree === undefined) throw new Error(`Malformed truth row: ${line}`);
    return { start: Number(start), end: Number(end), tree };
  });
}

function truthTrees(runs: readonly TruthRun[], sites: number): string[] {
  const output = new Array<string>(sites);
  for (const run of runs) for (let site = run.start; site <= run.end; site += 1) output[site - 1] = run.tree;
  if (output.some((tree) => tree === undefined)) throw new Error("Truth local-tree runs do not span the alignment.");
  return output;
}

function predictedTrees(runs: readonly { readonly start: number; readonly end: number; readonly tree: string }[], sites: number): string[] {
  const output = new Array<string>(sites);
  for (const run of runs) for (let site = run.start; site <= run.end; site += 1) output[site - 1] = run.tree;
  if (output.some((tree) => tree === undefined)) throw new Error("Predicted local-tree runs do not span the alignment.");
  return output;
}

function topologyScore(truth: readonly string[], inferred: readonly string[], taxa: number): Readonly<{ rf: number; exact: number }> {
  const denominator = Math.max(1, taxa - 3);
  let rf = 0;
  let exact = 0;
  const cache = new Map<string, number>();
  for (let site = 0; site < truth.length; site += 1) {
    const key = `${truth[site]}\n${inferred[site]}`;
    let distance = cache.get(key);
    if (distance === undefined) {
      distance = topologySplitDistance(truth[site]!, inferred[site]!);
      cache.set(key, distance);
    }
    rf += distance / denominator;
    if (distance === 0) exact += 1;
  }
  return { rf: rf / truth.length, exact: exact / truth.length };
}

function matchBreakpoints(truth: readonly number[], predicted: readonly number[], tolerance: number): readonly number[] {
  interface Match { readonly count: number; readonly error: number; readonly errors: readonly number[] }
  const table: Match[][] = Array.from({ length: truth.length + 1 }, () => Array.from({ length: predicted.length + 1 }, () => ({ count: 0, error: 0, errors: [] })));
  const better = (a: Match, b: Match): Match => a.count !== b.count ? (a.count > b.count ? a : b) : a.error <= b.error ? a : b;
  for (let i = 1; i <= truth.length; i += 1) for (let j = 1; j <= predicted.length; j += 1) {
    let selected = better(table[i - 1]![j]!, table[i]![j - 1]!);
    const error = Math.abs(truth[i - 1]! - predicted[j - 1]!);
    if (error <= tolerance) {
      const previous = table[i - 1]![j - 1]!;
      selected = better(selected, { count: previous.count + 1, error: previous.error + error, errors: [...previous.errors, error] });
    }
    table[i]![j] = selected;
  }
  return table[truth.length]![predicted.length]!.errors;
}

function breakpointScore(truth: readonly number[], predicted: readonly number[], sites: number): BreakpointScore {
  const errors = matchBreakpoints(truth, predicted, Math.max(12, Math.round(0.025 * sites)));
  const truePositive = errors.length;
  const precision = predicted.length === 0 ? null : truePositive / predicted.length;
  const recall = truth.length === 0 ? 1 : truePositive / truth.length;
  return {
    predicted: predicted.length,
    truePositive,
    precision,
    recall,
    f1: precision === null || precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall),
    mae: errors.length === 0 ? null : errors.reduce((sum, value) => sum + value, 0) / errors.length,
  };
}

function jemsprRow(replicate: number, method: ComparisonRow["method"], result: JemsprAnalysisResult, runtimeMs: number, truth: readonly string[], breakpoints: readonly number[]): ComparisonRow {
  const trees = new Map(result.network.trees.map((tree) => [tree.id, tree.tree]));
  const runs = result.network.runs.map((run) => ({ start: run.start, end: run.end, tree: trees.get(run.treeId)! }));
  const topology = topologyScore(truth, predictedTrees(runs, result.sites), result.taxa);
  return {
    replicate, method, runtimeMs,
    proposalMs: 0,
    treeFitMs: result.timings.pathSearchMs ?? 0,
    reconstructionMs: result.timings.networkSearchMs ?? 0,
    siteUnrootedRf: topology.rf,
    exactTreeFraction: topology.exact,
    breakpoint: breakpointScore(breakpoints, runs.slice(1).map((run) => run.start - 1), result.sites),
    runs: runs.length,
    distinctTrees: result.network.trees.length,
    templates: result.network.templates.length,
    occurrences: result.network.occurrences.length,
    maximumOverlap: result.network.maximumOverlapUsed,
    breakpointEvents: Math.max(0, runs.length - 1),
    totalSprEdits: null,
    maximumMasterSprDistance: null,
    proposalCount: null,
    seedTreeCount: result.diagnostics.dyadicSeeds,
  };
}

async function mosaicRow(replicate: number, fasta: string, fastTree: string, truth: readonly string[], breakpoints: readonly number[]): Promise<ComparisonRow> {
  const started = performance.now();
  const alignment = parseMosaicSprFasta(fasta);
  const proposalStarted = performance.now();
  const proposal = proposeMosaicSprBreakpoints(alignment, {
    enabled: true,
    window: 24,
    maximumTriplets: 250_000,
    maximumSignals: 1024,
    maximumReportedSignals: 256,
    maximumBreakpoints: 14,
    minimumSegmentLength: 150,
  });
  const proposalMs = performance.now() - proposalStarted;
  const windows = mosaicSprTreeWindows(proposal.proposals, alignment.sites, proposal.diagnostics.minimumTreeSpan, true);
  const evaluator = createFastTreeEvaluator(fastTree, fasta, true);
  const fitStarted = performance.now();
  const trees: string[] = [];
  const signatures = new Set<string>();
  for (const window of windows) {
    const score = await evaluator.evaluate(window.start, window.end);
    if (!isFullyResolvedTopology(score.tree)) continue;
    const signature = topologySignature(score.tree);
    if (signatures.has(signature)) continue;
    signatures.add(signature);
    trees.push(score.tree);
  }
  const treeFitMs = performance.now() - fitStarted;
  if (trees.length === 0) throw new Error("FastTree produced no resolved MosaicSPR seeds.");
  const reconstructionStarted = performance.now();
  const reconstruction = reconstructSprHistory(alignment, trees, {
    minimumRunLength: proposal.diagnostics.minimumTreeSpan,
    maximumStates: 48,
    maximumIterations: 12,
    beamWidth: 4,
    parsimonyScreenLimit: 96,
    maximumStarts: 3,
    patience: 5,
  });
  const reconstructionMs = performance.now() - reconstructionStarted;
  return materializeMosaic(replicate, reconstruction, performance.now() - started, proposalMs, treeFitMs, reconstructionMs, trees.length, proposal.proposals.length, truth, breakpoints, alignment.taxa, alignment.sites);
}

function materializeMosaic(replicate: number, result: SprReconstructionResult, runtimeMs: number, proposalMs: number, treeFitMs: number, reconstructionMs: number, seedTreeCount: number, proposalCount: number, truth: readonly string[], breakpoints: readonly number[], taxa: number, sites: number): ComparisonRow {
  const states = new Map(result.states.map((state) => [state.id, state.tree]));
  const runs = result.runs.map((run) => ({ start: run.start, end: run.end, tree: states.get(run.stateId)! }));
  const topology = topologyScore(truth, predictedTrees(runs, sites), taxa);
  const distinctTrees = new Set(result.runs.map((run) => run.stateId)).size;
  return {
    replicate,
    method: "MosaicSPR web defaults",
    runtimeMs,
    proposalMs,
    treeFitMs,
    reconstructionMs,
    siteUnrootedRf: topology.rf,
    exactTreeFraction: topology.exact,
    breakpoint: breakpointScore(breakpoints, result.events.map((event) => event.breakpoint), sites),
    runs: result.runs.length,
    distinctTrees,
    templates: null,
    occurrences: null,
    maximumOverlap: null,
    breakpointEvents: result.events.length,
    totalSprEdits: result.events.reduce((sum, event) => sum + event.sprDistance, 0),
    maximumMasterSprDistance: Math.max(0, ...result.derivations.map((entry) => entry.sprDistanceFromMaster)),
    proposalCount,
    seedTreeCount,
  };
}

const mean = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);

function markdown(rows: readonly ComparisonRow[], truthBreakpoints: readonly number[]): string {
  const methods = Array.from(new Set(rows.map((row) => row.method)));
  const summary = methods.map((method) => {
    const selected = rows.filter((row) => row.method === method);
    return `| ${method} | ${(mean(selected.map((row) => row.runtimeMs)) / 1000).toFixed(2)} | ${mean(selected.map((row) => row.siteUnrootedRf)).toFixed(3)} | ${(100 * mean(selected.map((row) => row.exactTreeFraction))).toFixed(1)}% | ${mean(selected.map((row) => row.breakpoint.f1)).toFixed(3)} | ${mean(selected.map((row) => row.breakpoint.predicted)).toFixed(2)} | ${mean(selected.map((row) => row.runs)).toFixed(2)} |`;
  }).join("\n");
  const individual = rows.map((row) => `| ${row.replicate} | ${row.method} | ${(row.runtimeMs / 1000).toFixed(2)} | ${row.siteUnrootedRf.toFixed(3)} | ${(100 * row.exactTreeFraction).toFixed(1)}% | ${row.breakpoint.f1.toFixed(3)} | ${row.breakpoint.predicted} | ${row.runs} | ${row.distinctTrees} | ${row.templates ?? "—"} | ${row.occurrences ?? "—"} | ${row.totalSprEdits ?? "—"} |`).join("\n");
  return `# JEMSPR versus MosaicSPR on the same complex mosaics

Truth: four persistent rSPR templates, five interval occurrences, ${truthBreakpoints.length} breakpoint coordinates, nine distinct local trees, and maximum overlap three. Three independently evolved 8-taxon, 1,200-nt GTR alignments use the same planted history.

## Mean performance

| Method | Mean runtime s | Site unrooted RF ↓ | Exact-tree sites ↑ | Breakpoint F1 ↑ | Predicted breakpoints | Runs |
|---|---:|---:|---:|---:|---:|---:|
${summary}

## Every run

| Replicate | Method | Runtime s | Site unrooted RF ↓ | Exact-tree sites ↑ | BP F1 | Predicted BPs | Runs | Trees | Templates | Occurrences | Boundary SPR edits |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${individual}

MosaicSPR uses the real production pipeline: default triplet proposals, the proposal/overlap window family, FastTree 2.1.11 \`-fastest\` seed fits, and default SPR reconstruction settings. JEMSPR fixed defaults use the repaired production search and exact parameter defaults in the web manifest. The expanded-search row changes only search budgets (48 tree-graph states, 12 expansion rounds, 96 neighbour screens, beam 10, event pool 24); it does not weaken the selected-model penalties.

Runtime caveat: MosaicSPR's seed trees were fitted with native FastTree 2.1.11; EvoOnline uses the same FastTree version through bioWASM, so browser wall time will generally be higher. Accuracy inputs and downstream algorithms are otherwise the same.
`;
}

async function main(): Promise<void> {
  const source = process.argv[2] ?? "models/jemspr/benchmarks/results/complex-recombinant";
  const truthSource = process.argv[3] ?? "/workspace/scratch/7f088fc1fd73/jemspr-truth-export";
  const fastTree = process.argv[4] ?? process.env.FASTTREE_211 ?? "/workspace/scratch/7f088fc1fd73/FastTree-2.1.11";
  const output = process.argv[5] ?? "models/mosaicspr/benchmarks/results/jemspr-comparison";
  const truthMeta = JSON.parse(await readFile(`${source}/truth.json`, "utf8")) as { readonly sites: number; readonly taxa: number; readonly breakpoints: readonly number[] };
  const truth = truthTrees(parseTruthRuns(await readFile(`${truthSource}/truth-local-trees.tsv`, "utf8")), truthMeta.sites);
  const rows: ComparisonRow[] = [];
  for (let replicate = 1; replicate <= 3; replicate += 1) {
    const fasta = await readFile(`${source}/replicate-${replicate}.fasta`, "utf8");
    for (const [method, options] of [["JEMSPR fixed web defaults", JEMSPR_DEFAULTS], ["JEMSPR expanded search", JEMSPR_EXPANDED]] as const) {
      process.stderr.write(`replicate ${replicate} · ${method} ... `);
      const started = performance.now();
      const result = await analyzeJemspr(fasta, options);
      const row = jemsprRow(replicate, method, result, performance.now() - started, truth, truthMeta.breakpoints);
      rows.push(row);
      process.stderr.write(`${(row.runtimeMs / 1000).toFixed(2)} s · RF ${row.siteUnrootedRf.toFixed(3)} · BP F1 ${row.breakpoint.f1.toFixed(3)}\n`);
    }
    process.stderr.write(`replicate ${replicate} · MosaicSPR web defaults ... `);
    const mosaic = await mosaicRow(replicate, fasta, fastTree, truth, truthMeta.breakpoints);
    rows.push(mosaic);
    process.stderr.write(`${(mosaic.runtimeMs / 1000).toFixed(2)} s · RF ${mosaic.siteUnrootedRf.toFixed(3)} · BP F1 ${mosaic.breakpoint.f1.toFixed(3)}\n`);
  }
  await mkdir(output, { recursive: true });
  await writeFile(`${output}/results.json`, JSON.stringify({ truth: truthMeta, rows }, null, 2));
  await writeFile(`${output}/REPORT.md`, markdown(rows, truthMeta.breakpoints));
  process.stdout.write(markdown(rows, truthMeta.breakpoints));
}

await main();

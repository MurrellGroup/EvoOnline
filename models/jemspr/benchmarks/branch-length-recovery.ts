import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FixedGtrModel } from "@phylo-workbench/phylo-likelihood";
import { parseJemsprFasta } from "../src/alignment.js";
import { fitLinkedNetworkLikelihood } from "../src/likelihood-refinement.js";
import { compileReticulation, displayNetwork, treeNetwork, type NetworkDisplay, type SwitchingNetwork } from "../src/switching-network.js";
import { enumerateRootedSprNeighbours, leafSet, type RootedNode } from "../src/tree.js";
import type { JemsprFixedGtrModel } from "../src/types.js";

export interface RecoveryMetrics {
  readonly sites: number;
  readonly replicate: number;
  readonly elapsedMs: number;
  readonly logLikelihood: number;
  readonly patristicMae: number;
  readonly patristicRrmse: number;
  readonly patristicBias: number;
  readonly patristicCorrelation: number;
  readonly patristicSlope: number;
  readonly maximumAbsoluteError: number;
  readonly trueMeanDistance: number;
  readonly fittedMeanDistance: number;
  readonly atomicEdges: number;
  readonly nonidentifiableGroups: number;
}

const BASES = ["A", "C", "G", "T"] as const;
const cladeKey = (node: RootedNode): string => leafSet(node).join(",");
const edgeKey = (parent: number, child: number): string => `${parent}>${child}`;

class Random {
  private state: number;
  constructor(seed: number) { this.state = seed >>> 0 || 1; }
  next(): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state / 0x1_0000_0000;
  }
  categorical(probabilities: ArrayLike<number>, offset = 0): number {
    let draw = this.next();
    for (let index = 0; index < 4; index += 1) {
      draw -= probabilities[offset + index]!;
      if (draw <= 0) return index;
    }
    return 3;
  }
}

const master: RootedNode = {
  children: [
    { children: [{ children: [{ leaf: 0 }, { leaf: 1 }] }, { children: [{ leaf: 2 }, { leaf: 3 }] }] },
    { children: [{ leaf: 4 }, { leaf: 5 }] },
  ],
};

function oneSprNetwork(): SwitchingNetwork {
  const base = treeNetwork(master);
  for (const neighbour of enumerateRootedSprNeighbours(master)) {
    if (neighbour.move.pruned.length > 2 || neighbour.move.destinationIsRoot) continue;
    const compiled = compileReticulation(base, 0, neighbour.move);
    if (compiled !== undefined && displayNetwork(compiled, 1)?.signature === neighbour.signature) return compiled;
  }
  throw new Error("Could not compile a deterministic one-SPR benchmark network.");
}

function knownNetworkLengths(network: SwitchingNetwork): ReadonlyMap<string, number> {
  const horizontal = new Set(network.reticulations.map((event) => edgeKey(event.alternateParentNode, event.reticulationNode)));
  const output = new Map<string, number>();
  for (const node of network.nodes) {
    for (const child of node.children) {
      const key = edgeKey(node.id, child);
      output.set(key, horizontal.has(key) ? 0 : 0.012 + 0.007 * ((node.id * 11 + child * 7 + 3) % 9));
    }
  }
  return output;
}

function branchLength(display: NetworkDisplay, child: RootedNode, lengths: ReadonlyMap<string, number>): number {
  const origins = display.edgeOrigins.get(cladeKey(child));
  if (origins === undefined) throw new Error(`Display branch ${cladeKey(child)} has no origin path.`);
  let total = 0;
  for (const edge of origins) total += lengths.get(edgeKey(edge.parent, edge.child)) ?? 0;
  return total;
}

function simulateDisplay(
  display: NetworkDisplay,
  sites: number,
  model: FixedGtrModel,
  lengths: ReadonlyMap<string, number>,
  random: Random,
  output: string[][],
): void {
  const transitions = new Map<string, Float64Array>();
  const prepare = (node: RootedNode): void => {
    if ("leaf" in node) return;
    for (const child of node.children) {
      transitions.set(cladeKey(child), model.transition(branchLength(display, child, lengths)).matrix);
      prepare(child);
    }
  };
  prepare(display.tree);
  const descend = (node: RootedNode, state: number): void => {
    if ("leaf" in node) {
      output[node.leaf]!.push(BASES[state]!);
      return;
    }
    for (const child of node.children) {
      const matrix = transitions.get(cladeKey(child))!;
      descend(child, random.categorical(matrix, state * 4));
    }
  };
  for (let site = 0; site < sites; site += 1) descend(display.tree, random.categorical(model.frequencies));
}

function simulateAlignment(
  displays: readonly NetworkDisplay[],
  totalSites: number,
  model: FixedGtrModel,
  lengths: ReadonlyMap<string, number>,
  seed: number,
): { readonly fasta: string; readonly maskPath: Int32Array } {
  const sequences: string[][] = Array.from({ length: 6 }, () => []);
  const maskPath = new Int32Array(totalSites);
  const split = Math.floor(totalSites / 2);
  simulateDisplay(displays[0]!, split, model, lengths, new Random(seed), sequences);
  maskPath.fill(1, split);
  simulateDisplay(displays[1]!, totalSites - split, model, lengths, new Random(seed ^ 0x9e3779b9), sequences);
  return {
    fasta: sequences.map((sequence, index) => `>taxon_${index + 1}\n${sequence.join("")}`).join("\n"),
    maskPath,
  };
}

function pairwisePatristic(display: NetworkDisplay, lengths: ReadonlyMap<string, number>, taxa: number): Float64Array {
  interface Edge { readonly node: number; readonly length: number }
  const graph: Edge[][] = [];
  const tips = new Int32Array(taxa).fill(-1);
  const build = (node: RootedNode, parent: number | undefined, incoming: number): number => {
    const id = graph.length;
    graph.push([]);
    if (parent !== undefined) {
      graph[id]!.push({ node: parent, length: incoming });
      graph[parent]!.push({ node: id, length: incoming });
    }
    if ("leaf" in node) tips[node.leaf] = id;
    else for (const child of node.children) build(child, id, branchLength(display, child, lengths));
    return id;
  };
  build(display.tree, undefined, 0);
  const output = new Float64Array(taxa * (taxa - 1) / 2);
  let offset = 0;
  for (let source = 0; source < taxa; source += 1) {
    const distances = new Float64Array(graph.length).fill(Number.NaN);
    distances[tips[source]!] = 0;
    const stack = [tips[source]!];
    while (stack.length > 0) {
      const node = stack.pop()!;
      for (const edge of graph[node]!) {
        if (Number.isFinite(distances[edge.node]!)) continue;
        distances[edge.node] = distances[node]! + edge.length;
        stack.push(edge.node);
      }
    }
    for (let target = source + 1; target < taxa; target += 1) output[offset++] = distances[tips[target]!]!;
  }
  return output;
}

function metrics(truth: Float64Array, fitted: Float64Array): Omit<RecoveryMetrics, "sites" | "replicate" | "elapsedMs" | "logLikelihood" | "atomicEdges" | "nonidentifiableGroups"> {
  let trueMean = 0;
  let fittedMean = 0;
  for (let index = 0; index < truth.length; index += 1) {
    trueMean += truth[index]! / truth.length;
    fittedMean += fitted[index]! / fitted.length;
  }
  let absolute = 0;
  let squared = 0;
  let covariance = 0;
  let trueVariance = 0;
  let fittedVariance = 0;
  let slopeNumerator = 0;
  let slopeDenominator = 0;
  let maximumAbsoluteError = 0;
  for (let index = 0; index < truth.length; index += 1) {
    const error = fitted[index]! - truth[index]!;
    absolute += Math.abs(error) / truth.length;
    squared += error * error / truth.length;
    maximumAbsoluteError = Math.max(maximumAbsoluteError, Math.abs(error));
    covariance += (truth[index]! - trueMean) * (fitted[index]! - fittedMean);
    trueVariance += (truth[index]! - trueMean) ** 2;
    fittedVariance += (fitted[index]! - fittedMean) ** 2;
    slopeNumerator += truth[index]! * fitted[index]!;
    slopeDenominator += truth[index]! * truth[index]!;
  }
  return {
    patristicMae: absolute,
    patristicRrmse: Math.sqrt(squared) / trueMean,
    patristicBias: fittedMean - trueMean,
    patristicCorrelation: covariance / Math.sqrt(trueVariance * fittedVariance),
    patristicSlope: slopeNumerator / slopeDenominator,
    maximumAbsoluteError,
    trueMeanDistance: trueMean,
    fittedMeanDistance: fittedMean,
  };
}

export async function runBranchLengthRecoveryTrial(totalSites: number, replicate: number): Promise<RecoveryMetrics> {
  const network = oneSprNetwork();
  const background = displayNetwork(network, 0);
  const alternate = displayNetwork(network, 1);
  if (background === undefined || alternate === undefined) throw new Error("Benchmark network has an invalid display.");
  const validDisplays: readonly [NetworkDisplay, NetworkDisplay] = [background, alternate];
  const gtr: JemsprFixedGtrModel = {
    frequencies: [0.29, 0.21, 0.24, 0.26],
    exchangeabilities: [0.8, 3.2, 0.7, 1.1, 2.7, 1],
    source: "FastTree-2.1.11-global-fit",
    version: "simulation truth (fixed-matrix recovery isolation)",
  };
  const model = new FixedGtrModel({ frequencies: gtr.frequencies, exchangeabilities: gtr.exchangeabilities });
  const truth = knownNetworkLengths(network);
  const simulated = simulateAlignment(validDisplays, totalSites, model, truth, 0x51f15e + replicate * 7919 + totalSites);
  const alignment = parseJemsprFasta(simulated.fasta);
  const started = performance.now();
  const fitted = fitLinkedNetworkLikelihood(alignment, network, [0, 1], simulated.maskPath, {
    gtrModel: gtr,
    likelihoodRateCategories: 1,
    fitLikelihoodGammaShape: false,
    likelihoodRefinement: false,
    likelihoodIterations: 60,
    likelihoodRefitIterations: 2,
  });
  const fittedLengths = new Map(fitted.atomicBranches.map((edge) => [edgeKey(Number(edge.parentNode.slice(1)), Number(edge.childNode.slice(1))), edge.length]));
  for (const edge of fitted.fixedZeroEdges) fittedLengths.set(edgeKey(Number(edge.parentNode.slice(1)), Number(edge.childNode.slice(1))), 0);
  const trueDistances = Float64Array.from(validDisplays.flatMap((display) => [...pairwisePatristic(display, truth, alignment.taxa)]));
  const fittedDistances = Float64Array.from(validDisplays.flatMap((display) => [...pairwisePatristic(display, fittedLengths, alignment.taxa)]));
  return {
    sites: totalSites,
    replicate,
    elapsedMs: performance.now() - started,
    logLikelihood: fitted.logLikelihood,
    ...metrics(trueDistances, fittedDistances),
    atomicEdges: fitted.atomicBranches.length,
    nonidentifiableGroups: fitted.nonidentifiableGroups.length,
  };
}

function summarize(rows: readonly RecoveryMetrics[]): string {
  const mean = (key: keyof RecoveryMetrics): number => rows.reduce((sum, row) => sum + Number(row[key]), 0) / rows.length;
  return [
    `| ${rows[0]!.sites.toLocaleString()} | ${rows.length} | ${mean("patristicMae").toFixed(5)} | ${(100 * mean("patristicRrmse")).toFixed(2)}% | ${mean("patristicCorrelation").toFixed(4)} | ${mean("patristicSlope").toFixed(4)} | ${mean("patristicBias").toFixed(5)} | ${mean("elapsedMs").toFixed(1)} ms |`,
  ].join("\n");
}

async function main(): Promise<void> {
  const quick = process.argv.includes("--quick");
  const siteCounts = quick ? [2_000, 10_000] : [2_000, 10_000, 50_000];
  const replicates = quick ? 2 : 5;
  const rows: RecoveryMetrics[] = [];
  for (const sites of siteCounts) {
    for (let replicate = 1; replicate <= replicates; replicate += 1) {
      const result = await runBranchLengthRecoveryTrial(sites, replicate);
      rows.push(result);
      console.log(JSON.stringify(result));
    }
  }
  const outputDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "results");
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(resolve(outputDirectory, "BRANCH_LENGTH_RECOVERY.json"), JSON.stringify(rows, null, 2));
  const report = `# JEMSPR linked branch-length recovery\n\n` +
    `A genuine compiled one-SPR switching DAG with six taxa and two equally long genomic regions was simulated under known shared network-edge lengths and a nonuniform GTR matrix. The same fixed GTR matrix was supplied to the fit, isolating branch-length/linkage recovery from uncertainty in FastTree's matrix estimate. Horizontal parent-choice edges were zero-time.\n\n` +
    `Recovery is evaluated with every pairwise patristic distance in both displayed trees. This is the appropriate identifiable target: it is invariant to the arbitrary reversible root split and to network-edge subdivisions that only enter the likelihood through a sum. RRMSE is RMSE divided by the mean true patristic distance.\n\n` +
    `| Sites | Replicates | Patristic MAE | Relative RMSE | Correlation | Zero-intercept slope | Mean bias | Linked-fit time |\n|---:|---:|---:|---:|---:|---:|---:|---:|\n` +
    siteCounts.map((sites) => summarize(rows.filter((row) => row.sites === sites))).join("\n") +
    `\n\nThe test is conditional on the correct fixed GTR matrix and topology/event structure; it is not a test of FastTree's GTR estimation or JEMSPR topology search. Raw replicate results are in \`BRANCH_LENGTH_RECOVERY.json\`.\n`;
  await writeFile(resolve(outputDirectory, "BRANCH_LENGTH_RECOVERY.md"), report);
  console.log(report);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

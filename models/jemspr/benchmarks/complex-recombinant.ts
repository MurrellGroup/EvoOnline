import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { checkNetworkTemporalFeasibility, evaluateFixedSwitchingNetwork } from "../src/network-search.js";
import { parseJemsprFasta } from "../src/alignment.js";
import { scoreTree } from "../src/parsimony.js";
import { analyzeJemspr } from "../src/pipeline.js";
import { compileReticulation, displayNetwork, treeNetwork, type SwitchingNetwork } from "../src/switching-network.js";
import {
  enumerateRootedSprNeighbours,
  leafSet,
  rootedClades,
  treeSignature,
  treeToNewick,
  type RootedNode,
} from "../src/tree.js";
import type { JemsprAnalysisResult, JemsprMaskRun, JemsprOptions } from "../src/types.js";

const NUCLEOTIDES = "ACGT";
const PI = new Float64Array([0.30, 0.20, 0.22, 0.28]);
const EXCHANGEABILITIES = new Float64Array([1.0, 4.2, 0.8, 0.9, 3.6, 1.1]);

interface SimNode {
  readonly leaf?: number;
  readonly length: number;
  readonly children: readonly SimNode[];
}

interface EventInterval {
  readonly bit: number;
  readonly start: number;
  readonly end: number;
}

interface Variant {
  readonly id: string;
  readonly label: string;
  readonly options: JemsprOptions;
}

interface Truth {
  readonly sites: number;
  readonly taxa: number;
  readonly master: RootedNode;
  readonly masterNewick: string;
  readonly network: SwitchingNetwork;
  readonly eventIntervals: readonly EventInterval[];
  readonly maskAtSite: Int32Array;
  readonly treeAtSite: readonly RootedNode[];
  readonly newickAtSite: readonly string[];
  readonly signatures: readonly string[];
  readonly breakpoints: readonly number[];
  readonly maximumOverlap: number;
}

interface SimulatedData {
  readonly truth: Truth;
  readonly fasta: string;
  readonly sequences: readonly string[];
  readonly siteRates: Float64Array;
  readonly meanPairwisePDistance: number;
  readonly variableFraction: number;
  readonly parsimonyInformativeFraction: number;
  readonly rateSummary: Readonly<{ mean: number; invariantFraction: number; median: number; q90: number; maximum: number }>;
}

interface BreakpointMetrics {
  readonly trueCount: number;
  readonly predictedCount: number;
  readonly truePositive: number;
  readonly precision: number | null;
  readonly recall: number;
  readonly f1: number;
  readonly localizationMae: number | null;
  readonly intervalCoverage: number | null;
  readonly meanIntervalWidth: number | null;
}

interface RunMetrics {
  readonly seed: number;
  readonly variant: string;
  readonly runtimeMs: number;
  readonly informativeSites: number;
  readonly siteRootedRf: number;
  readonly siteUnrootedRf: number;
  readonly siteExactRooted: number;
  readonly siteExactUnrooted: number;
  readonly relaxedPathSiteRootedRf: number;
  readonly relaxedPathSiteUnrootedRf: number;
  readonly relaxedPathBreakpointF1: number;
  readonly breakpoint: BreakpointMetrics;
  readonly masterRootedRf: number;
  readonly masterUnrootedRf: number;
  readonly trueTemplates: number;
  readonly inferredTemplates: number;
  readonly trueOccurrences: number;
  readonly inferredOccurrences: number;
  readonly trueMaximumOverlap: number;
  readonly inferredMaximumOverlap: number;
  readonly inferredRegions: number;
  readonly temporal: string;
  readonly graphStates: number;
  readonly graphEdges: number;
  readonly rootStarts: number;
  readonly warnings: readonly string[];
  readonly oracleNetworkSiteRootedRf: number;
  readonly oracleNetworkSiteUnrootedRf: number;
  readonly oracleNetworkBreakpointF1: number;
  readonly oracleNetworkObjective: number;
  readonly plantedHistoryDataParsimony: number;
  readonly plantedHistoryObjective: number;
  readonly oracleDataParsimony: number;
  readonly inferredObjective: number;
}

interface Summary {
  readonly variant: string;
  readonly label: string;
  readonly replicates: number;
  readonly medianRuntimeMs: number;
  readonly q90RuntimeMs: number;
  readonly meanSiteRootedRf: number;
  readonly meanSiteUnrootedRf: number;
  readonly meanSiteExactRooted: number;
  readonly meanSiteExactUnrooted: number;
  readonly meanRelaxedPathRootedRf: number;
  readonly meanRelaxedPathUnrootedRf: number;
  readonly meanRelaxedPathBreakpointF1: number;
  readonly breakpointPrecision: number | null;
  readonly breakpointRecall: number;
  readonly breakpointF1: number;
  readonly breakpointLocalizationMae: number | null;
  readonly breakpointIntervalCoverage: number | null;
  readonly meanInferredTemplates: number;
  readonly meanInferredOccurrences: number;
  readonly meanInferredRegions: number;
  readonly meanInferredOverlap: number;
  readonly noEventFraction: number;
  readonly meanOracleNetworkRootedRf: number;
  readonly meanOracleNetworkUnrootedRf: number;
  readonly meanOracleNetworkBreakpointF1: number;
  readonly meanOracleObjectiveMinusInferred: number;
  readonly meanPlantedObjectiveMinusInferred: number;
  readonly temporalFeasibleFraction: number;
}

class Random {
  private state: number;
  private spare: number | undefined;

  constructor(seed: number) { this.state = seed >>> 0 || 0x9e3779b9; }
  uniform(): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return (this.state + 0.5) / 4_294_967_296;
  }
  integer(maximum: number): number { return Math.floor(this.uniform() * maximum); }
  normal(): number {
    if (this.spare !== undefined) { const value = this.spare; this.spare = undefined; return value; }
    const radius = Math.sqrt(-2 * Math.log(Math.max(Number.MIN_VALUE, this.uniform())));
    const angle = 2 * Math.PI * this.uniform();
    this.spare = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  }
  gamma(shape: number): number {
    if (shape < 1) return this.gamma(shape + 1) * this.uniform() ** (1 / shape);
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      const normal = this.normal();
      const transformed = 1 + c * normal;
      if (transformed <= 0) continue;
      const cube = transformed ** 3;
      const uniform = this.uniform();
      if (uniform < 1 - 0.0331 * normal ** 4) return d * cube;
      if (Math.log(uniform) < 0.5 * normal * normal + d * (1 - cube + Math.log(cube))) return d * cube;
    }
  }
}

function balancedTree(leaves: readonly number[]): RootedNode {
  if (leaves.length === 1) return { leaf: leaves[0]! };
  const middle = Math.ceil(leaves.length / 2);
  return { children: [balancedTree(leaves.slice(0, middle)), balancedTree(leaves.slice(middle))] };
}

function eventKey(network: SwitchingNetwork): string {
  return network.reticulations.map((event) => `${event.move.pruned.join(".")}>${event.move.destinationIsRoot ? "ROOT" : event.move.destination.join(".")}`).join(";");
}

function compileComplexNetwork(master: RootedNode): SwitchingNetwork {
  let beam: SwitchingNetwork[] = [treeNetwork(master)];
  const targetReticulations = 4;
  for (let q = 0; q < targetReticulations; q += 1) {
    const children = new Map<string, { readonly network: SwitchingNetwork; readonly quality: number }>();
    for (const parent of beam) {
      const contextMasks = Array.from({ length: 1 << q }, (_value, mask) => mask)
        .filter((mask) => displayNetwork(parent, mask) !== undefined)
        .sort((a, b) => b.toString(2).replaceAll("0", "").length - a.toString(2).replaceAll("0", "").length || a - b);
      for (const context of contextMasks) {
        const display = displayNetwork(parent, context)!;
        const neighbours = enumerateRootedSprNeighbours(display.tree);
        for (let index = 0; index < neighbours.length; index += Math.max(1, Math.floor(neighbours.length / 48))) {
          const child = compileReticulation(parent, context, neighbours[index]!.move);
          if (child === undefined || checkNetworkTemporalFeasibility(child).status !== "rank-feasible") continue;
          const signatures = new Set<string>();
          for (let mask = 0; mask < 1 << (q + 1); mask += 1) signatures.add(displayNetwork(child, mask)!.signature);
          const move = neighbours[index]!.move;
          const cladeSize = move.pruned.length;
          const quality = signatures.size * 30
            + (context === 0 ? 0 : 20)
            + Math.min(cladeSize, leafSet(master).length - cladeSize) * 3
            + (move.destinationIsRoot ? 0 : 4);
          const key = eventKey(child);
          const previous = children.get(key);
          if (previous === undefined || quality > previous.quality) children.set(key, { network: child, quality });
        }
      }
    }
    beam = [...children.values()]
      .sort((a, b) => b.quality - a.quality || eventKey(a.network).localeCompare(eventKey(b.network)))
      .slice(0, 18)
      .map((entry) => entry.network);
    if (beam.length === 0) throw new Error(`Could not construct a rank-feasible ${q + 1}-reticulation truth network.`);
  }
  const selected = beam.find((network) => {
    const signatures = new Set(Array.from({ length: 1 << targetReticulations }, (_value, mask) => displayNetwork(network, mask)!.signature));
    return signatures.size >= 8 && network.reticulations.some((event) => event.sourceContextMask !== 0);
  });
  if (selected === undefined) throw new Error("Could not find a sufficiently rich truth switching network.");
  return selected;
}

function truthHistory(taxa = 10, sites = 2400): Truth {
  const master = balancedTree(Array.from({ length: taxa }, (_value, index) => index));
  const network = compileComplexNetwork(master);
  // Four persistent templates with crossing, nesting, recurrence, simultaneous
  // endpoints, and a tract censored at the right alignment edge.
  const coordinate = (fraction: number): number => Math.max(1, Math.min(sites, Math.round(fraction * sites)));
  const eventIntervals: EventInterval[] = [
    { bit: 0, start: coordinate(0.10) + 1, end: coordinate(0.44) },
    { bit: 1, start: coordinate(0.27) + 1, end: coordinate(0.65) },
    { bit: 2, start: coordinate(0.38) + 1, end: coordinate(0.52) },
    { bit: 0, start: coordinate(0.58) + 1, end: coordinate(0.73) },
    { bit: 3, start: coordinate(0.58) + 1, end: sites },
  ];
  const maskAtSite = new Int32Array(sites);
  const treeAtSite: RootedNode[] = [];
  const newickAtSite: string[] = [];
  const signatures: string[] = [];
  const names = Array.from({ length: taxa }, (_value, index) => `t${index + 1}`);
  let maximumOverlap = 0;
  for (let site = 1; site <= sites; site += 1) {
    let mask = 0;
    for (const event of eventIntervals) if (site >= event.start && site <= event.end) mask |= 1 << event.bit;
    maskAtSite[site - 1] = mask;
    let overlap = 0;
    for (let bits = mask; bits !== 0; bits &= bits - 1) overlap += 1;
    maximumOverlap = Math.max(maximumOverlap, overlap);
    const display = displayNetwork(network, mask);
    if (display === undefined) throw new Error(`Truth network cannot display mask ${mask}.`);
    treeAtSite.push(display.tree);
    signatures.push(display.signature);
    newickAtSite.push(treeToNewick(display.tree, names));
  }
  const breakpoints: number[] = [];
  for (let site = 1; site < sites; site += 1) if (maskAtSite[site - 1] !== maskAtSite[site]) breakpoints.push(site);
  return {
    sites,
    taxa,
    master,
    masterNewick: treeToNewick(master, names),
    network,
    eventIntervals,
    maskAtSite,
    treeAtSite,
    newickAtSite,
    signatures,
    breakpoints,
    maximumOverlap,
  };
}

function nullHistory(reference: Truth): Truth {
  const network = treeNetwork(reference.master);
  const signature = treeSignature(reference.master);
  return {
    ...reference,
    network,
    eventIntervals: [],
    maskAtSite: new Int32Array(reference.sites),
    treeAtSite: Array.from({ length: reference.sites }, () => reference.master),
    newickAtSite: Array.from({ length: reference.sites }, () => reference.masterNewick),
    signatures: Array.from({ length: reference.sites }, () => signature),
    breakpoints: [],
    maximumOverlap: 0,
  };
}

function buildRateMatrix(): Float64Array {
  const matrix = new Float64Array(16);
  const exchangeability = (a: number, b: number): number => {
    const low = Math.min(a, b);
    const high = Math.max(a, b);
    const index = low === 0 ? high - 1 : low === 1 ? high + 1 : 5;
    return EXCHANGEABILITIES[index]!;
  };
  for (let from = 0; from < 4; from += 1) {
    let total = 0;
    for (let to = 0; to < 4; to += 1) {
      if (from === to) continue;
      const value = exchangeability(from, to) * PI[to]!;
      matrix[from * 4 + to] = value;
      total += value;
    }
    matrix[from * 4 + from] = -total;
  }
  let mean = 0;
  for (let state = 0; state < 4; state += 1) mean -= PI[state]! * matrix[state * 4 + state]!;
  for (let index = 0; index < matrix.length; index += 1) matrix[index] = matrix[index]! / mean;
  return matrix;
}

const Q = buildRateMatrix();

function categorical(weights: Float64Array, random: Random): number {
  const draw = random.uniform();
  let cumulative = 0;
  for (let index = 0; index < weights.length; index += 1) {
    cumulative += weights[index]!;
    if (draw <= cumulative) return index;
  }
  return weights.length - 1;
}

function evolveState(initial: number, exposure: number, random: Random): number {
  if (!(exposure > 0)) return initial;
  let state = initial;
  let elapsed = 0;
  while (elapsed < exposure) {
    const exit = -Q[state * 4 + state]!;
    elapsed += -Math.log(Math.max(Number.MIN_VALUE, random.uniform())) / exit;
    if (elapsed >= exposure) break;
    const draw = random.uniform() * exit;
    let cumulative = 0;
    for (let next = 0; next < 4; next += 1) {
      if (next === state) continue;
      cumulative += Q[state * 4 + next]!;
      if (draw <= cumulative) { state = next; break; }
    }
  }
  return state;
}

function branchLengths(root: RootedNode, random: Random, mean = 0.05): SimNode {
  if ("leaf" in root) return { leaf: root.leaf, length: Math.max(0.004, Math.min(0.22, mean * Math.exp(0.42 * random.normal()))), children: [] };
  return {
    length: 0,
    children: root.children.map((child) => {
      const built = branchLengths(child, random, mean);
      return { ...built, length: Math.max(0.004, Math.min(0.22, mean * Math.exp(0.42 * random.normal()))) };
    }),
  };
}

function ratesForSites(sites: number, random: Random): Float64Array {
  const rates = new Float64Array(sites);
  const gammaShape = 0.55;
  const invariantFraction = 0.08;
  const sigma = 0.45;
  const correlation = 0.985;
  const innovation = Math.sqrt(1 - correlation * correlation);
  let regional = random.normal();
  let total = 0;
  for (let site = 0; site < sites; site += 1) {
    regional = correlation * regional + innovation * random.normal();
    if (random.uniform() < invariantFraction) continue;
    const gamma = random.gamma(gammaShape) / gammaShape;
    const correlated = Math.exp(sigma * regional - sigma * sigma / 2);
    rates[site] = Math.min(15, gamma * correlated);
    total += rates[site]!;
  }
  const scale = sites / total;
  for (let site = 0; site < sites; site += 1) rates[site] = rates[site]! * scale;
  return rates;
}

function quantile(values: readonly number[], probability: number): number {
  if (values.length === 0) return 0;
  if (values.length === 1) return values[0]!;
  const position = probability * (values.length - 1);
  const low = Math.floor(position);
  const high = Math.ceil(position);
  const fraction = position - low;
  return values[low]! * (1 - fraction) + values[high]! * fraction;
}

function simulate(seed: number, truth: Truth): SimulatedData {
  const random = new Random(seed);
  const rates = ratesForSites(truth.sites, random);
  const sequences = Array.from({ length: truth.taxa }, () => new Uint8Array(truth.sites));
  const branchTrees = new Map<string, SimNode>();
  for (const signature of new Set(truth.signatures)) {
    const site = truth.signatures.indexOf(signature);
    branchTrees.set(signature, branchLengths(truth.treeAtSite[site]!, random));
  }
  const visit = (node: SimNode, state: number, site: number, rate: number): void => {
    const current = evolveState(state, node.length * rate, random);
    if (node.leaf !== undefined) { sequences[node.leaf]![site] = current; return; }
    for (const child of node.children) visit(child, current, site, rate);
  };
  for (let site = 0; site < truth.sites; site += 1) {
    const rootState = categorical(PI, random);
    const tree = branchTrees.get(truth.signatures[site]!)!;
    for (const child of tree.children) visit(child, rootState, site, rates[site]!);
  }
  // Light missingness plus short gap tracts, deliberately independent of the
  // event boundaries.
  for (const sequence of sequences) {
    for (let site = 0; site < sequence.length; site += 1) {
      if (random.uniform() < 0.002) sequence[site] = 4;
      if (random.uniform() < 0.0003) {
        const length = 1 + random.integer(5);
        for (let offset = 0; offset < length && site + offset < sequence.length; offset += 1) sequence[site + offset] = 5;
        site += length - 1;
      }
    }
  }
  const text = sequences.map((sequence) => Array.from(sequence, (state) => state < 4 ? NUCLEOTIDES[state]! : state === 4 ? "N" : "-").join(""));
  let pairwise = 0;
  let pairs = 0;
  for (let a = 0; a < text.length; a += 1) for (let b = a + 1; b < text.length; b += 1) {
    let different = 0;
    let comparable = 0;
    for (let site = 0; site < truth.sites; site += 1) {
      const x = text[a]![site]!;
      const y = text[b]![site]!;
      if (!NUCLEOTIDES.includes(x) || !NUCLEOTIDES.includes(y)) continue;
      comparable += 1;
      if (x !== y) different += 1;
    }
    pairwise += different / comparable;
    pairs += 1;
  }
  let variable = 0;
  let parsimonyInformative = 0;
  for (let site = 0; site < truth.sites; site += 1) {
    const counts = new Map<string, number>();
    for (const sequence of text) {
      const nucleotide = sequence[site]!;
      if (NUCLEOTIDES.includes(nucleotide)) counts.set(nucleotide, (counts.get(nucleotide) ?? 0) + 1);
    }
    if (counts.size > 1) variable += 1;
    if ([...counts.values()].filter((count) => count >= 2).length >= 2) parsimonyInformative += 1;
  }
  const positiveRates = [...rates].filter((value) => value > 0).sort((a, b) => a - b);
  return {
    truth,
    fasta: text.map((sequence, index) => `>t${index + 1}\n${sequence}`).join("\n"),
    sequences: text,
    siteRates: rates,
    meanPairwisePDistance: pairwise / pairs,
    variableFraction: variable / truth.sites,
    parsimonyInformativeFraction: parsimonyInformative / truth.sites,
    rateSummary: {
      mean: [...rates].reduce((sum, value) => sum + value, 0) / truth.sites,
      invariantFraction: 1 - positiveRates.length / truth.sites,
      median: quantile(positiveRates, 0.5),
      q90: quantile(positiveRates, 0.9),
      maximum: positiveRates.at(-1) ?? 0,
    },
  };
}

interface ParsedNode { readonly name?: string; readonly children: readonly ParsedNode[] }

class NewickParser {
  private index = 0;
  constructor(private readonly text: string) {}
  parse(): ParsedNode { return this.node(); }
  private node(): ParsedNode {
    this.space();
    const children: ParsedNode[] = [];
    if (this.text[this.index] === "(") {
      this.index += 1;
      for (;;) {
        children.push(this.node());
        this.space();
        if (this.text[this.index] === ",") { this.index += 1; continue; }
        if (this.text[this.index] === ")") { this.index += 1; break; }
        throw new Error("Malformed Newick in JEMSPR benchmark.");
      }
    }
    this.space();
    const name = this.label();
    this.space();
    if (this.text[this.index] === ":") {
      this.index += 1;
      while (this.index < this.text.length && !",();".includes(this.text[this.index]!)) this.index += 1;
    }
    return name.length === 0 ? { children } : { name, children };
  }
  private label(): string {
    if (this.text[this.index] === "'") {
      this.index += 1;
      let value = "";
      while (this.index < this.text.length) {
        const token = this.text[this.index++]!;
        if (token !== "'") { value += token; continue; }
        if (this.text[this.index] === "'") { value += "'"; this.index += 1; continue; }
        break;
      }
      return value;
    }
    const start = this.index;
    while (this.index < this.text.length && !"\t\r\n (),:;[]".includes(this.text[this.index]!)) this.index += 1;
    return this.text.slice(start, this.index);
  }
  private space(): void { while (/\s/.test(this.text[this.index] ?? "")) this.index += 1; }
}

function rootedCladeSet(tree: string): { readonly tips: readonly string[]; readonly clades: ReadonlySet<string> } {
  const root = new NewickParser(tree).parse();
  const tips: string[] = [];
  const collect = (node: ParsedNode): void => {
    if (node.children.length === 0) { if (node.name !== undefined) tips.push(node.name); return; }
    for (const child of node.children) collect(child);
  };
  collect(root);
  tips.sort();
  const clades = new Set<string>();
  const visit = (node: ParsedNode): string[] => {
    if (node.children.length === 0) return node.name === undefined ? [] : [node.name];
    const descendants = node.children.flatMap(visit).sort();
    if (descendants.length > 1 && descendants.length < tips.length) clades.add(descendants.join("\0"));
    return descendants;
  };
  visit(root);
  return { tips, clades };
}

function unrootedSplitSet(tree: string): { readonly tips: readonly string[]; readonly splits: ReadonlySet<string> } {
  const rooted = rootedCladeSet(tree);
  const universe = new Set(rooted.tips);
  const splits = new Set<string>();
  for (const clade of rooted.clades) {
    const first = clade.split("\0");
    const selected = new Set(first);
    const second = rooted.tips.filter((tip) => !selected.has(tip));
    if (first.length <= 1 || second.length <= 1) continue;
    const canonical = first.length < second.length ? first : first.length > second.length ? second : first.join("\0") <= second.join("\0") ? first : second;
    splits.add(canonical.join("\0"));
  }
  return { tips: [...universe].sort(), splits };
}

function setDistance(first: ReadonlySet<string>, second: ReadonlySet<string>): number {
  let difference = 0;
  for (const value of first) if (!second.has(value)) difference += 1;
  for (const value of second) if (!first.has(value)) difference += 1;
  return difference / Math.max(1, first.size + second.size);
}

function rootedRf(first: string, second: string): number {
  const a = rootedCladeSet(first);
  const b = rootedCladeSet(second);
  if (a.tips.join("\0") !== b.tips.join("\0")) throw new Error("Rooted RF trees have different tips.");
  return setDistance(a.clades, b.clades);
}

function unrootedRf(first: string, second: string): number {
  const a = unrootedSplitSet(first);
  const b = unrootedSplitSet(second);
  if (a.tips.join("\0") !== b.tips.join("\0")) throw new Error("Unrooted RF trees have different tips.");
  return setDistance(a.splits, b.splits);
}

function inferredTreeAtSite(result: JemsprAnalysisResult): readonly string[] {
  const trees = new Map(result.network.trees.map((tree) => [tree.id, tree.tree]));
  const output = new Array<string>(result.sites);
  for (const run of result.network.runs) for (let site = run.start; site <= run.end; site += 1) output[site - 1] = trees.get(run.treeId)!;
  return output;
}

function relaxedPathTreeAtSite(result: JemsprAnalysisResult): readonly string[] {
  const trees = new Map(result.path.states.map((tree) => [tree.id, tree.tree]));
  const output = new Array<string>(result.sites);
  for (const run of result.path.runs) for (let site = run.start; site <= run.end; site += 1) output[site - 1] = trees.get(run.stateId)!;
  return output;
}

function matchBreakpoints(truth: readonly number[], predictions: readonly number[], tolerance: number): readonly { readonly truth: number; readonly predicted: number; readonly error: number }[] {
  interface Solution { readonly values: readonly { readonly truth: number; readonly predicted: number; readonly error: number }[]; readonly error: number }
  const table: Solution[][] = Array.from({ length: truth.length + 1 }, () => Array.from({ length: predictions.length + 1 }, () => ({ values: [], error: 0 })));
  const better = (a: Solution, b: Solution): Solution => a.values.length !== b.values.length ? (a.values.length > b.values.length ? a : b) : a.error <= b.error ? a : b;
  for (let i = 1; i <= truth.length; i += 1) for (let j = 1; j <= predictions.length; j += 1) {
    let value = better(table[i - 1]![j]!, table[i]![j - 1]!);
    const error = Math.abs(truth[i - 1]! - predictions[j - 1]!);
    if (error <= tolerance) {
      const previous = table[i - 1]![j - 1]!;
      value = better(value, { values: [...previous.values, { truth: truth[i - 1]!, predicted: predictions[j - 1]!, error }], error: previous.error + error });
    }
    table[i]![j] = value;
  }
  return table[truth.length]![predictions.length]!.values;
}

function breakpointMetrics(truth: readonly number[], runs: readonly { readonly start: number; readonly end: number }[], result: JemsprAnalysisResult, tolerance: number): BreakpointMetrics {
  const predictions = runs.slice(1).map((run) => run.start - 1);
  const matches = matchBreakpoints(truth, predictions, tolerance);
  const truePositive = matches.length;
  const falsePositive = predictions.length - truePositive;
  const falseNegative = truth.length - truePositive;
  const f1Denominator = 2 * truePositive + falsePositive + falseNegative;
  const byBoundary = new Map(result.network.breakpointGaps.map((entry) => [entry.afterSite, entry]));
  const covered = truth.filter((site) => [...byBoundary.values()].some((entry) => site >= entry.intervalLow && site <= entry.intervalHigh)).length;
  return {
    trueCount: truth.length,
    predictedCount: predictions.length,
    truePositive,
    precision: predictions.length === 0 ? null : truePositive / predictions.length,
    recall: truth.length === 0 ? 1 : truePositive / truth.length,
    f1: f1Denominator === 0 ? 1 : 2 * truePositive / f1Denominator,
    localizationMae: matches.length === 0 ? null : matches.reduce((sum, value) => sum + value.error, 0) / matches.length,
    intervalCoverage: truth.length === 0 ? null : covered / truth.length,
    meanIntervalWidth: result.network.breakpointGaps.length === 0 ? null : result.network.breakpointGaps.reduce((sum, entry) => sum + entry.intervalHigh - entry.intervalLow + 1, 0) / result.network.breakpointGaps.length,
  };
}

function eventOccurrenceCount(intervals: readonly EventInterval[]): number { return intervals.length; }

function maskRuns(maskPath: Int32Array): JemsprMaskRun[] {
  if (maskPath.length === 0) return [];
  const runs: JemsprMaskRun[] = [];
  let first = 0;
  for (let site = 1; site <= maskPath.length; site += 1) {
    if (site < maskPath.length && maskPath[site] === maskPath[first]) continue;
    runs.push({ id: `O${runs.length + 1}`, start: first + 1, end: site, mask: maskPath[first]!, activeTemplateIds: [], treeId: "", treeIndex: 0, dataParsimony: 0 });
    first = site;
  }
  return runs;
}

function breakpointTolerance(sites: number): number {
  return Math.max(12, Math.round(0.025 * sites));
}

function truthLocalTreesTsv(truth: Truth): string {
  const rows = ["start\tend\ttopology_signature\tnewick"];
  let start = 0;
  for (let site = 1; site <= truth.sites; site += 1) {
    if (site < truth.sites && truth.signatures[site] === truth.signatures[start]) continue;
    rows.push(`${start + 1}\t${site}\t${truth.signatures[start]}\t${truth.newickAtSite[start]}`);
    start = site;
  }
  return `${rows.join("\n")}\n`;
}

function metrics(seed: number, variant: Variant, simulated: SimulatedData, result: JemsprAnalysisResult, runtimeMs: number): RunMetrics {
  const inferred = inferredTreeAtSite(result);
  const relaxed = relaxedPathTreeAtSite(result);
  let rooted = 0;
  let unrooted = 0;
  let exactRooted = 0;
  let exactUnrooted = 0;
  let relaxedRooted = 0;
  let relaxedUnrooted = 0;
  const cache = new Map<string, { readonly rooted: number; readonly unrooted: number }>();
  for (let site = 0; site < simulated.truth.sites; site += 1) {
    const key = `${simulated.truth.signatures[site]}::${inferred[site]}`;
    let distance = cache.get(key);
    if (distance === undefined) {
      distance = { rooted: rootedRf(simulated.truth.newickAtSite[site]!, inferred[site]!), unrooted: unrootedRf(simulated.truth.newickAtSite[site]!, inferred[site]!) };
      cache.set(key, distance);
    }
    rooted += distance.rooted;
    unrooted += distance.unrooted;
    if (distance.rooted < 1e-12) exactRooted += 1;
    if (distance.unrooted < 1e-12) exactUnrooted += 1;
    relaxedRooted += rootedRf(simulated.truth.newickAtSite[site]!, relaxed[site]!);
    relaxedUnrooted += unrootedRf(simulated.truth.newickAtSite[site]!, relaxed[site]!);
  }
  const oracle = evaluateFixedSwitchingNetwork(simulated.truth.network, parseJemsprFasta(simulated.fasta), variant.options);
  if (oracle === undefined) throw new Error("The planted switching network could not be decoded by the fixed-network evaluator.");
  let oracleRootedRf = 0;
  let oracleUnrootedRf = 0;
  for (let site = 0; site < simulated.truth.sites; site += 1) {
    const display = displayNetwork(simulated.truth.network, oracle.maskPath[site]!)!;
    const oracleTree = treeToNewick(display.tree, Array.from({ length: simulated.truth.taxa }, (_value, index) => `t${index + 1}`));
    oracleRootedRf += rootedRf(simulated.truth.newickAtSite[site]!, oracleTree);
    oracleUnrootedRf += unrootedRf(simulated.truth.newickAtSite[site]!, oracleTree);
  }
  const tolerance = breakpointTolerance(simulated.truth.sites);
  const oracleBreakpoints = breakpointMetrics(simulated.truth.breakpoints, maskRuns(oracle.maskPath), result, tolerance);
  const alignment = parseJemsprFasta(simulated.fasta);
  const truthDisplayScores = new Map<string, Float64Array>();
  let plantedHistoryDataParsimony = 0;
  for (let site = 0; site < simulated.truth.sites; site += 1) {
    const signature = simulated.truth.signatures[site]!;
    let scores = truthDisplayScores.get(signature);
    if (scores === undefined) {
      const display = displayNetwork(simulated.truth.network, simulated.truth.maskAtSite[site]!)!;
      scores = scoreTree(display.tree, alignment, variant.options.scoreMethod ?? "fitch", variant.options.transitionCost ?? 1, variant.options.transversionCost ?? 1);
      truthDisplayScores.set(signature, scores);
    }
    plantedHistoryDataParsimony += scores[site]!;
  }
  const popcount = (mask: number): number => { let count = 0; for (let bits = mask; bits !== 0; bits &= bits - 1) count += 1; return count; };
  const openPenalty = variant.options.eventOpenPenalty ?? Math.log2(simulated.truth.sites + 1) / 2;
  const closePenalty = variant.options.eventClosePenalty ?? 0;
  const breakpointPenalty = variant.options.networkBreakpointPenalty ?? Math.log2(simulated.truth.sites + 1) / 2;
  const spanPenalty = variant.options.eventSpanPenalty ?? 1 / Math.max(80, variant.options.minimumWindow ?? Math.max(64, Math.min(250, simulated.truth.sites / 8)));
  const reticulationPenalty = variant.options.reticulationPenalty ?? Math.max(1, Math.log2(simulated.truth.taxa));
  let plantedPenalty = reticulationPenalty * simulated.truth.network.reticulations.length;
  for (let site = 0; site < simulated.truth.sites; site += 1) plantedPenalty += spanPenalty * popcount(simulated.truth.maskAtSite[site]!);
  for (let site = 1; site < simulated.truth.sites; site += 1) {
    const from = simulated.truth.maskAtSite[site - 1]!;
    const to = simulated.truth.maskAtSite[site]!;
    if (from === to) continue;
    plantedPenalty += breakpointPenalty + openPenalty * popcount(to & ~from) + closePenalty * popcount(from & ~to);
  }
  return {
    seed,
    variant: variant.id,
    runtimeMs,
    informativeSites: result.informativeSites,
    siteRootedRf: rooted / simulated.truth.sites,
    siteUnrootedRf: unrooted / simulated.truth.sites,
    siteExactRooted: exactRooted / simulated.truth.sites,
    siteExactUnrooted: exactUnrooted / simulated.truth.sites,
    relaxedPathSiteRootedRf: relaxedRooted / simulated.truth.sites,
    relaxedPathSiteUnrootedRf: relaxedUnrooted / simulated.truth.sites,
    relaxedPathBreakpointF1: breakpointMetrics(simulated.truth.breakpoints, result.path.runs, result, tolerance).f1,
    breakpoint: breakpointMetrics(simulated.truth.breakpoints, result.network.runs, result, tolerance),
    masterRootedRf: rootedRf(simulated.truth.masterNewick, result.network.masterTree),
    masterUnrootedRf: unrootedRf(simulated.truth.masterNewick, result.network.masterTree),
    trueTemplates: simulated.truth.network.reticulations.length,
    inferredTemplates: result.network.templates.length,
    trueOccurrences: eventOccurrenceCount(simulated.truth.eventIntervals),
    inferredOccurrences: result.network.occurrences.length,
    trueMaximumOverlap: simulated.truth.maximumOverlap,
    inferredMaximumOverlap: result.network.maximumOverlapUsed,
    inferredRegions: result.network.runs.length,
    temporal: result.network.temporal.status,
    graphStates: result.diagnostics.graphStates,
    graphEdges: result.diagnostics.graphEdges,
    rootStarts: result.diagnostics.rootPlacements,
    warnings: result.diagnostics.warnings,
    oracleNetworkSiteRootedRf: oracleRootedRf / simulated.truth.sites,
    oracleNetworkSiteUnrootedRf: oracleUnrootedRf / simulated.truth.sites,
    oracleNetworkBreakpointF1: oracleBreakpoints.f1,
    oracleNetworkObjective: oracle.objective,
    plantedHistoryDataParsimony,
    plantedHistoryObjective: plantedHistoryDataParsimony + plantedPenalty,
    oracleDataParsimony: oracle.dataParsimony,
    inferredObjective: result.network.objective,
  };
}

const mean = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
const nullableMean = (values: readonly (number | null)[]): number | null => {
  const finite = values.filter((value): value is number => value !== null);
  return finite.length === 0 ? null : mean(finite);
};

function summarize(variant: Variant, rows: readonly RunMetrics[]): Summary {
  const sortedRuntime = rows.map((row) => row.runtimeMs).sort((a, b) => a - b);
  return {
    variant: variant.id,
    label: variant.label,
    replicates: rows.length,
    medianRuntimeMs: quantile(sortedRuntime, 0.5),
    q90RuntimeMs: quantile(sortedRuntime, 0.9),
    meanSiteRootedRf: mean(rows.map((row) => row.siteRootedRf)),
    meanSiteUnrootedRf: mean(rows.map((row) => row.siteUnrootedRf)),
    meanSiteExactRooted: mean(rows.map((row) => row.siteExactRooted)),
    meanSiteExactUnrooted: mean(rows.map((row) => row.siteExactUnrooted)),
    meanRelaxedPathRootedRf: mean(rows.map((row) => row.relaxedPathSiteRootedRf)),
    meanRelaxedPathUnrootedRf: mean(rows.map((row) => row.relaxedPathSiteUnrootedRf)),
    meanRelaxedPathBreakpointF1: mean(rows.map((row) => row.relaxedPathBreakpointF1)),
    breakpointPrecision: nullableMean(rows.map((row) => row.breakpoint.precision)),
    breakpointRecall: mean(rows.map((row) => row.breakpoint.recall)),
    breakpointF1: mean(rows.map((row) => row.breakpoint.f1)),
    breakpointLocalizationMae: nullableMean(rows.map((row) => row.breakpoint.localizationMae)),
    breakpointIntervalCoverage: nullableMean(rows.map((row) => row.breakpoint.intervalCoverage)),
    meanInferredTemplates: mean(rows.map((row) => row.inferredTemplates)),
    meanInferredOccurrences: mean(rows.map((row) => row.inferredOccurrences)),
    meanInferredRegions: mean(rows.map((row) => row.inferredRegions)),
    meanInferredOverlap: mean(rows.map((row) => row.inferredMaximumOverlap)),
    noEventFraction: mean(rows.map((row) => row.inferredOccurrences === 0 ? 1 : 0)),
    meanOracleNetworkRootedRf: mean(rows.map((row) => row.oracleNetworkSiteRootedRf)),
    meanOracleNetworkUnrootedRf: mean(rows.map((row) => row.oracleNetworkSiteUnrootedRf)),
    meanOracleNetworkBreakpointF1: mean(rows.map((row) => row.oracleNetworkBreakpointF1)),
    meanOracleObjectiveMinusInferred: mean(rows.map((row) => row.oracleNetworkObjective - row.inferredObjective)),
    meanPlantedObjectiveMinusInferred: mean(rows.map((row) => row.plantedHistoryObjective - row.inferredObjective)),
    temporalFeasibleFraction: mean(rows.map((row) => row.temporal === "rank-feasible" ? 1 : 0)),
  };
}

function csvCell(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function rowsCsv(rows: readonly RunMetrics[]): string {
  const header = ["seed", "variant", "runtime_ms", "informative_sites", "site_rooted_rf", "site_unrooted_rf", "site_exact_rooted", "site_exact_unrooted", "relaxed_path_rooted_rf", "relaxed_path_unrooted_rf", "relaxed_path_bp_f1", "bp_true", "bp_predicted", "bp_tp", "bp_precision", "bp_recall", "bp_f1", "bp_mae", "bp_interval_coverage", "bp_interval_width", "master_rooted_rf", "master_unrooted_rf", "true_templates", "inferred_templates", "true_occurrences", "inferred_occurrences", "true_max_overlap", "inferred_max_overlap", "inferred_regions", "temporal", "graph_states", "graph_edges", "root_starts", "oracle_network_site_rooted_rf", "oracle_network_site_unrooted_rf", "oracle_network_bp_f1", "oracle_network_objective", "oracle_data_parsimony", "planted_history_data_parsimony", "planted_history_objective", "inferred_objective", "warnings"];
  const values = rows.map((row) => [row.seed, row.variant, row.runtimeMs, row.informativeSites, row.siteRootedRf, row.siteUnrootedRf, row.siteExactRooted, row.siteExactUnrooted, row.relaxedPathSiteRootedRf, row.relaxedPathSiteUnrootedRf, row.relaxedPathBreakpointF1, row.breakpoint.trueCount, row.breakpoint.predictedCount, row.breakpoint.truePositive, row.breakpoint.precision, row.breakpoint.recall, row.breakpoint.f1, row.breakpoint.localizationMae, row.breakpoint.intervalCoverage, row.breakpoint.meanIntervalWidth, row.masterRootedRf, row.masterUnrootedRf, row.trueTemplates, row.inferredTemplates, row.trueOccurrences, row.inferredOccurrences, row.trueMaximumOverlap, row.inferredMaximumOverlap, row.inferredRegions, row.temporal, row.graphStates, row.graphEdges, row.rootStarts, row.oracleNetworkSiteRootedRf, row.oracleNetworkSiteUnrootedRf, row.oracleNetworkBreakpointF1, row.oracleNetworkObjective, row.oracleDataParsimony, row.plantedHistoryDataParsimony, row.plantedHistoryObjective, row.inferredObjective, row.warnings.join("; ")]);
  return `${header.join(",")}\n${values.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function summaryCsv(rows: readonly Summary[]): string {
  const header = ["variant", "label", "replicates", "median_runtime_ms", "q90_runtime_ms", "mean_site_rooted_rf", "mean_site_unrooted_rf", "mean_site_exact_rooted", "mean_site_exact_unrooted", "mean_relaxed_path_rooted_rf", "mean_relaxed_path_unrooted_rf", "mean_relaxed_path_bp_f1", "breakpoint_precision", "breakpoint_recall", "breakpoint_f1", "breakpoint_mae", "breakpoint_interval_coverage", "mean_inferred_templates", "mean_inferred_occurrences", "mean_inferred_regions", "mean_inferred_overlap", "no_event_fraction", "mean_oracle_network_rooted_rf", "mean_oracle_network_unrooted_rf", "mean_oracle_network_bp_f1", "mean_oracle_objective_minus_inferred", "mean_planted_objective_minus_inferred", "temporal_feasible_fraction"];
  return `${header.join(",")}\n${rows.map((row) => [row.variant, row.label, row.replicates, row.medianRuntimeMs, row.q90RuntimeMs, row.meanSiteRootedRf, row.meanSiteUnrootedRf, row.meanSiteExactRooted, row.meanSiteExactUnrooted, row.meanRelaxedPathRootedRf, row.meanRelaxedPathUnrootedRf, row.meanRelaxedPathBreakpointF1, row.breakpointPrecision, row.breakpointRecall, row.breakpointF1, row.breakpointLocalizationMae, row.breakpointIntervalCoverage, row.meanInferredTemplates, row.meanInferredOccurrences, row.meanInferredRegions, row.meanInferredOverlap, row.noEventFraction, row.meanOracleNetworkRootedRf, row.meanOracleNetworkUnrootedRf, row.meanOracleNetworkBreakpointF1, row.meanOracleObjectiveMinusInferred, row.meanPlantedObjectiveMinusInferred, row.temporalFeasibleFraction].map(csvCell).join(",")).join("\n")}\n`;
}

function reportMarkdown(simulated: SimulatedData, variants: readonly Variant[], summaries: readonly Summary[], rows: readonly RunMetrics[]): string {
  const table = summaries.map((summary) => `| ${summary.label} | ${(summary.medianRuntimeMs / 1000).toFixed(2)} | ${summary.meanSiteUnrootedRf.toFixed(3)} | ${(100 * summary.meanSiteExactUnrooted).toFixed(1)}% | ${summary.meanSiteRootedRf.toFixed(3)} | ${summary.breakpointF1.toFixed(3)} | ${summary.breakpointLocalizationMae?.toFixed(1) ?? "—"} | ${summary.meanInferredOccurrences.toFixed(2)} | ${summary.meanInferredOverlap.toFixed(2)} |`).join("\n");
  const diagnosticTable = summaries.map((summary) => `| ${summary.label} | ${summary.meanRelaxedPathUnrootedRf.toFixed(3)} | ${summary.meanRelaxedPathBreakpointF1.toFixed(3)} | ${summary.meanOracleNetworkUnrootedRf.toFixed(3)} | ${summary.meanOracleNetworkBreakpointF1.toFixed(3)} | ${summary.meanOracleObjectiveMinusInferred.toFixed(2)} | ${(100 * summary.noEventFraction).toFixed(0)}% |`).join("\n");
  return `# JEMSPR complex-recombinant benchmark

Generated ${new Date().toISOString()}.

## Design

- **Truth:** ${simulated.truth.taxa} taxa, ${simulated.truth.sites.toLocaleString()} nt, one rooted master, ${simulated.truth.network.reticulations.length} persistent rSPR templates, ${simulated.truth.eventIntervals.length} interval occurrences, ${simulated.truth.breakpoints.length} endpoint coordinates, and maximum concurrent overlap ${simulated.truth.maximumOverlap}.
- **History:** ${simulated.truth.eventIntervals.length === 0 ? "No recombination; this is a false-positive control." : "Crossing and nested tracts, recurrent use of one template, simultaneous endpoints, and one right-censored event. Local trees are exact displays of the planted switching DAG."}
- **Evolution:** exact Gillespie GTR CTMC, heterogeneous branch lengths, continuous Gamma site rates, invariant sites, correlated regional rate multipliers, light ambiguity, and short gap tracts.
- **Realized diversity:** mean pairwise p-distance ${(100 * simulated.meanPairwisePDistance).toFixed(1)}%; variable ${(100 * simulated.variableFraction).toFixed(1)}%; parsimony-informative ${(100 * simulated.parsimonyInformativeFraction).toFixed(1)}%.
- **Primary topology metric:** alignment-length-weighted site-averaged normalized unrooted RF, i.e. the normalized RF between true and inferred local tree is computed at every nucleotide and averaged. Rooted RF is reported as a diagnostic, but the reversible GTR simulator contains no information identifying the root.
- **Breakpoint matching:** exact ordered one-to-one assignment within ±${breakpointTolerance(simulated.truth.sites)} nt (2.5% of alignment length), maximizing matches then minimizing total absolute error. Endpoint-range coverage is descriptive optimization-gap coverage, not frequentist confidence coverage.
- **Replicates:** ${new Set(rows.map((row) => row.seed)).size} independently evolved alignments; the same planted event graph and coordinates are used so ablations are paired.

## Results

| Variant | Median s | Site unrooted RF ↓ | Exact unrooted sites ↑ | Site rooted RF † | Breakpoint F1 ↑ | BP MAE nt ↓ | Event occurrences | Max overlap |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
${table}

### Search/scoring diagnostics

| Variant | Relaxed-path unrooted RF ↓ | Relaxed-path BP F1 ↑ | Planted-network decoder unrooted RF ↓ | Planted-network decoder BP F1 ↑ | Planted-network objective − inferred ↓ | No-event runs |
|---|---:|---:|---:|---:|---:|---:|
${diagnosticTable}

If the planted-network objective minus the inferred objective is positive, the configured objective itself prefers the inferred solution even when the exact planted switching DAG is supplied; a negative value instead exposes an outer-search miss. The planted-network decoder may choose a different mask path from the simulated one because it is optimized under the same penalties as the fitted method.

## Variants

${variants.map((variant) => `- **${variant.label}** (\`${variant.id}\`): ${JSON.stringify(variant.options)}`).join("\n")}

## Interpretation guardrails

This benchmark measures reconstruction under a topology-only parsimony objective even though sequence evolution is stochastic GTR. The planted graph is deliberately complex but fixed across replicates. It is an ablation/stress benchmark, not a calibration of biological event probabilities or a comparison with GARD/ClonalFrame/ARG methods. The candidate-tree graph and fixed switching-network dynamic programs are exact within their finite universes; topology generation and the outer network beam remain budgeted.
`;
}

function parseArgs(): { readonly replicates: number; readonly quick: boolean; readonly nullControl: boolean; readonly variantIds?: ReadonlySet<string>; readonly out: string } {
  const args = process.argv.slice(2);
  const value = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  const quick = args.includes("--quick");
  const nullControl = args.includes("--null");
  const variantValue = value("--variants");
  return {
    quick,
    nullControl,
    ...(variantValue === undefined ? {} : { variantIds: new Set(variantValue.split(",").map((id) => id.trim()).filter(Boolean)) }),
    replicates: Math.max(1, Number(value("--replicates") ?? (quick ? 1 : 4))),
    out: value("--out") ?? fileURLToPath(new URL(nullControl ? "../benchmarks/results/null-control" : "../benchmarks/results/complex-recombinant", import.meta.url)),
  };
}

async function main(): Promise<void> {
  const cli = parseArgs();
  const complexTruth = truthHistory(cli.quick ? 8 : 10, cli.quick ? 1200 : 2400);
  const truth = cli.nullControl ? nullHistory(complexTruth) : complexTruth;
  const defaults: JemsprOptions = cli.quick ? {
    minimumWindow: 80, maximumDyadicTrees: 12, rootPlacements: 3, maximumGraphStates: 30, maximumGraphIterations: 7, neighbourScreen: 64, frontierStates: 4, nearImprovers: 2,
    pathBreakpointPenalty: 4, pathEndpointPenalty: 1, pathSpanPenalty: 0.002,
    maximumReticulations: 5, overlapCap: 3, networkBeamWidth: 8, eventPoolSize: 20,
    eventOpenPenalty: 2, eventClosePenalty: 0, networkBreakpointPenalty: 2, eventSpanPenalty: 0.002, reticulationPenalty: 2, boundaryConvention: "open",
  } : {
    minimumWindow: 120, maximumDyadicTrees: 18, rootPlacements: 4, maximumGraphStates: 48, maximumGraphIterations: 12, neighbourScreen: 112, frontierStates: 5, nearImprovers: 3,
    pathBreakpointPenalty: 4, pathEndpointPenalty: 1, pathSpanPenalty: 0.002,
    maximumReticulations: 6, overlapCap: 3, networkBeamWidth: 8, eventPoolSize: 24,
    eventOpenPenalty: 2, eventClosePenalty: 0, networkBreakpointPenalty: 2, eventSpanPenalty: 0.002, reticulationPenalty: 2, boundaryConvention: "open",
  };
  const sensitive: JemsprOptions = {
    ...defaults,
    overlapCap: 3,
    pathBreakpointPenalty: 2,
    pathEndpointPenalty: 0.5,
    pathSpanPenalty: 0.0005,
    eventOpenPenalty: 1,
    eventClosePenalty: 0,
    networkBreakpointPenalty: 1,
    eventSpanPenalty: 0.0005,
    reticulationPenalty: 1,
  };
  const balanced: JemsprOptions = {
    ...defaults,
    overlapCap: 3,
    pathBreakpointPenalty: 4,
    pathEndpointPenalty: 1,
    pathSpanPenalty: 0.002,
    eventOpenPenalty: 2,
    eventClosePenalty: 0,
    networkBreakpointPenalty: 2,
    eventSpanPenalty: 0.002,
    reticulationPenalty: 2,
  };
  const expanded = {
    maximumDyadicTrees: cli.quick ? 16 : 24,
    rootPlacements: cli.quick ? 4 : 6,
    maximumGraphStates: cli.quick ? 42 : 72,
    maximumGraphIterations: cli.quick ? 9 : 16,
    neighbourScreen: cli.quick ? 96 : 168,
    frontierStates: 6,
    nearImprovers: 4,
    maximumReticulations: 7,
    networkBeamWidth: cli.quick ? 8 : 12,
    eventPoolSize: cli.quick ? 22 : 32,
  } satisfies Partial<JemsprOptions>;
  const allVariants: Variant[] = [
    { id: "default", label: "Default regularization", options: defaults },
    { id: "default-expanded", label: "Default + expanded search", options: { ...defaults, ...expanded } },
    { id: "balanced", label: "Balanced regularization", options: balanced },
    { id: "sensitive", label: "Sensitivity profile", options: sensitive },
    { id: "sensitive-overlap1", label: "Sensitivity + overlap cap 1", options: { ...sensitive, overlapCap: 1 } },
    { id: "sensitive-one-root", label: "Sensitivity + one root", options: { ...sensitive, rootPlacements: 1 } },
    { id: "sensitive-retic2", label: "Sensitivity + two reticulations", options: { ...sensitive, maximumReticulations: 2 } },
    { id: "sensitive-expanded", label: "Sensitivity + expanded search", options: { ...sensitive, ...expanded, overlapCap: 3 } },
  ];
  const variants = cli.variantIds === undefined ? allVariants : allVariants.filter((variant) => cli.variantIds!.has(variant.id));
  if (variants.length === 0 || (cli.variantIds !== undefined && variants.length !== cli.variantIds.size)) {
    const known = allVariants.map((variant) => variant.id).join(", ");
    throw new Error(`Unknown or empty --variants selection. Known variants: ${known}.`);
  }
  const rows: RunMetrics[] = [];
  const simulations: SimulatedData[] = [];
  for (let replicate = 0; replicate < cli.replicates; replicate += 1) simulations.push(simulate(26_081_300 + replicate * 7919, truth));
  await mkdir(cli.out, { recursive: true });
  await writeFile(`${cli.out}/truth-master.nwk`, truth.masterNewick);
  await writeFile(`${cli.out}/truth-local-trees.tsv`, truthLocalTreesTsv(truth));
  await writeFile(`${cli.out}/truth.json`, JSON.stringify({ taxa: truth.taxa, sites: truth.sites, master: truth.masterNewick, networkReticulations: truth.network.reticulations, eventIntervals: truth.eventIntervals, breakpoints: truth.breakpoints, maximumOverlap: truth.maximumOverlap, distinctLocalTrees: new Set(truth.signatures).size }, null, 2));
  for (let replicate = 0; replicate < simulations.length; replicate += 1) {
    const simulated = simulations[replicate]!;
    await writeFile(`${cli.out}/replicate-${replicate + 1}.fasta`, simulated.fasta);
    for (const variant of variants) {
      process.stderr.write(`replicate ${replicate + 1}/${simulations.length} · ${variant.id} ... `);
      const started = performance.now();
      const result = await analyzeJemspr(simulated.fasta, variant.options);
      const runtimeMs = performance.now() - started;
      const row = metrics(26_081_300 + replicate * 7919, variant, simulated, result, runtimeMs);
      rows.push(row);
      process.stderr.write(`${(runtimeMs / 1000).toFixed(2)} s · rooted RF ${row.siteRootedRf.toFixed(3)} · BP F1 ${row.breakpoint.f1.toFixed(2)}\n`);
      if (replicate === 0) await writeFile(`${cli.out}/${variant.id}-replicate-1.json`, JSON.stringify(result, null, 2));
    }
  }
  const summaries = variants.map((variant) => summarize(variant, rows.filter((row) => row.variant === variant.id)));
  const diversity = simulations.map((simulation) => ({ meanPairwisePDistance: simulation.meanPairwisePDistance, variableFraction: simulation.variableFraction, parsimonyInformativeFraction: simulation.parsimonyInformativeFraction, rateSummary: simulation.rateSummary }));
  await writeFile(`${cli.out}/replicates.csv`, rowsCsv(rows));
  await writeFile(`${cli.out}/summary.csv`, summaryCsv(summaries));
  await writeFile(`${cli.out}/results.json`, JSON.stringify({ truth: { taxa: truth.taxa, sites: truth.sites, breakpoints: truth.breakpoints, maximumOverlap: truth.maximumOverlap, templates: truth.network.reticulations.length, occurrences: truth.eventIntervals.length, distinctLocalTrees: new Set(truth.signatures).size }, diversity, variants, rows, summaries }, null, 2));
  await writeFile(`${cli.out}/REPORT.md`, reportMarkdown(simulations[0]!, variants, summaries, rows));
  process.stdout.write(`${summaryCsv(summaries)}\nResults written to ${cli.out}\n`);
}

await main();

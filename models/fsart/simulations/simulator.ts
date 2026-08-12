export interface SimTreeNode {
  readonly id: number;
  name?: string;
  length: number;
  children: SimTreeNode[];
}

export interface RecombinationScenario {
  readonly id: string;
  readonly label: string;
  readonly breakpoints: number;
  readonly topologyMovesPerBreakpoint: number;
}

export interface DiversityRegime {
  readonly id: string;
  readonly label: string;
  readonly branchLengthScale: number;
}

export interface SimulationOptions {
  readonly taxa: number;
  readonly sites: number;
  readonly seed: number;
  readonly scenario: RecombinationScenario;
  /** Multiplicative scale applied to every generated branch length. */
  readonly branchLengthScale?: number;
  readonly gammaShape?: number;
  readonly invariantFraction?: number;
  readonly regionalLogRateSigma?: number;
  readonly regionalCorrelation?: number;
  readonly missingFraction?: number;
  readonly gapStartProbability?: number;
  readonly meanGapLength?: number;
}

export interface TrueSegment {
  readonly start: number;
  readonly end: number;
  readonly tree: string;
  readonly topology: string;
}

export interface SimulatedAlignment {
  readonly fasta: string;
  readonly names: readonly string[];
  readonly sequences: readonly string[];
  readonly trueBreakpoints: readonly number[];
  readonly trueSegments: readonly TrueSegment[];
  readonly siteRates: Float64Array;
  readonly rateSummary: {
    readonly mean: number;
    readonly invariantFraction: number;
    readonly q10: number;
    readonly median: number;
    readonly q90: number;
    readonly maximum: number;
  };
  readonly simulationModel: string;
}

const NUCLEOTIDES = "ACGT";
const PI = new Float64Array([0.30, 0.20, 0.22, 0.28]);
// AC, AG, AT, CG, CT, GT. The two transition rates are deliberately elevated.
const EXCHANGEABILITIES = new Float64Array([1.0, 4.2, 0.8, 0.9, 3.6, 1.1]);

export class Random {
  private state: number;
  private spareNormal: number | undefined;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  nextUint32(): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state;
  }

  uniform(): number {
    return (this.nextUint32() + 0.5) / 4_294_967_296;
  }

  integer(maximum: number): number {
    return Math.floor(this.uniform() * maximum);
  }

  normal(): number {
    if (this.spareNormal !== undefined) {
      const value = this.spareNormal;
      this.spareNormal = undefined;
      return value;
    }
    const radius = Math.sqrt(-2 * Math.log(Math.max(Number.MIN_VALUE, this.uniform())));
    const angle = 2 * Math.PI * this.uniform();
    this.spareNormal = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  }

  gamma(shape: number): number {
    if (!(shape > 0)) throw new RangeError("Gamma shape must be positive.");
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

function branchLength(random: Random, scale: number): number {
  const baseline = Math.max(0.008, Math.min(0.35, Math.exp(Math.log(0.075) + 0.48 * random.normal())));
  return Math.max(0.0005, Math.min(1.5, baseline * scale));
}

export function cloneTree(node: SimTreeNode): SimTreeNode {
  return { id: node.id, ...(node.name === undefined ? {} : { name: node.name }), length: node.length, children: node.children.map(cloneTree) };
}

export function generateTree(taxa: number, random: Random, branchLengthScale = 1): SimTreeNode {
  if (taxa < 4) throw new RangeError("The simulator requires at least four taxa.");
  if (!(branchLengthScale > 0) || !Number.isFinite(branchLengthScale)) throw new RangeError("Branch-length scale must be finite and positive.");
  let nextId = taxa;
  const active: SimTreeNode[] = Array.from({ length: taxa }, (_, index) => ({
    id: index,
    name: `t${index + 1}`,
    length: branchLength(random, branchLengthScale),
    children: [],
  }));
  while (active.length > 1) {
    const firstIndex = random.integer(active.length);
    const first = active.splice(firstIndex, 1)[0]!;
    const secondIndex = random.integer(active.length);
    const second = active.splice(secondIndex, 1)[0]!;
    active.push({ id: nextId++, length: branchLength(random, branchLengthScale), children: [first, second] });
  }
  const root = active[0]!;
  root.length = 0;
  return root;
}

/** Rooting- and branch-length-independent split signature used to ensure that
 * simulated recombination actually changes the observable unrooted tree. */
function unrootedTopologySignature(root: SimTreeNode): string {
  const tips: string[] = [];
  const collect = (node: SimTreeNode): void => {
    if (node.children.length === 0) {
      if (node.name !== undefined) tips.push(node.name);
      return;
    }
    for (const child of node.children) collect(child);
  };
  collect(root);
  tips.sort();
  const universe = new Set(tips);
  const splits = new Set<string>();
  const visit = (node: SimTreeNode): Set<string> => {
    if (node.children.length === 0) return new Set(node.name === undefined ? [] : [node.name]);
    const descendants = new Set<string>();
    for (const child of node.children) for (const tip of visit(child)) descendants.add(tip);
    if (descendants.size > 1 && descendants.size < universe.size - 1) {
      const first = Array.from(descendants).sort();
      const second = tips.filter((tip) => !descendants.has(tip));
      const canonical = first.length < second.length
        ? first
        : first.length > second.length
          ? second
          : first.join("\0") <= second.join("\0") ? first : second;
      splits.add(canonical.join("\0"));
    }
    return descendants;
  };
  visit(root);
  return `${tips.join("\0")}::${Array.from(splits).sort().join("|")}`;
}

interface NniTarget {
  readonly parent: SimTreeNode;
  readonly internalIndex: number;
}

function nniTargets(root: SimTreeNode): NniTarget[] {
  const output: NniTarget[] = [];
  const visit = (node: SimTreeNode): void => {
    if (node.children.length !== 2) return;
    for (let index = 0; index < 2; index += 1) {
      if (node.children[index]!.children.length === 2) output.push({ parent: node, internalIndex: index });
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
  return output;
}

/** Apply a topology-changing NNI while preserving each moved subtree's stem length. */
export function applyRandomNni(root: SimTreeNode, random: Random): void {
  const targets = nniTargets(root);
  if (targets.length === 0) throw new Error("No internal edge is available for NNI.");
  const target = targets[random.integer(targets.length)]!;
  const siblingIndex = 1 - target.internalIndex;
  const internal = target.parent.children[target.internalIndex]!;
  const childIndex = random.integer(2);
  const child = internal.children[childIndex]!;
  const sibling = target.parent.children[siblingIndex]!;
  internal.children[childIndex] = sibling;
  target.parent.children[siblingIndex] = child;
}

function applyUnrootedTopologyChangingNni(root: SimTreeNode, random: Random): void {
  const before = unrootedTopologySignature(root);
  for (let attempt = 0; attempt < 128; attempt += 1) {
    const candidate = cloneTree(root);
    applyRandomNni(candidate, random);
    if (unrootedTopologySignature(candidate) === before) continue;
    if (candidate.name === undefined) delete root.name;
    else root.name = candidate.name;
    root.length = candidate.length;
    root.children = candidate.children;
    return;
  }
  throw new Error("Failed to generate an unrooted-topology-changing NNI.");
}

function newick(node: SimTreeNode, root = true): string {
  const body = node.children.length === 0
    ? node.name!
    : `(${node.children.map((child) => newick(child, false)).join(",")})`;
  return `${body}${root ? ";" : `:${node.length.toFixed(8)}`}`;
}

function breakpoints(sites: number, count: number, random: Random): number[] {
  if (count === 0) return [];
  const nominal = sites / (count + 1);
  const minimum = Math.max(60, Math.floor(nominal * 0.55));
  const output: number[] = [];
  for (let index = 1; index <= count; index += 1) {
    const center = index * nominal;
    const jitter = (random.uniform() - 0.5) * nominal * 0.20;
    const lower = (output.at(-1) ?? 0) + minimum;
    const upper = sites - (count - index + 1) * minimum;
    output.push(Math.max(lower, Math.min(upper, Math.round(center + jitter))));
  }
  return output;
}

function buildRateMatrix(): Float64Array {
  const matrix = new Float64Array(16);
  const exchangeability = (first: number, second: number): number => {
    const low = Math.min(first, second);
    const high = Math.max(first, second);
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
  let meanRate = 0;
  for (let state = 0; state < 4; state += 1) meanRate -= PI[state]! * matrix[state * 4 + state]!;
  for (let index = 0; index < matrix.length; index += 1) matrix[index] = matrix[index]! / meanRate;
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
    const exitRate = -Q[state * 4 + state]!;
    elapsed += -Math.log(Math.max(Number.MIN_VALUE, random.uniform())) / exitRate;
    if (elapsed >= exposure) break;
    const draw = random.uniform() * exitRate;
    let cumulative = 0;
    for (let next = 0; next < 4; next += 1) {
      if (next === state) continue;
      cumulative += Q[state * 4 + next]!;
      if (draw <= cumulative) {
        state = next;
        break;
      }
    }
  }
  return state;
}

function ratesForSites(sites: number, random: Random, options: SimulationOptions): Float64Array {
  const gammaShape = options.gammaShape ?? 0.55;
  const invariantFraction = options.invariantFraction ?? 0.08;
  const regionalSigma = options.regionalLogRateSigma ?? 0.45;
  const correlation = options.regionalCorrelation ?? 0.985;
  const innovationScale = Math.sqrt(1 - correlation * correlation);
  const rates = new Float64Array(sites);
  let regionalState = random.normal();
  let total = 0;
  for (let site = 0; site < sites; site += 1) {
    regionalState = correlation * regionalState + innovationScale * random.normal();
    if (random.uniform() < invariantFraction) continue;
    const gamma = random.gamma(gammaShape) / gammaShape;
    const regional = Math.exp(regionalSigma * regionalState - regionalSigma * regionalSigma / 2);
    rates[site] = Math.min(15, gamma * regional);
    total += rates[site]!;
  }
  const scale = sites / Math.max(Number.MIN_VALUE, total);
  for (let site = 0; site < sites; site += 1) rates[site] = rates[site]! * scale;
  return rates;
}

function simulateSegment(
  root: SimTreeNode,
  start: number,
  end: number,
  rates: Float64Array,
  sequences: Uint8Array[],
  random: Random,
): void {
  const length = end - start + 1;
  const rootStates = new Uint8Array(length);
  for (let local = 0; local < length; local += 1) rootStates[local] = categorical(PI, random);
  const visit = (node: SimTreeNode, parentStates: Uint8Array): void => {
    const states = new Uint8Array(length);
    for (let local = 0; local < length; local += 1) {
      states[local] = evolveState(parentStates[local]!, node.length * rates[start - 1 + local]!, random);
    }
    if (node.children.length === 0) {
      const taxon = Number(node.name!.slice(1)) - 1;
      sequences[taxon]!.set(states, start - 1);
      return;
    }
    for (const child of node.children) visit(child, states);
  };
  for (const child of root.children) visit(child, rootStates);
}

function applyMissingness(sequences: Uint8Array[], random: Random, options: SimulationOptions): void {
  const missingFraction = options.missingFraction ?? 0.004;
  const gapStart = options.gapStartProbability ?? 0.0005;
  const meanGapLength = options.meanGapLength ?? 3;
  for (const sequence of sequences) {
    for (let site = 0; site < sequence.length; site += 1) {
      if (random.uniform() < missingFraction) sequence[site] = 4;
      if (random.uniform() >= gapStart) continue;
      const length = 1 + Math.floor(Math.log(Math.max(Number.MIN_VALUE, random.uniform())) / Math.log(1 - 1 / meanGapLength));
      for (let offset = 0; offset < length && site + offset < sequence.length; offset += 1) sequence[site + offset] = 5;
      site += length - 1;
    }
  }
}

function quantile(sorted: readonly number[], probability: number): number {
  if (sorted.length === 0) return 0;
  const position = probability * (sorted.length - 1);
  const low = Math.floor(position);
  const high = Math.ceil(position);
  const fraction = position - low;
  return sorted[low]! * (1 - fraction) + sorted[high]! * fraction;
}

export function simulateAlignment(options: SimulationOptions): SimulatedAlignment {
  const random = new Random(options.seed);
  const truthBreakpoints = breakpoints(options.sites, options.scenario.breakpoints, random);
  const boundaries = [0, ...truthBreakpoints, options.sites];
  const trees: SimTreeNode[] = [generateTree(options.taxa, random, options.branchLengthScale ?? 1)];
  for (let segment = 1; segment < boundaries.length - 1; segment += 1) {
    const tree = cloneTree(trees[segment - 1]!);
    const before = unrootedTopologySignature(tree);
    for (let move = 0; move < options.scenario.topologyMovesPerBreakpoint; move += 1) applyUnrootedTopologyChangingNni(tree, random);
    if (unrootedTopologySignature(tree) === before) applyUnrootedTopologyChangingNni(tree, random);
    trees.push(tree);
  }
  const siteRates = ratesForSites(options.sites, random, options);
  const encoded = Array.from({ length: options.taxa }, () => new Uint8Array(options.sites));
  const trueSegments: TrueSegment[] = [];
  for (let segment = 0; segment + 1 < boundaries.length; segment += 1) {
    const start = boundaries[segment]! + 1;
    const end = boundaries[segment + 1]!;
    const tree = trees[segment]!;
    simulateSegment(tree, start, end, siteRates, encoded, random);
    trueSegments.push({ start, end, tree: newick(tree), topology: unrootedTopologySignature(tree) });
  }
  applyMissingness(encoded, random, options);
  const names = Array.from({ length: options.taxa }, (_, index) => `t${index + 1}`);
  const sequences = encoded.map((sequence) => Array.from(sequence, (state) => state < 4 ? NUCLEOTIDES[state]! : state === 4 ? "N" : "-").join(""));
  const fasta = names.map((name, index) => `>${name}\n${sequences[index]}`).join("\n");
  const positiveRates = Array.from(siteRates).filter((value) => value > 0).sort((a, b) => a - b);
  return {
    fasta,
    names,
    sequences,
    trueBreakpoints: truthBreakpoints,
    trueSegments,
    siteRates,
    rateSummary: {
      mean: Array.from(siteRates).reduce((sum, value) => sum + value, 0) / options.sites,
      invariantFraction: 1 - positiveRates.length / options.sites,
      q10: quantile(positiveRates, 0.1),
      median: quantile(positiveRates, 0.5),
      q90: quantile(positiveRates, 0.9),
      maximum: positiveRates.at(-1) ?? 0,
    },
    simulationModel: "GTR CTMC; continuous Gamma site rates; invariant sites; correlated lognormal regional multiplier; NNI piecewise trees; sparse missing data/gap tracts",
  };
}

export const DEFAULT_SCENARIOS: readonly RecombinationScenario[] = [
  { id: "null", label: "No recombination", breakpoints: 0, topologyMovesPerBreakpoint: 0 },
  { id: "one-break", label: "1 breakpoint · 1 NNI", breakpoints: 1, topologyMovesPerBreakpoint: 1 },
  { id: "two-break", label: "2 breakpoints · 1 NNI each", breakpoints: 2, topologyMovesPerBreakpoint: 1 },
  { id: "three-break", label: "3 breakpoints · 1 NNI each", breakpoints: 3, topologyMovesPerBreakpoint: 1 },
];

/** GARD's broader 3 kb coalescent study included 4 and 8 events; keep these
 * explicit stress cases out of the primary accuracy summary. */
export const STRESS_SCENARIOS: readonly RecombinationScenario[] = [
  { id: "four-event-stress", label: "4 breakpoints · 1 NNI each (stress)", breakpoints: 4, topologyMovesPerBreakpoint: 1 },
  { id: "eight-event-stress", label: "8 breakpoints · 1 NNI each (stress)", breakpoints: 8, topologyMovesPerBreakpoint: 1 },
];

/** Broad paired diversity sweep; labels are targets and reports use realized p-distance. */
export const DEFAULT_DIVERSITIES: readonly DiversityRegime[] = [
  { id: "gard-low", label: "GARD low-diversity regime (~5% target)", branchLengthScale: 0.12 },
  { id: "gard-high", label: "GARD high-diversity regime (~25% target)", branchLengthScale: 1.20 },
];

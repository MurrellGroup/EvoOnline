import {
  codonEquilibriumFromF3x4,
  getGeneticCode,
  type GeneticCode,
} from "@phylo-workbench/model-diffubar/browser-source";
import { drawMarginal, Random } from "./random.js";
import type {
  CodonSimulationConfig,
  GtrSpecification,
  LocalTreeTruth,
  ScuffCodonConfig,
  ScuffDiagnostic,
  SimulatedTree,
  SiteParameterTruth,
  StandardCodonConfig,
} from "./types.js";

const PAIR_INDEX = new Int8Array([
  -1, 0, 1, 2,
   0,-1, 3, 4,
   1, 3,-1, 5,
   2, 4, 5,-1,
]);

export const FLU_DEMO_GTR: GtrSpecification = {
  preset: "flu-demo",
  // CodonMolecularEvolution.demo_nucmat off-diagonals, normalized to AC=1.
  exchangeabilities: [1, 2.186519, 0.489476, 0.855297, 2.077248, 0.564529],
  f3x4: [
    0.293117, 0.184379, 0.295274, 0.190878,
    0.342317, 0.199907, 0.154328, 0.267101,
    0.231987, 0.217801, 0.241637, 0.272234,
  ],
};

export const TRANSITION_RICH_GTR: GtrSpecification = {
  preset: "transition-rich",
  exchangeabilities: [1, 4.5, 0.65, 0.8, 5.2, 1.1],
  f3x4: [0.30, 0.19, 0.25, 0.26, 0.27, 0.22, 0.23, 0.28, 0.31, 0.18, 0.23, 0.28],
};

export const BALANCED_GTR: GtrSpecification = {
  preset: "balanced",
  exchangeabilities: [1, 2, 0.8, 0.8, 2, 1],
  f3x4: [0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25],
};

interface CodonKernel {
  readonly code: GeneticCode;
  readonly equilibrium: Float64Array;
  readonly neighborCount: Uint32Array;
  readonly neighborIndex: Uint32Array;
  readonly synonymous: Uint8Array;
  readonly aminoAcidIndex: Int16Array;
  readonly baseRates: Float64Array;
  readonly neutralScale: number;
}

function normalizedF3x4(raw: readonly number[]): Float64Array {
  if (raw.length !== 12) throw new RangeError("F3×4 requires twelve frequencies.");
  const result = Float64Array.from(raw);
  for (let position = 0; position < 3; position += 1) {
    let total = 0;
    for (let nucleotide = 0; nucleotide < 4; nucleotide += 1) total += Math.max(0, result[position * 4 + nucleotide]!);
    if (!(total > 0)) throw new RangeError(`F3×4 position ${position + 1} has no positive mass.`);
    for (let nucleotide = 0; nucleotide < 4; nucleotide += 1) result[position * 4 + nucleotide] = Math.max(1e-9, result[position * 4 + nucleotide]!) / total;
  }
  return result;
}

function buildKernel(config: CodonSimulationConfig): CodonKernel {
  const code = getGeneticCode(config.geneticCodeId);
  const f3x4 = normalizedF3x4(config.gtr.f3x4);
  const exchangeabilities = config.gtr.exchangeabilities;
  if (exchangeabilities.some((value) => !(value > 0) || !Number.isFinite(value))) throw new RangeError("Every GTR exchangeability must be finite and positive.");
  const equilibrium = codonEquilibriumFromF3x4(f3x4, code);
  const topology = code.topology;
  const baseRates = new Float64Array(code.senseCodons.length * topology.maxNeighbors);
  const aaNames = [...new Set(code.senseCodons.map((codon) => code.aminoAcids[codon]!))].sort();
  const aaLookup = new Map(aaNames.map((aa, index) => [aa, index]));
  const aminoAcidIndex = new Int16Array(code.senseCodons.length);
  for (let state = 0; state < code.senseCodons.length; state += 1) aminoAcidIndex[state] = aaLookup.get(code.aminoAcids[code.senseCodons[state]!]!)!;
  let expectedNeutralRate = 0;
  for (let state = 0; state < code.senseCodons.length; state += 1) {
    let exit = 0;
    for (let neighbor = 0; neighbor < topology.count[state]!; neighbor += 1) {
      const offset = state * topology.maxNeighbors + neighbor;
      const from = topology.fromNucleotide[offset]!;
      const to = topology.toNucleotide[offset]!;
      const pair = PAIR_INDEX[from * 4 + to]!;
      const rate = exchangeabilities[pair]! * f3x4[topology.position[offset]! * 4 + to]!;
      baseRates[offset] = rate;
      exit += rate;
    }
    expectedNeutralRate += equilibrium[state]! * exit;
  }
  if (!(expectedNeutralRate > 0)) throw new Error("The neutral codon generator has zero expected rate.");
  return { code, equilibrium, neighborCount: topology.count, neighborIndex: topology.index, synonymous: topology.synonymous, aminoAcidIndex, baseRates, neutralScale: 1 / expectedNeutralRate };
}

function sampleCategorical(weights: ArrayLike<number>, rng: Random): number { return rng.weighted(weights); }

function evolveMg94(stateInput: number, time: number, alpha: number, omega: number, kernel: CodonKernel, rng: Random): number {
  let state = stateInput;
  let elapsed = 0;
  const maxNeighbors = kernel.code.topology.maxNeighbors;
  while (elapsed < time) {
    let total = 0;
    const count = kernel.neighborCount[state]!;
    const rates = new Float64Array(count);
    for (let neighbor = 0; neighbor < count; neighbor += 1) {
      const offset = state * maxNeighbors + neighbor;
      const rate = kernel.baseRates[offset]! * kernel.neutralScale * alpha * (kernel.synonymous[offset] === 1 ? 1 : omega);
      rates[neighbor] = rate;
      total += rate;
    }
    if (!(total > 0)) return state;
    const wait = rng.exponential(total);
    if (elapsed + wait >= time) break;
    elapsed += wait;
    const neighbor = sampleCategorical(rates, rng);
    state = kernel.neighborIndex[state * maxNeighbors + neighbor]!;
  }
  return state;
}

function simulateStandardSite(tree: SimulatedTree, alpha: number, omega: number, kernel: CodonKernel, rng: Random): Map<string, number> {
  const states = new Int32Array(tree.nodes.length);
  states[tree.root] = sampleCategorical(kernel.equilibrium, rng);
  const stack = [tree.root];
  while (stack.length > 0) {
    const parent = stack.pop()!;
    for (const child of tree.nodes[parent]!.children) {
      const duration = Math.max(0, tree.nodes[parent]!.time - tree.nodes[child]!.time) * tree.branchScale;
      states[child] = evolveMg94(states[parent]!, duration, alpha, omega, kernel, rng);
      stack.push(child);
    }
  }
  return new Map(tree.tips.map((tip) => [tree.nodes[tip]!.name!, states[tip]!]));
}

function fixationRate(delta: number): number {
  if (Math.abs(delta) < 1e-4) return 1 + delta / 2 + delta * delta / 12;
  if (delta > 50) return delta;
  if (delta < -50) return -delta * Math.exp(delta);
  return delta / -Math.expm1(-delta);
}

function scuffRates(state: number, fitness: readonly number[], alpha: number, kernel: CodonKernel, destination?: Float64Array): Float64Array {
  const count = kernel.neighborCount[state]!;
  const rates = destination !== undefined && destination.length === count ? destination : new Float64Array(count);
  const maxNeighbors = kernel.code.topology.maxNeighbors;
  const fromFitness = fitness[kernel.aminoAcidIndex[state]!]!;
  for (let neighbor = 0; neighbor < count; neighbor += 1) {
    const offset = state * maxNeighbors + neighbor;
    const toState = kernel.neighborIndex[offset]!;
    const delta = fitness[kernel.aminoAcidIndex[toState]!]! - fromFitness;
    rates[neighbor] = kernel.baseRates[offset]! * kernel.neutralScale * alpha * fixationRate(delta);
  }
  return rates;
}

function jumpFitness(fitness: readonly number[], eventRate: number, sigma: number, mixing: number, rng: Random): number[] {
  if (!(eventRate > 0)) return [...fitness];
  const rho = Math.exp(-Math.max(0, mixing) / eventRate);
  const noise = sigma * Math.sqrt(Math.max(0, 1 - rho * rho));
  return fitness.map((value) => rho * value + noise * rng.normal());
}

interface ScuffState { codon: number; fitness: number[] }

function initialScuffState(sigma: number, kernel: CodonKernel, rng: Random): ScuffState {
  const fitness = Array.from({ length: 20 }, () => sigma * rng.normal());
  const weights = new Float64Array(kernel.equilibrium.length);
  let maxFitness = -Infinity;
  for (const value of fitness) maxFitness = Math.max(maxFitness, value);
  for (let state = 0; state < weights.length; state += 1) weights[state] = kernel.equilibrium[state]! * Math.exp(fitness[kernel.aminoAcidIndex[state]!]! - maxFitness);
  return { codon: sampleCategorical(weights, rng), fitness };
}

function evolveScuff(input: ScuffState, time: number, alpha: number, eventRate: number, sigma: number, mixing: number, kernel: CodonKernel, rng: Random): ScuffState {
  let codon = input.codon;
  let fitness = [...input.fitness];
  let elapsed = 0;
  while (elapsed < time) {
    const rates = scuffRates(codon, fitness, alpha, kernel);
    let substitutionRate = 0;
    for (const rate of rates) substitutionRate += rate;
    const total = eventRate + substitutionRate;
    if (!(total > 0)) break;
    const wait = rng.exponential(total);
    if (elapsed + wait >= time) break;
    elapsed += wait;
    if (rng.uniform() * total < eventRate) fitness = jumpFitness(fitness, eventRate, sigma, mixing, rng);
    else {
      const neighbor = sampleCategorical(rates, rng);
      codon = kernel.neighborIndex[codon * kernel.code.topology.maxNeighbors + neighbor]!;
    }
  }
  return { codon, fitness };
}

function simulateScuffSite(tree: SimulatedTree, alpha: number, eventRate: number, sigma: number, mixing: number, burninTime: number, kernel: CodonKernel, rng: Random): Map<string, number> {
  const states: Array<ScuffState | undefined> = new Array(tree.nodes.length);
  const root = evolveScuff(initialScuffState(sigma, kernel, rng), burninTime, alpha, eventRate, sigma, mixing, kernel, rng);
  states[tree.root] = root;
  const stack = [tree.root];
  while (stack.length > 0) {
    const parent = stack.pop()!;
    for (const child of tree.nodes[parent]!.children) {
      const duration = Math.max(0, tree.nodes[parent]!.time - tree.nodes[child]!.time) * tree.branchScale;
      states[child] = evolveScuff(states[parent]!, duration, alpha, eventRate, sigma, mixing, kernel, rng);
      stack.push(child);
    }
  }
  return new Map(tree.tips.map((tip) => [tree.nodes[tip]!.name!, states[tip]!.codon]));
}

function drawSiteParameters(config: CodonSimulationConfig, rng: Random): SiteParameterTruth {
  const alpha = Array.from({ length: config.sites }, () => drawMarginal(config.alpha, rng));
  if (config.engine === "mg94") return { alpha, omega: Array.from({ length: config.sites }, () => drawMarginal(config.omega, rng)) };
  const equilibriumSigma = Array.from({ length: config.sites }, () => drawMarginal(config.equilibriumSigma, rng));
  return {
    alpha,
    eventRate: Array.from({ length: config.sites }, () => drawMarginal(config.eventRate, rng)),
    equilibriumSigma,
    mixingRate: Array.from({ length: config.sites }, () => drawMarginal(config.mixingRate, rng)),
    scuffMaximumExpectedDnds: equilibriumSigma.map((sigma) => Math.sqrt(sigma * sigma + Math.PI) / Math.sqrt(Math.PI)),
  };
}

export interface AlignmentSimulation {
  readonly names: readonly string[];
  readonly sequences: readonly string[];
  readonly siteParameters: SiteParameterTruth;
}

export function simulateCodonAlignment(
  localTrees: readonly LocalTreeTruth[],
  config: CodonSimulationConfig,
  rng: Random,
  onProgress?: (completedSites: number, totalSites: number) => void,
): AlignmentSimulation {
  const kernel = buildKernel(config);
  const params = drawSiteParameters(config, rng);
  const firstTree = localTrees[0]?.tree;
  if (firstTree === undefined) throw new Error("Codon simulation requires at least one local tree.");
  const names = firstTree.tips.map((tip) => firstTree.nodes[tip]!.name!).sort();
  const sequenceCodons = new Map(names.map((name) => [name, new Array<string>(config.sites)]));
  for (const region of localTrees) {
    for (let site = region.startCodon - 1; site < region.endCodon; site += 1) {
      const states = config.engine === "mg94"
        ? simulateStandardSite(region.tree, params.alpha[site]!, params.omega![site]!, kernel, rng)
        : simulateScuffSite(region.tree, params.alpha[site]!, params.eventRate![site]!, params.equilibriumSigma![site]!, params.mixingRate![site]!, config.burninTime, kernel, rng);
      for (const name of names) {
        const state = states.get(name);
        if (state === undefined) throw new Error(`Local tree lacks observed tip '${name}'.`);
        sequenceCodons.get(name)![site] = kernel.code.senseCodons[state]!;
      }
      onProgress?.(site + 1, config.sites);
    }
  }
  return { names, sequences: names.map((name) => sequenceCodons.get(name)!.join("")), siteParameters: params };
}

function fullGenerator(fitness: readonly number[], alpha: number, kernel: CodonKernel): { rows: Float64Array[]; exits: Float64Array; mu: number } {
  const rows: Float64Array[] = [];
  const exits = new Float64Array(kernel.code.senseCodons.length);
  let mu = 0;
  for (let state = 0; state < kernel.code.senseCodons.length; state += 1) {
    const row = scuffRates(state, fitness, alpha, kernel);
    rows.push(row);
    let exit = 0;
    for (const value of row) exit += value;
    exits[state] = exit;
    mu = Math.max(mu, exit);
  }
  return { rows, exits, mu };
}

function uniformizationStep(probabilities: Float64Array<ArrayBufferLike>, dt: number, fitness: readonly number[], alpha: number, kernel: CodonKernel): Float64Array<ArrayBufferLike> {
  if (!(dt > 0)) return probabilities;
  const generator = fullGenerator(fitness, alpha, kernel);
  if (!(generator.mu > 0)) return probabilities;
  const steps = Math.max(1, Math.ceil(generator.mu * dt / 8));
  const stepTime = dt / steps;
  let current = probabilities;
  for (let step = 0; step < steps; step += 1) {
    const lambda = generator.mu * stepTime;
    let term = Float64Array.from(current);
    let weight = Math.exp(-lambda);
    let mass = weight;
    const output = new Float64Array(current.length);
    for (let state = 0; state < output.length; state += 1) output[state] = weight * term[state]!;
    for (let order = 1; order < 192; order += 1) {
      const next = new Float64Array(current.length);
      for (let state = 0; state < current.length; state += 1) {
        const value = term[state]!;
        next[state] = next[state]! + value * (1 - generator.exits[state]! / generator.mu);
        const row = generator.rows[state]!;
        for (let neighbor = 0; neighbor < row.length; neighbor += 1) {
          const target = kernel.neighborIndex[state * kernel.code.topology.maxNeighbors + neighbor]!;
          next[target] = next[target]! + value * row[neighbor]! / generator.mu;
        }
      }
      term = next;
      weight *= lambda / order;
      mass += weight;
      for (let state = 0; state < output.length; state += 1) output[state] = output[state]! + weight * term[state]!;
      if (order > lambda && 1 - mass < 1e-13) break;
    }
    let total = 0;
    for (const value of output) total += value;
    if (!(total > 0)) throw new Error("SCUFF codon-frequency propagation underflowed.");
    for (let state = 0; state < output.length; state += 1) output[state] = output[state]! / total;
    current = output;
  }
  return current;
}

function expectedDnds(probabilities: Float64Array, fitness: readonly number[], alpha: number, kernel: CodonKernel): number {
  let selectedN = 0;
  let neutralN = 0;
  let selectedS = 0;
  let neutralS = 0;
  const maxNeighbors = kernel.code.topology.maxNeighbors;
  for (let state = 0; state < probabilities.length; state += 1) {
    const selected = scuffRates(state, fitness, alpha, kernel);
    for (let neighbor = 0; neighbor < selected.length; neighbor += 1) {
      const offset = state * maxNeighbors + neighbor;
      const base = kernel.baseRates[offset]! * kernel.neutralScale * alpha;
      const weightedSelected = probabilities[state]! * selected[neighbor]!;
      const weightedNeutral = probabilities[state]! * base;
      if (kernel.synonymous[offset] === 1) { selectedS += weightedSelected; neutralS += weightedNeutral; }
      else { selectedN += weightedSelected; neutralN += weightedNeutral; }
    }
  }
  const dN = neutralN > 0 ? selectedN / neutralN : 0;
  const dS = neutralS > 0 ? selectedS / neutralS : 1;
  return dS > 0 ? dN / dS : dN;
}

export function scuffDiagnostic(config: ScuffCodonConfig, rng: Random, onProgress?: (completed: number, total: number) => void): ScuffDiagnostic {
  const kernel = buildKernel(config);
  const alpha = config.alpha.mean;
  const eventRate = config.eventRate.mean;
  const sigma = config.equilibriumSigma.mean;
  const mixing = config.mixingRate.mean;
  let fitness = Array.from({ length: 20 }, () => sigma * rng.normal());
  let probabilities: Float64Array<ArrayBufferLike> = Float64Array.from(kernel.equilibrium);
  let time = -Math.max(0, config.burninTime);
  let nextJump = eventRate > 0 ? time + rng.exponential(eventRate) : Infinity;
  const advance = (target: number): void => {
    while (nextJump < target) {
      probabilities = uniformizationStep(probabilities, nextJump - time, fitness, alpha, kernel);
      time = nextJump;
      fitness = jumpFitness(fitness, eventRate, sigma, mixing, rng);
      nextJump += rng.exponential(eventRate);
    }
    probabilities = uniformizationStep(probabilities, target - time, fitness, alpha, kernel);
    time = target;
  };
  advance(0);
  const count = 181;
  const times: number[] = [];
  const fitnessOutput: number[] = [];
  const frequencyOutput: number[] = [];
  const dnds: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const target = config.diagnosticTime * i / (count - 1);
    advance(target);
    times.push(target);
    fitnessOutput.push(...fitness);
    frequencyOutput.push(...probabilities);
    dnds.push(expectedDnds(probabilities, fitness, alpha, kernel));
    if (i === count - 1 || i % 4 === 0) onProgress?.(i + 1, count);
  }
  const aminoAcids = kernel.code.senseCodons.map((codon) => kernel.code.aminoAcids[codon]!);
  return {
    times,
    fitness: fitnessOutput,
    codonFrequencies: frequencyOutput,
    codons: kernel.code.senseCodons,
    aminoAcids,
    dnds,
    maximumExpectedDnds: Math.sqrt(sigma * sigma + Math.PI) / Math.sqrt(Math.PI),
    sampledMeanDnds: dnds.reduce((sum, value) => sum + value, 0) / dnds.length,
  };
}

export function writeFasta(names: readonly string[], sequences: readonly string[]): string {
  return names.map((name, index) => `>${name}\n${sequences[index]!.match(/.{1,80}/g)?.join("\n") ?? ""}`).join("\n");
}

export function alignmentDiagnostics(sequences: readonly string[], codeInput: StandardCodonConfig["geneticCodeId"]): { meanNucleotideDistance: number; meanAminoAcidDistance: number; segregatingNucleotideSites: number } {
  if (sequences.length < 2) return { meanNucleotideDistance: 0, meanAminoAcidDistance: 0, segregatingNucleotideSites: 0 };
  const code = getGeneticCode(codeInput);
  let nucleotideDifference = 0;
  let aminoAcidDifference = 0;
  let pairs = 0;
  const codonSites = sequences[0]!.length / 3;
  for (let left = 0; left < sequences.length; left += 1) for (let right = left + 1; right < sequences.length; right += 1) {
    pairs += 1;
    for (let site = 0; site < sequences[left]!.length; site += 1) if (sequences[left]![site] !== sequences[right]![site]) nucleotideDifference += 1;
    for (let site = 0; site < codonSites; site += 1) {
      const a = code.aminoAcids[sequences[left]!.slice(site * 3, site * 3 + 3)] ?? "X";
      const b = code.aminoAcids[sequences[right]!.slice(site * 3, site * 3 + 3)] ?? "X";
      if (a !== b) aminoAcidDifference += 1;
    }
  }
  let segregatingNucleotideSites = 0;
  for (let site = 0; site < sequences[0]!.length; site += 1) if (new Set(sequences.map((sequence) => sequence[site])).size > 1) segregatingNucleotideSites += 1;
  return { meanNucleotideDistance: nucleotideDifference / (pairs * sequences[0]!.length), meanAminoAcidDistance: aminoAcidDifference / (pairs * codonSites), segregatingNucleotideSites };
}

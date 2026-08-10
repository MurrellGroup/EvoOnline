import { DifFUBARError, type FastaAlignment, type ModelBank, type DifFUBARGrid, type ParsedTree } from "../types.js";

export const NUCLEOTIDES = ["A", "C", "G", "T"] as const;

const UNIVERSAL_AA: Readonly<Record<string, string>> = Object.freeze({
  TTT: "F", TTC: "F", TTA: "L", TTG: "L",
  TCT: "S", TCC: "S", TCA: "S", TCG: "S",
  TAT: "Y", TAC: "Y", TAA: "*", TAG: "*",
  TGT: "C", TGC: "C", TGA: "*", TGG: "W",
  CTT: "L", CTC: "L", CTA: "L", CTG: "L",
  CCT: "P", CCC: "P", CCA: "P", CCG: "P",
  CAT: "H", CAC: "H", CAA: "Q", CAG: "Q",
  CGT: "R", CGC: "R", CGA: "R", CGG: "R",
  ATT: "I", ATC: "I", ATA: "I", ATG: "M",
  ACT: "T", ACC: "T", ACA: "T", ACG: "T",
  AAT: "N", AAC: "N", AAA: "K", AAG: "K",
  AGT: "S", AGC: "S", AGA: "R", AGG: "R",
  GTT: "V", GTC: "V", GTA: "V", GTG: "V",
  GCT: "A", GCC: "A", GCA: "A", GCG: "A",
  GAT: "D", GAC: "D", GAA: "E", GAG: "E",
  GGT: "G", GGC: "G", GGA: "G", GGG: "G",
});

const ALL_CODONS = Object.keys(UNIVERSAL_AA).sort();
export const SENSE_CODONS = Object.freeze(ALL_CODONS.filter((codon) => UNIVERSAL_AA[codon] !== "*"));
export const CODON_COUNT = SENSE_CODONS.length;
export const MISSING_CODON = 255;

const CODON_TO_STATE = new Map(SENSE_CODONS.map((codon, index) => [codon, index]));
const NUC_TO_INDEX = new Map<string, number>(NUCLEOTIDES.map((nuc, index) => [nuc, index]));

export interface CodonTopology {
  readonly maxNeighbors: number;
  readonly count: Uint32Array;
  readonly index: Uint32Array;
  readonly position: Uint8Array;
  readonly fromNucleotide: Uint8Array;
  readonly toNucleotide: Uint8Array;
  readonly synonymous: Uint8Array;
}

export function buildCodonTopology(): CodonTopology {
  const rows: Array<Array<{ index: number; position: number; from: number; to: number; synonymous: number }>> = [];
  let maxNeighbors = 0;
  for (let i = 0; i < CODON_COUNT; i += 1) {
    const fromCodon = SENSE_CODONS[i]!;
    const row: Array<{ index: number; position: number; from: number; to: number; synonymous: number }> = [];
    for (let j = 0; j < CODON_COUNT; j += 1) {
      if (i === j) continue;
      const toCodon = SENSE_CODONS[j]!;
      let difference = -1;
      let differences = 0;
      for (let p = 0; p < 3; p += 1) {
        if (fromCodon[p] !== toCodon[p]) {
          difference = p;
          differences += 1;
        }
      }
      if (differences !== 1) continue;
      const from = NUC_TO_INDEX.get(fromCodon[difference]!)!;
      const to = NUC_TO_INDEX.get(toCodon[difference]!)!;
      row.push({
        index: j,
        position: difference,
        from,
        to,
        synonymous: UNIVERSAL_AA[fromCodon] === UNIVERSAL_AA[toCodon] ? 1 : 0,
      });
    }
    maxNeighbors = Math.max(maxNeighbors, row.length);
    rows.push(row);
  }

  const count = new Uint32Array(CODON_COUNT);
  const index = new Uint32Array(CODON_COUNT * maxNeighbors);
  const position = new Uint8Array(CODON_COUNT * maxNeighbors);
  const fromNucleotide = new Uint8Array(CODON_COUNT * maxNeighbors);
  const toNucleotide = new Uint8Array(CODON_COUNT * maxNeighbors);
  const synonymous = new Uint8Array(CODON_COUNT * maxNeighbors);
  index.fill(0xff);

  for (let state = 0; state < CODON_COUNT; state += 1) {
    const row = rows[state]!;
    count[state] = row.length;
    for (let k = 0; k < row.length; k += 1) {
      const offset = state * maxNeighbors + k;
      const edge = row[k]!;
      index[offset] = edge.index;
      position[offset] = edge.position;
      fromNucleotide[offset] = edge.from;
      toNucleotide[offset] = edge.to;
      synonymous[offset] = edge.synonymous;
    }
  }
  return { maxNeighbors, count, index, position, fromNucleotide, toNucleotide, synonymous };
}

export const CODON_TOPOLOGY = buildCodonTopology();

/** Matches MolecularEvolution.count_F3x4, including its denominator convention. */
export function countF3x4(alignment: FastaAlignment): Float64Array {
  const frequencies = new Float64Array(12);
  const denominator = alignment.names.length * alignment.codonSites;
  if (denominator === 0) throw new DifFUBARError("EMPTY_ALIGNMENT", "The alignment has no codon sites.");
  for (const raw of alignment.sequences) {
    const sequence = raw.toUpperCase();
    for (let site = 0; site < alignment.codonSites; site += 1) {
      const baseOffset = site * 3;
      for (let position = 0; position < 3; position += 1) {
        const nucleotide = NUC_TO_INDEX.get(sequence[baseOffset + position]!);
        if (nucleotide !== undefined) {
          const offset = position * 4 + nucleotide;
          frequencies[offset] = frequencies[offset]! + 1;
        }
      }
    }
  }
  for (let i = 0; i < frequencies.length; i += 1) frequencies[i] = frequencies[i]! / denominator;
  return frequencies;
}

export function codonEquilibriumFromF3x4(f3x4: ArrayLike<number>): Float64Array {
  if (f3x4.length !== 12) throw new DifFUBARError("INVALID_F3X4", "F3x4 must contain exactly 12 values.");
  const equilibrium = new Float64Array(CODON_COUNT);
  let total = 0;
  for (let state = 0; state < CODON_COUNT; state += 1) {
    const codon = SENSE_CODONS[state]!;
    let probability = 1;
    for (let position = 0; position < 3; position += 1) {
      probability *= f3x4[position * 4 + NUC_TO_INDEX.get(codon[position]!)!]!;
    }
    equilibrium[state] = probability;
    total += probability;
  }
  if (!(total > 0)) throw new DifFUBARError("INVALID_F3X4", "F3x4 assigns zero mass to all sense codons.");
  for (let state = 0; state < CODON_COUNT; state += 1) equilibrium[state] = equilibrium[state]! / total;
  return equilibrium;
}

export function encodeCodonTips(alignment: FastaAlignment, tree: ParsedTree): Uint8Array {
  const sequenceIndex = new Map(alignment.names.map((name, index) => [name, index]));
  const encoded = new Uint8Array(tree.tips.length * alignment.codonSites);
  encoded.fill(MISSING_CODON);
  for (const tip of tree.tips) {
    const alignmentIndex = sequenceIndex.get(tip.name);
    if (alignmentIndex === undefined) {
      throw new DifFUBARError("MISSING_SEQUENCE", `No sequence matches tree tip '${tip.name}'.`);
    }
    const sequence = alignment.sequences[alignmentIndex]!.toUpperCase().replaceAll("U", "T");
    for (let site = 0; site < alignment.codonSites; site += 1) {
      const codon = sequence.slice(site * 3, site * 3 + 3);
      encoded[tip.tipIndex * alignment.codonSites + site] = CODON_TO_STATE.get(codon) ?? MISSING_CODON;
    }
  }
  return encoded;
}

const GTR_PAIR_INDEX = new Int8Array([
  -1, 0, 1, 2,
   0,-1, 3, 4,
   1, 3,-1, 5,
   2, 4, 5,-1,
]);

export function buildModelBank(
  grid: DifFUBARGrid,
  tree: ParsedTree,
  gtrRates: ArrayLike<number>,
  f3x4: ArrayLike<number>,
): ModelBank {
  if (gtrRates.length !== 6) throw new DifFUBARError("INVALID_GTR", "GTR requires six exchangeabilities.");
  const classCount = tree.classCount;
  if (classCount !== grid.parameterCount - 1) {
    throw new DifFUBARError("CLASS_GRID_MISMATCH", `Tree has ${classCount} branch classes but grid has ${grid.parameterCount - 1} omega axes.`);
  }

  const modelIds = new Map<string, number>();
  const modelAlpha: number[] = [];
  const modelOmega: number[] = [];
  const gridModels = new Uint32Array(grid.categoryCount * classCount);
  for (let category = 0; category < grid.categoryCount; category += 1) {
    const base = category * grid.parameterCount;
    const alpha = grid.categories[base]!;
    for (let branchClass = 0; branchClass < classCount; branchClass += 1) {
      const omega = grid.categories[base + 1 + branchClass]!;
      const key = `${alpha.toPrecision(17)}|${omega.toPrecision(17)}`;
      let modelId = modelIds.get(key);
      if (modelId === undefined) {
        modelId = modelAlpha.length;
        modelIds.set(key, modelId);
        modelAlpha.push(alpha);
        modelOmega.push(omega);
      }
      gridModels[category * classCount + branchClass] = modelId;
    }
  }

  const { maxNeighbors, count, index, position, fromNucleotide, toNucleotide, synonymous } = CODON_TOPOLOGY;
  const modelCount = modelAlpha.length;
  const rDiagonal = new Float64Array(modelCount * CODON_COUNT);
  const rOffDiagonal = new Float64Array(modelCount * CODON_COUNT * maxNeighbors);
  const mu = new Float64Array(modelCount);

  for (let model = 0; model < modelCount; model += 1) {
    const alpha = modelAlpha[model]!;
    const omega = modelOmega[model]!;
    let modelMu = 0;
    for (let state = 0; state < CODON_COUNT; state += 1) {
      let exitRate = 0;
      const neighbors = count[state]!;
      for (let k = 0; k < neighbors; k += 1) {
        const topologyOffset = state * maxNeighbors + k;
        const from = fromNucleotide[topologyOffset]!;
        const to = toNucleotide[topologyOffset]!;
        const rateIndex = GTR_PAIR_INDEX[from * 4 + to]!;
        const selectionRate = synonymous[topologyOffset] === 1 ? alpha : alpha * omega;
        const q = selectionRate * gtrRates[rateIndex]! * f3x4[position[topologyOffset]! * 4 + to]!;
        rOffDiagonal[model * CODON_COUNT * maxNeighbors + topologyOffset] = q;
        exitRate += q;
      }
      rDiagonal[model * CODON_COUNT + state] = -exitRate;
      modelMu = Math.max(modelMu, exitRate);
    }
    if (!(modelMu > 0) || !Number.isFinite(modelMu)) {
      throw new DifFUBARError("INVALID_MODEL", `MG94 model ${model} has invalid uniformization rate ${modelMu}.`);
    }
    mu[model] = modelMu;
    for (let state = 0; state < CODON_COUNT; state += 1) {
      rDiagonal[model * CODON_COUNT + state] = 1 + rDiagonal[model * CODON_COUNT + state]! / modelMu;
      for (let k = 0; k < count[state]!; k += 1) {
        const offset = model * CODON_COUNT * maxNeighbors + state * maxNeighbors + k;
        rOffDiagonal[offset] = rOffDiagonal[offset]! / modelMu;
      }
    }
  }

  return {
    stateCount: CODON_COUNT,
    maxNeighbors,
    modelCount,
    neighborCount: count,
    neighborIndex: index,
    rDiagonal,
    rOffDiagonal,
    mu,
    modelAlpha: Float64Array.from(modelAlpha),
    modelOmega: Float64Array.from(modelOmega),
    gridModels,
  };
}

export function countNucleotideFrequencies(alignment: FastaAlignment): Float64Array {
  const frequencies = new Float64Array(4);
  let observed = 0;
  for (const raw of alignment.sequences) {
    const sequence = raw.toUpperCase().replaceAll("U", "T");
    for (const character of sequence) {
      const index = NUC_TO_INDEX.get(character);
      if (index !== undefined) {
        frequencies[index] = frequencies[index]! + 1;
        observed += 1;
      }
    }
  }
  if (observed === 0) throw new DifFUBARError("NO_NUCLEOTIDES", "The alignment contains no A/C/G/T observations.");
  for (let i = 0; i < 4; i += 1) frequencies[i] = frequencies[i]! / observed;
  return frequencies;
}

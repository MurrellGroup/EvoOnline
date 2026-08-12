import { DifFUBARError, type FastaAlignment, type ModelBank, type DifFUBARGrid, type ParsedTree } from "../types.js";

export const NUCLEOTIDES = ["A", "C", "G", "T"] as const;
export const MISSING_CODON = 255;

/**
 * Current, unambiguous NCBI translation tables supported by the codon CTMC.
 * Tables 27, 28, and 31 are intentionally excluded because one or more codons
 * are context-dependent sense/termination codons and therefore cannot be a
 * single state in a stationary MG94 process.
 */
export type GeneticCodeId =
  | 1 | 2 | 3 | 4 | 5 | 6 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16
  | 21 | 22 | 23 | 24 | 25 | 26 | 29 | 30 | 32 | 33;

export interface CodonTopology {
  readonly maxNeighbors: number;
  readonly count: Uint32Array;
  readonly index: Uint32Array;
  readonly position: Uint8Array;
  readonly fromNucleotide: Uint8Array;
  readonly toNucleotide: Uint8Array;
  readonly synonymous: Uint8Array;
}

export interface GeneticCode {
  readonly id: GeneticCodeId;
  readonly name: string;
  /** NCBI's 64-character amino-acid row in T,C,A,G base order. */
  readonly ncbiAminoAcids: string;
  readonly aminoAcids: Readonly<Record<string, string>>;
  /** Lexically sorted DNA codons, preserving table-1 ordering for parity. */
  readonly senseCodons: readonly string[];
  readonly stopCodons: readonly string[];
  readonly stateByCodon: ReadonlyMap<string, number>;
  readonly topology: CodonTopology;
}

export type GeneticCodeInput = GeneticCodeId | `${GeneticCodeId}` | GeneticCode;

interface GeneticCodeDefinition {
  readonly id: GeneticCodeId;
  readonly name: string;
  readonly aminoAcids: string;
}

const NCBI_BASE_ORDER = ["T", "C", "A", "G"] as const;
const NCBI_CODON_ORDER = Object.freeze(NCBI_BASE_ORDER.flatMap((first) =>
  NCBI_BASE_ORDER.flatMap((second) => NCBI_BASE_ORDER.map((third) => `${first}${second}${third}`)),
));
const ALL_CODONS = Object.freeze([...NCBI_CODON_ORDER].sort());
const NUC_TO_INDEX = new Map<string, number>(NUCLEOTIDES.map((nuc, index) => [nuc, index]));

const DEFINITIONS: readonly GeneticCodeDefinition[] = [
  { id: 1, name: "Standard", aminoAcids: "FFLLSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG" },
  { id: 2, name: "Vertebrate mitochondrial", aminoAcids: "FFLLSSSSYY**CCWWLLLLPPPPHHQQRRRRIIMMTTTTNNKKSS**VVVVAAAADDEEGGGG" },
  { id: 3, name: "Yeast mitochondrial", aminoAcids: "FFLLSSSSYY**CCWWTTTTPPPPHHQQRRRRIIMMTTTTNNKKSSRRVVVVAAAADDEEGGGG" },
  { id: 4, name: "Mold/protozoan/coelenterate mitochondrial and Mycoplasma/Spiroplasma", aminoAcids: "FFLLSSSSYY**CCWWLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG" },
  { id: 5, name: "Invertebrate mitochondrial", aminoAcids: "FFLLSSSSYY**CCWWLLLLPPPPHHQQRRRRIIMMTTTTNNKKSSSSVVVVAAAADDEEGGGG" },
  { id: 6, name: "Ciliate, Dasycladacean and Hexamita nuclear", aminoAcids: "FFLLSSSSYYQQCC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG" },
  { id: 9, name: "Echinoderm and flatworm mitochondrial", aminoAcids: "FFLLSSSSYY**CCWWLLLLPPPPHHQQRRRRIIIMTTTTNNNKSSSSVVVVAAAADDEEGGGG" },
  { id: 10, name: "Euplotid nuclear", aminoAcids: "FFLLSSSSYY**CCCWLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG" },
  { id: 11, name: "Bacterial, archaeal and plant plastid", aminoAcids: "FFLLSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG" },
  { id: 12, name: "Alternative yeast nuclear", aminoAcids: "FFLLSSSSYY**CC*WLLLSPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG" },
  { id: 13, name: "Ascidian mitochondrial", aminoAcids: "FFLLSSSSYY**CCWWLLLLPPPPHHQQRRRRIIMMTTTTNNKKSSGGVVVVAAAADDEEGGGG" },
  { id: 14, name: "Alternative flatworm mitochondrial", aminoAcids: "FFLLSSSSYYY*CCWWLLLLPPPPHHQQRRRRIIIMTTTTNNNKSSSSVVVVAAAADDEEGGGG" },
  { id: 15, name: "Blepharisma nuclear", aminoAcids: "FFLLSSSSYY*QCC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG" },
  { id: 16, name: "Chlorophycean mitochondrial", aminoAcids: "FFLLSSSSYY*LCC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG" },
  { id: 21, name: "Trematode mitochondrial", aminoAcids: "FFLLSSSSYY**CCWWLLLLPPPPHHQQRRRRIIMMTTTTNNNKSSSSVVVVAAAADDEEGGGG" },
  { id: 22, name: "Scenedesmus obliquus mitochondrial", aminoAcids: "FFLLSS*SYY*LCC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG" },
  { id: 23, name: "Thraustochytrium mitochondrial", aminoAcids: "FF*LSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG" },
  { id: 24, name: "Rhabdopleuridae mitochondrial", aminoAcids: "FFLLSSSSYY**CCWWLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSSKVVVVAAAADDEEGGGG" },
  { id: 25, name: "Candidate Division SR1 and Gracilibacteria", aminoAcids: "FFLLSSSSYY**CCGWLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG" },
  { id: 26, name: "Pachysolen tannophilus nuclear", aminoAcids: "FFLLSSSSYY**CC*WLLLAPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG" },
  { id: 29, name: "Mesodinium nuclear", aminoAcids: "FFLLSSSSYYYYCC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG" },
  { id: 30, name: "Peritrich nuclear", aminoAcids: "FFLLSSSSYYEECC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG" },
  { id: 32, name: "Balanophoraceae plastid", aminoAcids: "FFLLSSSSYY*WCC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG" },
  { id: 33, name: "Cephalodiscidae mitochondrial UAA-Tyr", aminoAcids: "FFLLSSSSYYY*CCWWLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSSKVVVVAAAADDEEGGGG" },
] as const;

function topologyFor(
  senseCodons: readonly string[],
  aminoAcids: Readonly<Record<string, string>>,
): CodonTopology {
  const rows: Array<Array<{ index: number; position: number; from: number; to: number; synonymous: number }>> = [];
  let maxNeighbors = 0;
  for (let i = 0; i < senseCodons.length; i += 1) {
    const fromCodon = senseCodons[i]!;
    const row: Array<{ index: number; position: number; from: number; to: number; synonymous: number }> = [];
    for (let j = 0; j < senseCodons.length; j += 1) {
      if (i === j) continue;
      const toCodon = senseCodons[j]!;
      let difference = -1;
      let differences = 0;
      for (let position = 0; position < 3; position += 1) {
        if (fromCodon[position] !== toCodon[position]) {
          difference = position;
          differences += 1;
        }
      }
      if (differences !== 1) continue;
      row.push({
        index: j,
        position: difference,
        from: NUC_TO_INDEX.get(fromCodon[difference]!)!,
        to: NUC_TO_INDEX.get(toCodon[difference]!)!,
        synonymous: aminoAcids[fromCodon] === aminoAcids[toCodon] ? 1 : 0,
      });
    }
    maxNeighbors = Math.max(maxNeighbors, row.length);
    rows.push(row);
  }

  const stateCount = senseCodons.length;
  const count = new Uint32Array(stateCount);
  const index = new Uint32Array(stateCount * maxNeighbors);
  const position = new Uint8Array(stateCount * maxNeighbors);
  const fromNucleotide = new Uint8Array(stateCount * maxNeighbors);
  const toNucleotide = new Uint8Array(stateCount * maxNeighbors);
  const synonymous = new Uint8Array(stateCount * maxNeighbors);
  index.fill(0xff);
  for (let state = 0; state < stateCount; state += 1) {
    const row = rows[state]!;
    count[state] = row.length;
    for (let neighbor = 0; neighbor < row.length; neighbor += 1) {
      const offset = state * maxNeighbors + neighbor;
      const edge = row[neighbor]!;
      index[offset] = edge.index;
      position[offset] = edge.position;
      fromNucleotide[offset] = edge.from;
      toNucleotide[offset] = edge.to;
      synonymous[offset] = edge.synonymous;
    }
  }
  return { maxNeighbors, count, index, position, fromNucleotide, toNucleotide, synonymous };
}

function createGeneticCode(definition: GeneticCodeDefinition): GeneticCode {
  if (definition.aminoAcids.length !== 64) {
    throw new Error(`NCBI genetic code ${definition.id} has ${definition.aminoAcids.length} assignments instead of 64.`);
  }
  const entries = NCBI_CODON_ORDER.map((codon, index) => [codon, definition.aminoAcids[index]!] as const);
  const aminoAcids = Object.freeze(Object.fromEntries(entries) as Record<string, string>);
  const senseCodons = Object.freeze(ALL_CODONS.filter((codon) => aminoAcids[codon] !== "*"));
  const stopCodons = Object.freeze(ALL_CODONS.filter((codon) => aminoAcids[codon] === "*"));
  const stateByCodon = new Map(senseCodons.map((codon, index) => [codon, index]));
  return Object.freeze({
    id: definition.id,
    name: definition.name,
    ncbiAminoAcids: definition.aminoAcids,
    aminoAcids,
    senseCodons,
    stopCodons,
    stateByCodon,
    topology: topologyFor(senseCodons, aminoAcids),
  });
}

export const GENETIC_CODES: readonly GeneticCode[] = Object.freeze(DEFINITIONS.map(createGeneticCode));
const GENETIC_CODE_BY_ID = new Map<number, GeneticCode>(GENETIC_CODES.map((code) => [code.id, code]));
export const CONTEXT_DEPENDENT_GENETIC_CODE_IDS = Object.freeze([27, 28, 31] as const);
export const GENETIC_CODE_OPTIONS = Object.freeze(GENETIC_CODES.map((code) => ({
  value: String(code.id),
  label: `NCBI ${code.id} · ${code.name}`,
})));

export function getGeneticCode(input: GeneticCodeInput | number | string | undefined = 1): GeneticCode {
  if (typeof input === "object") return input;
  const id = typeof input === "number" ? input : Number(input);
  if (CONTEXT_DEPENDENT_GENETIC_CODE_IDS.includes(id as 27 | 28 | 31)) {
    throw new DifFUBARError(
      "CONTEXT_DEPENDENT_GENETIC_CODE",
      `NCBI genetic code ${id} contains codons that are sense or STOP depending on context; that behavior cannot be represented by this stationary codon model.`,
    );
  }
  const code = Number.isInteger(id) ? GENETIC_CODE_BY_ID.get(id) : undefined;
  if (code === undefined) {
    throw new DifFUBARError("UNSUPPORTED_GENETIC_CODE", `Unsupported NCBI genetic code '${String(input)}'.`);
  }
  return code;
}

export function translateCodon(codon: string, input: GeneticCodeInput | number | string = 1): string | undefined {
  return getGeneticCode(input).aminoAcids[codon.toUpperCase().replaceAll("U", "T")];
}

export const STANDARD_GENETIC_CODE = getGeneticCode(1);
/** Backward-compatible table-1 exports used by existing scripts and fixtures. */
export const SENSE_CODONS = STANDARD_GENETIC_CODE.senseCodons;
export const CODON_COUNT = SENSE_CODONS.length;
export const CODON_TOPOLOGY = STANDARD_GENETIC_CODE.topology;

export function buildCodonTopology(input: GeneticCodeInput | number | string = 1): CodonTopology {
  return getGeneticCode(input).topology;
}

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

export function codonEquilibriumFromF3x4(
  f3x4: ArrayLike<number>,
  input: GeneticCodeInput | number | string = 1,
): Float64Array {
  if (f3x4.length !== 12) throw new DifFUBARError("INVALID_F3X4", "F3x4 must contain exactly 12 values.");
  const code = getGeneticCode(input);
  const equilibrium = new Float64Array(code.senseCodons.length);
  let total = 0;
  for (let state = 0; state < code.senseCodons.length; state += 1) {
    const codon = code.senseCodons[state]!;
    let probability = 1;
    for (let position = 0; position < 3; position += 1) {
      probability *= f3x4[position * 4 + NUC_TO_INDEX.get(codon[position]!)!]!;
    }
    equilibrium[state] = probability;
    total += probability;
  }
  if (!(total > 0)) throw new DifFUBARError("INVALID_F3X4", "F3x4 assigns zero mass to all sense codons.");
  for (let state = 0; state < equilibrium.length; state += 1) equilibrium[state] = equilibrium[state]! / total;
  return equilibrium;
}

export function encodeCodonTips(
  alignment: FastaAlignment,
  tree: ParsedTree,
  input: GeneticCodeInput | number | string = 1,
): Uint8Array {
  const code = getGeneticCode(input);
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
      encoded[tip.tipIndex * alignment.codonSites + site] = code.stateByCodon.get(codon) ?? MISSING_CODON;
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
  input: GeneticCodeInput | number | string = 1,
): ModelBank {
  if (gtrRates.length !== 6) throw new DifFUBARError("INVALID_GTR", "GTR requires six exchangeabilities.");
  const classCount = tree.classCount;
  if (classCount !== grid.parameterCount - 1) {
    throw new DifFUBARError("CLASS_GRID_MISMATCH", `Tree has ${classCount} branch classes but grid has ${grid.parameterCount - 1} omega axes.`);
  }
  const code = getGeneticCode(input);
  const stateCount = code.senseCodons.length;

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

  const { maxNeighbors, count, index, position, fromNucleotide, toNucleotide, synonymous } = code.topology;
  const modelCount = modelAlpha.length;
  const rDiagonal = new Float64Array(modelCount * stateCount);
  const rOffDiagonal = new Float64Array(modelCount * stateCount * maxNeighbors);
  const mu = new Float64Array(modelCount);

  for (let model = 0; model < modelCount; model += 1) {
    const alpha = modelAlpha[model]!;
    const omega = modelOmega[model]!;
    let modelMu = 0;
    for (let state = 0; state < stateCount; state += 1) {
      let exitRate = 0;
      const neighbors = count[state]!;
      for (let neighbor = 0; neighbor < neighbors; neighbor += 1) {
        const topologyOffset = state * maxNeighbors + neighbor;
        const from = fromNucleotide[topologyOffset]!;
        const to = toNucleotide[topologyOffset]!;
        const rateIndex = GTR_PAIR_INDEX[from * 4 + to]!;
        const selectionRate = synonymous[topologyOffset] === 1 ? alpha : alpha * omega;
        const q = selectionRate * gtrRates[rateIndex]! * f3x4[position[topologyOffset]! * 4 + to]!;
        rOffDiagonal[model * stateCount * maxNeighbors + topologyOffset] = q;
        exitRate += q;
      }
      rDiagonal[model * stateCount + state] = -exitRate;
      modelMu = Math.max(modelMu, exitRate);
    }
    if (!(modelMu > 0) || !Number.isFinite(modelMu)) {
      throw new DifFUBARError("INVALID_MODEL", `MG94 model ${model} has invalid uniformization rate ${modelMu}.`);
    }
    mu[model] = modelMu;
    for (let state = 0; state < stateCount; state += 1) {
      rDiagonal[model * stateCount + state] = 1 + rDiagonal[model * stateCount + state]! / modelMu;
      for (let neighbor = 0; neighbor < count[state]!; neighbor += 1) {
        const offset = model * stateCount * maxNeighbors + state * maxNeighbors + neighbor;
        rOffDiagonal[offset] = rOffDiagonal[offset]! / modelMu;
      }
    }
  }

  return {
    stateCount,
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

import type { FsartAlignment, TripletState } from "./types.js";

const BASE_CODE = new Uint8Array(128).fill(255);
BASE_CODE[65] = BASE_CODE[97] = 0;
BASE_CODE[67] = BASE_CODE[99] = 1;
BASE_CODE[71] = BASE_CODE[103] = 2;
BASE_CODE[84] = BASE_CODE[116] = 3;
BASE_CODE[85] = BASE_CODE[117] = 3;

// Replicated workers make an unbounded O(taxa^2 * sites) pair cache a poor
// trade on very large alignments. Eight MiB keeps the common case extremely
// fast while forcing large jobs onto the still-vectorized base-plane path.
const MAX_PAIR_EQUALITY_BYTES = 8 * 1024 * 1024;

export function pairRank(first: number, second: number, taxa: number): number {
  if (!(first >= 0 && first < second && second < taxa)) throw new RangeError("Taxon-pair indices are out of range.");
  return (first * (2 * taxa - first - 1)) / 2 + second - first - 1;
}

export function parseFsartFasta(text: string): FsartAlignment {
  const names: string[] = [];
  const sequences: string[] = [];
  let name: string | undefined;
  let sequence = "";
  const commit = (): void => {
    if (name === undefined) return;
    if (sequence.length === 0) throw new Error(`Sequence '${name}' is empty.`);
    names.push(name);
    sequences.push(sequence.toUpperCase().replaceAll(/\s/g, ""));
  };
  for (const raw of text.replaceAll("\r", "").split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith(";")) continue;
    if (line.startsWith(">")) {
      commit();
      name = line.slice(1).trim().split(/\s+/, 1)[0];
      if (!name) throw new Error("A FASTA header has no identifier.");
      sequence = "";
    } else {
      if (name === undefined) throw new Error("FASTA sequence data appears before the first header.");
      sequence += line;
    }
  }
  commit();
  if (names.length < 3) throw new Error("FSART requires at least three aligned sequences.");
  if (new Set(names).size !== names.length) throw new Error("FASTA identifiers must be unique.");
  const sites = sequences[0]!.length;
  if (sites < 4) throw new Error("FSART requires an alignment at least four nucleotides long.");
  for (let index = 1; index < sequences.length; index += 1) {
    if (sequences[index]!.length !== sites) throw new Error("All FASTA sequences must have the same aligned length.");
  }

  const taxa = names.length;
  const matrix = new Uint8Array(sites * taxa);
  const bitsetWords = Math.ceil(sites / 32);
  const baseMasks = new Uint32Array(taxa * 4 * bitsetWords);
  const canonicalMasks = new Uint32Array(taxa * bitsetWords);
  const variable: number[] = [];
  for (let site = 0; site < sites; site += 1) {
    let mask = 0;
    for (let taxon = 0; taxon < taxa; taxon += 1) {
      const codePoint = sequences[taxon]!.charCodeAt(site);
      const code = codePoint < BASE_CODE.length ? BASE_CODE[codePoint]! : 255;
      matrix[site * taxa + taxon] = code;
      if (code < 4) {
        mask |= 1 << code;
        const word = site >>> 5;
        const bit = 1 << (site & 31);
        const baseIndex = (taxon * 4 + code) * bitsetWords + word;
        const canonicalIndex = taxon * bitsetWords + word;
        baseMasks[baseIndex] = (baseMasks[baseIndex]! | bit) >>> 0;
        canonicalMasks[canonicalIndex] = (canonicalMasks[canonicalIndex]! | bit) >>> 0;
      }
    }
    if ((mask & (mask - 1)) !== 0) variable.push(site);
  }
  if (variable.length === 0) throw new Error("The alignment has no variable canonical nucleotide sites.");
  const pairCount = taxa * (taxa - 1) / 2;
  const pairBytes = pairCount * bitsetWords * Uint32Array.BYTES_PER_ELEMENT;
  let pairEqualMasks: Uint32Array | undefined;
  if (pairBytes <= MAX_PAIR_EQUALITY_BYTES) {
    pairEqualMasks = new Uint32Array(pairCount * bitsetWords);
    for (let first = 0; first < taxa - 1; first += 1) {
      for (let second = first + 1; second < taxa; second += 1) {
        const pairOffset = pairRank(first, second, taxa) * bitsetWords;
        for (let word = 0; word < bitsetWords; word += 1) {
          let equal = 0;
          for (let base = 0; base < 4; base += 1) {
            equal |= baseMasks[(first * 4 + base) * bitsetWords + word]!
              & baseMasks[(second * 4 + base) * bitsetWords + word]!;
          }
          pairEqualMasks[pairOffset + word] = equal >>> 0;
        }
      }
    }
  }
  return {
    names,
    sequences,
    taxa,
    sites,
    matrix,
    variableSites: Uint32Array.from(variable),
    baseMasks,
    canonicalMasks,
    ...(pairEqualMasks === undefined ? {} : { pairEqualMasks }),
    bitsetWords,
  };
}

export function combinationCount3(n: number): number {
  return n < 3 ? 0 : (n * (n - 1) * (n - 2)) / 6;
}

export function combinationRank3(first: number, second: number, third: number, n: number): number {
  if (!(first >= 0 && first < second && second < third && third < n)) {
    throw new RangeError("Taxon-triplet indices are out of range.");
  }
  let rank = combinationCount3(n) - combinationCount3(n - first);
  for (let middle = first + 1; middle < second; middle += 1) rank += n - middle - 1;
  return rank + third - second - 1;
}

export interface TripletSamplingPlan {
  readonly totalTriplets: number;
  /** Undefined means scan the full contiguous lexicographic range without allocating ranks. */
  readonly ranks?: Float64Array;
  readonly scannedTriplets: number;
  readonly exhaustive: boolean;
  readonly pairCoverageGuaranteed: boolean;
}

function deterministicThird(first: number, second: number, taxa: number): number {
  // Mix the pair before mapping onto the n-2 admissible third taxa. This avoids
  // repeatedly anchoring the cover on the same low-index sequence.
  const mixed = (Math.imul(first + 1, 0x9e3779b1) ^ Math.imul(second + 1, 0x85ebca77)) >>> 0;
  let third = mixed % (taxa - 2);
  if (third >= first) third += 1;
  if (third >= second) third += 1;
  return third;
}

/**
 * Construct a deterministic scan whose first layer covers every taxon pair.
 * If the requested budget is larger, an alignment-wide systematic sample of
 * lexicographic triplets fills the remainder. The pair cover takes precedence
 * over the budget: a user cannot accidentally omit a pair by choosing a small
 * supplemental budget.
 */
export function planPairCoveredTriplets(taxa: number, maximumTriplets = 250_000): TripletSamplingPlan {
  const totalTriplets = combinationCount3(taxa);
  const requested = Math.max(1, Math.min(totalTriplets, Math.floor(maximumTriplets)));
  if (totalTriplets <= requested) {
    return { totalTriplets, scannedTriplets: totalTriplets, exhaustive: true, pairCoverageGuaranteed: true };
  }
  const ranks = new Set<number>();
  for (let first = 0; first < taxa - 1; first += 1) {
    for (let second = first + 1; second < taxa; second += 1) {
      const third = deterministicThird(first, second, taxa);
      const ordered = [first, second, third].sort((a, b) => a - b);
      ranks.add(combinationRank3(ordered[0]!, ordered[1]!, ordered[2]!, taxa));
    }
  }
  const target = Math.min(totalTriplets, Math.max(requested, ranks.size));
  // A systematic grid gives much better alignment-wide coverage than taking a
  // prefix of lexicographic triplets. A coprime stride fills rare collisions.
  for (let index = 0; index < target && ranks.size < target; index += 1) {
    ranks.add(Math.min(totalTriplets - 1, Math.floor((index + 0.5) * totalTriplets / target)));
  }
  let cursor = 0;
  while (ranks.size < target) {
    ranks.add(cursor);
    cursor += 1;
  }
  return {
    totalTriplets,
    ranks: Float64Array.from(Array.from(ranks).sort((a, b) => a - b)),
    scannedTriplets: ranks.size,
    exhaustive: ranks.size === totalTriplets,
    pairCoverageGuaranteed: true,
  };
}

export function unrankCombination3(rank: number, n: number): [number, number, number] {
  const total = combinationCount3(n);
  if (!Number.isSafeInteger(rank) || rank < 0 || rank >= total) throw new RangeError(`Triplet rank ${rank} is outside [0, ${total}).`);
  let remainder = rank;
  let first = 0;
  while (first < n - 2) {
    const block = ((n - first - 1) * (n - first - 2)) / 2;
    if (remainder < block) break;
    remainder -= block;
    first += 1;
  }
  let second = first + 1;
  while (second < n - 1) {
    const block = n - second - 1;
    if (remainder < block) break;
    remainder -= block;
    second += 1;
  }
  return [first, second, second + 1 + remainder];
}

export function nextCombination3(value: [number, number, number], n: number): boolean {
  if (value[2] + 1 < n) {
    value[2] += 1;
    return true;
  }
  if (value[1] + 2 < n) {
    value[1] += 1;
    value[2] = value[1] + 1;
    return true;
  }
  if (value[0] + 3 < n) {
    value[0] += 1;
    value[1] = value[0] + 1;
    value[2] = value[1] + 1;
    return true;
  }
  return false;
}

/** Classify which pair matches, or -1 unless exactly two canonical states occur. */
export function informativeState(a: number, b: number, c: number): TripletState | -1 {
  if (a > 3 || b > 3 || c > 3) return -1;
  if (a === b && b !== c) return 0;
  if (a === c && a !== b) return 1;
  if (b === c && a !== b) return 2;
  return -1;
}

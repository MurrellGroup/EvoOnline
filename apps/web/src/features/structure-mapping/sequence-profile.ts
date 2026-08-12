import type { AminoAcidProfile, AminoAcidProfileColumn } from "./types.js";
import {
  translateCodon as translateCodonForCode,
  type GeneticCodeInput,
} from "@phylo-workbench/model-diffubar/browser-source";

export const AMINO_ACIDS = "ARNDCQEGHILKMFPSTWYV";

const AMINO_ACID_INDEX = new Map(Array.from(AMINO_ACIDS, (aminoAcid, index) => [aminoAcid, index]));

export function translateCodon(codon: string, geneticCode: GeneticCodeInput = 1): string | undefined {
  return translateCodonForCode(codon, geneticCode);
}

function parseAlignedFasta(text: string): readonly string[] {
  const sequences: string[] = [];
  let chunks: string[] | undefined;
  for (const rawLine of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith(";")) continue;
    if (line.startsWith(">")) {
      if (chunks !== undefined) sequences.push(chunks.join("").toUpperCase().replaceAll("U", "T"));
      chunks = [];
    } else {
      if (chunks === undefined) throw new Error("Sequence data appears before the first FASTA header.");
      chunks.push(line.replaceAll(/\s+/g, ""));
    }
  }
  if (chunks !== undefined) sequences.push(chunks.join("").toUpperCase().replaceAll("U", "T"));
  if (sequences.length === 0) throw new Error("The alignment contains no FASTA records.");
  const length = sequences[0]!.length;
  if (length === 0 || length % 3 !== 0) throw new Error("The alignment must contain complete codons.");
  if (sequences.some((sequence) => sequence.length !== length)) throw new Error("The FASTA sequences are not aligned to equal lengths.");
  return sequences;
}

export function buildAminoAcidProfile(alignmentText: string, geneticCode: GeneticCodeInput = 1): AminoAcidProfile {
  const sequences = parseAlignedFasta(alignmentText);
  const columns: AminoAcidProfileColumn[] = [];
  for (let offset = 0; offset < sequences[0]!.length; offset += 3) {
    const counts = new Uint32Array(AMINO_ACIDS.length);
    let validCount = 0;
    for (const sequence of sequences) {
      const aminoAcid = translateCodon(sequence.slice(offset, offset + 3), geneticCode);
      const index = aminoAcid === undefined || aminoAcid === "*" ? undefined : AMINO_ACID_INDEX.get(aminoAcid);
      if (index === undefined) continue;
      counts[index] = counts[index]! + 1;
      validCount += 1;
    }
    const frequencies = new Float32Array(AMINO_ACIDS.length);
    let consensus = "X";
    let largest = 0;
    if (validCount > 0) {
      for (let index = 0; index < counts.length; index += 1) {
        frequencies[index] = counts[index]! / validCount;
        if (counts[index]! > largest) {
          largest = counts[index]!;
          consensus = AMINO_ACIDS[index]!;
        }
      }
    }
    columns.push({
      site: offset / 3 + 1,
      frequencies,
      consensus,
      validCount,
      missingCount: sequences.length - validCount,
    });
  }
  if (columns.every((column) => column.validCount === 0)) throw new Error("No unambiguous sense codons could be translated from the alignment.");
  return { columns, sequenceCount: sequences.length };
}

import type { AminoAcidProfile, AminoAcidProfileColumn } from "./types.js";

export const AMINO_ACIDS = "ARNDCQEGHILKMFPSTWYV";

const AMINO_ACID_INDEX = new Map(Array.from(AMINO_ACIDS, (aminoAcid, index) => [aminoAcid, index]));

const UNIVERSAL_CODE: Readonly<Record<string, string>> = Object.freeze({
  TTT: "F", TTC: "F", TTA: "L", TTG: "L", TCT: "S", TCC: "S", TCA: "S", TCG: "S",
  TAT: "Y", TAC: "Y", TAA: "*", TAG: "*", TGT: "C", TGC: "C", TGA: "*", TGG: "W",
  CTT: "L", CTC: "L", CTA: "L", CTG: "L", CCT: "P", CCC: "P", CCA: "P", CCG: "P",
  CAT: "H", CAC: "H", CAA: "Q", CAG: "Q", CGT: "R", CGC: "R", CGA: "R", CGG: "R",
  ATT: "I", ATC: "I", ATA: "I", ATG: "M", ACT: "T", ACC: "T", ACA: "T", ACG: "T",
  AAT: "N", AAC: "N", AAA: "K", AAG: "K", AGT: "S", AGC: "S", AGA: "R", AGG: "R",
  GTT: "V", GTC: "V", GTA: "V", GTG: "V", GCT: "A", GCC: "A", GCA: "A", GCG: "A",
  GAT: "D", GAC: "D", GAA: "E", GAG: "E", GGT: "G", GGC: "G", GGA: "G", GGG: "G",
});

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

export function buildAminoAcidProfile(alignmentText: string): AminoAcidProfile {
  const sequences = parseAlignedFasta(alignmentText);
  const columns: AminoAcidProfileColumn[] = [];
  for (let offset = 0; offset < sequences[0]!.length; offset += 3) {
    const counts = new Uint32Array(AMINO_ACIDS.length);
    let validCount = 0;
    for (const sequence of sequences) {
      const aminoAcid = UNIVERSAL_CODE[sequence.slice(offset, offset + 3)];
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

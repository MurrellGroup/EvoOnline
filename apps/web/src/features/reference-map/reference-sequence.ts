import { translateCodon } from "../structure-mapping/sequence-profile.js";
import type { ParsedReferenceSequence, ReferenceSequenceKind } from "./types.js";

const NUCLEOTIDE_ALPHABET = /^[ACGTUNRYKMSWBDHV.-]+$/i;
const PROTEIN_ALPHABET = /^[A-Z*.-]+$/i;
const NUCLEOTIDE_FILENAME = /\.(?:fna|ffn|frn|dna|nt)(?:\.txt)?$/i;

interface FastaRecord {
  readonly name: string;
  readonly sequence: string;
}

function parseSingleRecord(text: string, fallbackName: string): FastaRecord {
  const normalized = text.replace(/^\uFEFF/, "").trim();
  if (normalized === "") throw new Error("The reference file is empty.");
  if (!normalized.includes(">")) return { name: fallbackName, sequence: normalized.replace(/\s+/g, "") };
  const records: Array<{ name: string; chunks: string[] }> = [];
  let active: { name: string; chunks: string[] } | undefined;
  for (const rawLine of normalized.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith(";")) continue;
    if (line.startsWith(">")) {
      active = { name: line.slice(1).trim() || fallbackName, chunks: [] };
      records.push(active);
    } else {
      if (active === undefined) throw new Error("Reference sequence data appears before its FASTA header.");
      active.chunks.push(line.replace(/\s+/g, ""));
    }
  }
  if (records.length !== 1) throw new Error(`Upload exactly one reference sequence; this file contains ${records.length}.`);
  return { name: records[0]!.name, sequence: records[0]!.chunks.join("") };
}

function proteinSequence(rawSequence: string): string {
  if (!PROTEIN_ALPHABET.test(rawSequence)) throw new Error("The protein reference contains unsupported characters.");
  const ungapped = rawSequence.toUpperCase().replace(/[.-]/g, "").replace(/\*$/, "");
  if (ungapped === "") throw new Error("The protein reference contains no residues after gaps are removed.");
  return ungapped.replaceAll("*", "X").replace(/[^ARNDCQEGHILKMFPSTWYVX]/g, "X");
}

function nucleotideSequence(rawSequence: string): string {
  if (!NUCLEOTIDE_ALPHABET.test(rawSequence)) throw new Error("The coding-nucleotide reference contains unsupported characters.");
  const ungapped = rawSequence.toUpperCase().replaceAll("U", "T").replace(/[.-]/g, "");
  if (ungapped.length === 0 || ungapped.length % 3 !== 0) throw new Error("A coding-nucleotide reference must contain complete codons after gaps are removed.");
  let translated = "";
  for (let offset = 0; offset < ungapped.length; offset += 3) {
    const aminoAcid = translateCodon(ungapped.slice(offset, offset + 3));
    translated += aminoAcid === undefined || aminoAcid === "*" ? "X" : aminoAcid;
  }
  return translated.endsWith("X") && translateCodon(ungapped.slice(-3)) === "*" ? translated.slice(0, -1) : translated;
}

export function parseReferenceSequence(
  text: string,
  fallbackName: string,
  requestedKind: ReferenceSequenceKind = "auto",
): ParsedReferenceSequence {
  const record = parseSingleRecord(text, fallbackName);
  const compact = record.sequence.replace(/\s+/g, "");
  const kind = requestedKind === "auto"
    ? NUCLEOTIDE_FILENAME.test(fallbackName) || (NUCLEOTIDE_ALPHABET.test(compact) && compact.replace(/[.-]/g, "").length % 3 === 0)
      ? "nucleotide"
      : "protein"
    : requestedKind;
  const sequence = kind === "nucleotide" ? nucleotideSequence(compact) : proteinSequence(compact);
  if (sequence === "") throw new Error("The translated reference contains no amino-acid residues.");
  return { name: record.name, sequence, kind, sourceLength: compact.replace(/[.-]/g, "").length };
}

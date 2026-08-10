import { DifFUBARError, type FastaAlignment } from "../types.js";

export function parseFasta(text: string): FastaAlignment {
  const names: string[] = [];
  const sequences: string[] = [];
  const seen = new Set<string>();
  let currentName: string | null = null;
  let chunks: string[] = [];

  const flush = (): void => {
    if (currentName === null) return;
    const sequence = chunks.join("").replaceAll(/\s+/g, "").toUpperCase().replaceAll("U", "T");
    if (sequence.length === 0) throw new DifFUBARError("EMPTY_SEQUENCE", `Sequence '${currentName}' is empty.`);
    names.push(currentName);
    sequences.push(sequence);
    chunks = [];
  };

  for (const rawLine of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith(";")) continue;
    if (line.startsWith(">")) {
      flush();
      const header = line.slice(1).trim();
      const name = header.split(/\s+/, 1)[0] ?? "";
      if (name.length === 0) throw new DifFUBARError("EMPTY_FASTA_NAME", "A FASTA record has an empty identifier.");
      if (seen.has(name)) throw new DifFUBARError("DUPLICATE_FASTA_NAME", `Duplicate FASTA identifier '${name}'.`);
      seen.add(name);
      currentName = name;
    } else {
      if (currentName === null) throw new DifFUBARError("INVALID_FASTA", "Sequence data appears before the first FASTA header.");
      chunks.push(line);
    }
  }
  flush();

  if (names.length < 2) throw new DifFUBARError("TOO_FEW_SEQUENCES", "difFUBAR requires at least two sequences.");
  const nucleotideSites = sequences[0]!.length;
  if (nucleotideSites % 3 !== 0) {
    throw new DifFUBARError("FRAME_ERROR", `Alignment length ${nucleotideSites} is not divisible by three.`);
  }
  for (let i = 1; i < sequences.length; i += 1) {
    if (sequences[i]!.length !== nucleotideSites) {
      throw new DifFUBARError(
        "UNALIGNED_FASTA",
        `Sequence '${names[i]}' has length ${sequences[i]!.length}; expected ${nucleotideSites}.`,
      );
    }
  }
  return { names, sequences, nucleotideSites, codonSites: nucleotideSites / 3 };
}

export function writeFasta(alignment: FastaAlignment, lineWidth = 80): string {
  const records: string[] = [];
  for (let i = 0; i < alignment.names.length; i += 1) {
    const sequence = alignment.sequences[i]!;
    const lines: string[] = [];
    for (let offset = 0; offset < sequence.length; offset += lineWidth) lines.push(sequence.slice(offset, offset + lineWidth));
    records.push(`>${alignment.names[i]}\n${lines.join("\n")}`);
  }
  return `${records.join("\n")}\n`;
}

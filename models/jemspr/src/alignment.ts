import type { JemsprAlignment } from "./types.js";

const IUPAC: Readonly<Record<string, number>> = {
  A: 1, C: 2, G: 4, T: 8, U: 8,
  R: 5, Y: 10, S: 6, W: 9, K: 12, M: 3,
  B: 14, D: 13, H: 11, V: 7, N: 15,
  "-": 0, ".": 0, "?": 0,
};

export function parseJemsprFasta(text: string): JemsprAlignment {
  const names: string[] = [];
  const sequences: string[] = [];
  let name: string | undefined;
  let chunks: string[] = [];
  const flush = (): void => {
    if (name === undefined) return;
    const sequence = chunks.join("").replaceAll(/\s+/g, "").toUpperCase();
    if (sequence.length === 0) throw new Error(`Sequence '${name}' is empty.`);
    names.push(name);
    sequences.push(sequence);
    chunks = [];
  };
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith(";")) continue;
    if (line.startsWith(">")) {
      flush();
      name = line.slice(1).trim().split(/\s+/, 1)[0] ?? "";
      if (name.length === 0) throw new Error("A FASTA record has an empty identifier.");
    } else {
      if (name === undefined) throw new Error("Sequence data appears before the first FASTA header.");
      chunks.push(line);
    }
  }
  flush();
  if (names.length < 4) throw new Error("JEMSPR requires at least four aligned nucleotide sequences.");
  if (new Set(names).size !== names.length) throw new Error("FASTA identifiers must be unique.");
  const sites = sequences[0]?.length ?? 0;
  if (!sequences.every((sequence) => sequence.length === sites)) throw new Error("All sequences must have the same aligned length.");
  if (sites < 4) throw new Error("The alignment is too short for recombination inference.");

  const masks = new Uint8Array(sites * names.length);
  const informative: number[] = [];
  for (let site = 0; site < sites; site += 1) {
    let intersection = 15;
    let observed = 0;
    for (let taxon = 0; taxon < names.length; taxon += 1) {
      const symbol = sequences[taxon]![site]!;
      const mask = IUPAC[symbol];
      if (mask === undefined) throw new Error(`Unsupported nucleotide symbol '${symbol}' in '${names[taxon]}', site ${site + 1}.`);
      masks[site * names.length + taxon] = mask;
      if (mask !== 0) {
        intersection &= mask;
        observed += 1;
      }
    }
    // A zero-cost assignment exists iff every nonmissing mask shares at least
    // one state. Only sites whose exact ambiguity intersection is empty can
    // distinguish tree scores; omitted cells therefore contribute the same
    // zero emission under every candidate topology.
    if (observed >= 2 && intersection === 0) informative.push(site);
  }

  // The genomic dynamic programs are intentionally site-level. Parsimony is
  // still evaluated only at the variable positions above (all other emission
  // costs are exactly zero), but retaining one scoring cell per alignment
  // column prevents duration penalties from pinning a breakpoint to an
  // arbitrary midpoint inside an invariant run.
  const cellStarts = Uint32Array.from({ length: sites }, (_value, index) => index);
  const cellEnds = Uint32Array.from({ length: sites }, (_value, index) => index + 1);
  return {
    names,
    taxa: names.length,
    sites,
    masks,
    informativePositions: Uint32Array.from(informative),
    cellStarts,
    cellEnds,
  };
}

export function siteMask(alignment: JemsprAlignment, site: number, taxon: number): number {
  return alignment.masks[site * alignment.taxa + taxon] ?? 0;
}

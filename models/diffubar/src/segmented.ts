import { DifFUBARError, type FastaAlignment, type ParsedTree } from "./types.js";
import { parseNewick } from "./io/newick.js";

export interface CodonTreeSegmentInput {
  /** Inclusive, one-based codon coordinate in the original alignment. */
  readonly startCodon: number;
  /** Inclusive, one-based codon coordinate in the original alignment. */
  readonly endCodon: number;
  /** Length-bearing Newick for this region. */
  readonly tree: string;
  readonly label?: string;
  readonly sourceNucleotideStart?: number;
  readonly sourceNucleotideEnd?: number;
  readonly mask?: number;
}

export interface RecombinationCodonTreeSet {
  readonly schemaVersion: 1;
  /** Provenance only: downstream likelihood code is deliberately detector-agnostic. */
  readonly sourceMethod: string;
  /** JEMSPR handoffs are accepted only from the coherent linked-ML polishing stage. */
  readonly branchLengthSource: "jemspr-linked-ml" | "segment-ml" | "method-final-trees";
  /** Forbids downstream segment-specific branch-length multipliers. */
  readonly branchScalePolicy: "fixed-relative";
  readonly codonAssignment: "middle-nucleotide";
  readonly segments: readonly CodonTreeSegmentInput[];
  readonly sourceAnalysisId?: string;
}

export interface PreparedCodonTreeSegment {
  readonly startCodon: number;
  readonly endCodon: number;
  readonly siteOffset: number;
  readonly alignment: FastaAlignment;
  readonly tree: ParsedTree;
  readonly input: CodonTreeSegmentInput;
}

export function sliceCodonAlignment(alignment: FastaAlignment, startCodon: number, endCodon: number): FastaAlignment {
  const start = (startCodon - 1) * 3;
  const end = endCodon * 3;
  const sequences = alignment.sequences.map((sequence) => sequence.slice(start, end));
  return {
    names: alignment.names,
    sequences,
    nucleotideSites: end - start,
    codonSites: endCodon - startCodon + 1,
  };
}

function sameTaxa(alignment: FastaAlignment, tree: ParsedTree): boolean {
  const expected = [...alignment.names].sort();
  const observed = tree.tips.map((tip) => tip.name).sort();
  return expected.length === observed.length && expected.every((name, index) => name === observed[index]);
}

/** Validate and materialize a gap-free partition without altering any input tree length. */
export function prepareRecombinationCodonTrees(
  alignment: FastaAlignment,
  treeSet: RecombinationCodonTreeSet,
): readonly PreparedCodonTreeSegment[] {
  if (treeSet.schemaVersion !== 1 || treeSet.branchScalePolicy !== "fixed-relative") {
    throw new DifFUBARError("INVALID_RECOMBINATION_TREE_SET", "Recombination trees must use the fixed-relative version-1 contract.");
  }
  if (treeSet.sourceMethod === "jemspr" && treeSet.branchLengthSource !== "jemspr-linked-ml") {
    throw new DifFUBARError("UNPOLISHED_JEMSPR_TREES", "JEMSPR codon analyses require linked-ML polished regional trees.");
  }
  if (treeSet.codonAssignment !== "middle-nucleotide") {
    throw new DifFUBARError("INVALID_CODON_ASSIGNMENT", "Recombination regions must assign breakpoint-crossing codons by their middle nucleotide.");
  }
  const ordered = [...treeSet.segments].sort((left, right) => left.startCodon - right.startCodon || left.endCodon - right.endCodon);
  if (ordered.length === 0) throw new DifFUBARError("EMPTY_RECOMBINATION_TREE_SET", "The recombination tree set has no codon regions.");
  let expectedStart = 1;
  const prepared: PreparedCodonTreeSegment[] = [];
  for (const input of ordered) {
    if (!Number.isInteger(input.startCodon) || !Number.isInteger(input.endCodon) || input.startCodon !== expectedStart || input.endCodon < input.startCodon || input.endCodon > alignment.codonSites) {
      throw new DifFUBARError("INVALID_RECOMBINATION_PARTITION", `Expected a region beginning at codon ${expectedStart}, but received ${input.startCodon}–${input.endCodon}.`);
    }
    const tree = parseNewick(input.tree);
    if (!sameTaxa(alignment, tree)) throw new DifFUBARError("TREE_ALIGNMENT_MISMATCH", `Recombination region ${input.startCodon}–${input.endCodon} does not contain exactly the alignment taxa.`);
    prepared.push({
      startCodon: input.startCodon,
      endCodon: input.endCodon,
      siteOffset: input.startCodon - 1,
      alignment: sliceCodonAlignment(alignment, input.startCodon, input.endCodon),
      tree,
      input,
    });
    expectedStart = input.endCodon + 1;
  }
  if (expectedStart !== alignment.codonSites + 1) {
    throw new DifFUBARError("INCOMPLETE_RECOMBINATION_PARTITION", `The final recombination region ends at codon ${expectedStart - 1}; the alignment contains ${alignment.codonSites}.`);
  }
  return prepared;
}

/** Copy a local category-major block into its original-alignment codon columns. */
export function insertSegmentConditionals(
  target: Float64Array,
  local: Float64Array,
  categoryCount: number,
  totalSites: number,
  segment: Pick<PreparedCodonTreeSegment, "siteOffset" | "alignment">,
): void {
  const localSites = segment.alignment.codonSites;
  if (local.length !== categoryCount * localSites || target.length !== categoryCount * totalSites) {
    throw new RangeError("Segmented conditional-likelihood dimensions do not agree.");
  }
  for (let category = 0; category < categoryCount; category += 1) {
    target.set(
      local.subarray(category * localSites, (category + 1) * localSites),
      category * totalSites + segment.siteOffset,
    );
  }
}

/** A common scale is legal; a per-segment scale is intentionally not exposed. */
export function applySharedTreeScale(segments: readonly PreparedCodonTreeSegment[], scale: number): void {
  if (!(scale > 0) || !Number.isFinite(scale)) throw new RangeError("The shared tree scale must be finite and positive.");
  for (const segment of segments) for (const node of segment.tree.nodes) node.branchLength *= scale;
}

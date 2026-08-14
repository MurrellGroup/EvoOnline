import type { RecombinationCodonTreeSet } from "@phylo-workbench/model-diffubar/browser-source";
import type { JemsprAnalysisResult } from "@phylo-workbench/model-jemspr/browser-source";
import type { FsartAnalysisResult } from "@phylo-workbench/model-fsart/browser-source";
import type { MosaicSprAnalysisResult } from "@phylo-workbench/model-mosaicspr/browser-source";

export interface NucleotideTreeRun {
  readonly start: number;
  readonly end: number;
  readonly tree: string;
  readonly label?: string;
  readonly mask?: number;
}

/**
 * Generic adapter shared by every recombination method, including future
 * detectors. Detector-specific functions below do nothing except select the
 * final nucleotide runs and record their branch-length provenance.
 */
export function createRecombinationCodonTreeSet(
  sourceMethod: string,
  branchLengthSource: RecombinationCodonTreeSet["branchLengthSource"],
  runsInput: readonly NucleotideTreeRun[],
  nucleotideSites: number,
  sourceAnalysisId?: string,
): RecombinationCodonTreeSet {
  if (!Number.isInteger(nucleotideSites) || nucleotideSites <= 0 || nucleotideSites % 3 !== 0) {
    throw new Error("The recombination alignment must be codon-aligned (a positive nucleotide length divisible by three).");
  }
  if (sourceMethod === "jemspr" && branchLengthSource !== "jemspr-linked-ml") throw new Error("JEMSPR handoffs require linked-ML polished trees.");
  if (runsInput.length === 0) throw new Error("The recombination result contains no regional trees.");
  const runs = [...runsInput].sort((left, right) => left.start - right.start);
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index]!;
    if (!Number.isInteger(run.start) || !Number.isInteger(run.end) || run.start < 1 || run.end < run.start || !run.tree.includes("(")) throw new Error(`Regional tree ${index + 1} has invalid coordinates or Newick.`);
    if (index === 0 && run.start !== 1) throw new Error(`The first regional tree starts at nucleotide ${run.start}, not 1.`);
    if (index > 0 && run.start !== runs[index - 1]!.end + 1) throw new Error(`Regional trees ${index} and ${index + 1} overlap or leave a nucleotide gap.`);
  }
  if (runs.at(-1)!.end !== nucleotideSites) throw new Error(`The final regional tree ends at nucleotide ${runs.at(-1)!.end}, not ${nucleotideSites}.`);
  const codonCount = nucleotideSites / 3;
  const segments: Array<RecombinationCodonTreeSet["segments"][number]> = [];
  let activeRun = 0;
  for (let codon = 1; codon <= codonCount; codon += 1) {
    const middleNucleotide = 3 * codon - 1;
    while (activeRun + 1 < runs.length && runs[activeRun]!.end < middleNucleotide) activeRun += 1;
    const run = runs[activeRun]!;
    if (middleNucleotide < run.start || middleNucleotide > run.end) throw new Error(`No final regional tree covers codon ${codon} (middle nucleotide ${middleNucleotide}).`);
    const previous = segments[segments.length - 1];
    if (previous !== undefined && previous.mask === run.mask && previous.tree === run.tree && previous.endCodon === codon - 1) {
      segments[segments.length - 1] = { ...previous, endCodon: codon, sourceNucleotideEnd: run.end };
    } else {
      segments.push({ startCodon: codon, endCodon: codon, tree: run.tree, ...(run.label === undefined ? {} : { label: run.label }), sourceNucleotideStart: run.start, sourceNucleotideEnd: run.end, ...(run.mask === undefined ? {} : { mask: run.mask }) });
    }
  }
  return { schemaVersion: 1, sourceMethod, branchLengthSource, branchScalePolicy: "fixed-relative", codonAssignment: "middle-nucleotide", segments, ...(sourceAnalysisId === undefined ? {} : { sourceAnalysisId }) };
}

/**
 * Convert the linked-ML nucleotide path to a complete codon partition.
 * A codon crossing a breakpoint follows the tree at its middle nucleotide;
 * this is deterministic and never duplicates or drops a codon.
 */
export function createJemsprCodonTreeSet(
  result: JemsprAnalysisResult,
  nucleotideSites: number,
  sourceAnalysisId?: string,
): RecombinationCodonTreeSet {
  if (result.likelihood.status !== "complete") throw new Error("JEMSPR must finish linked branch-length ML before its trees can be used for codon analysis.");
  return createRecombinationCodonTreeSet("jemspr", "jemspr-linked-ml", result.likelihood.runs.map((run) => ({ ...run, label: `JEMSPR ML region ${run.start}–${run.end}` })), nucleotideSites, sourceAnalysisId);
}

export function createFsartCodonTreeSet(result: FsartAnalysisResult, nucleotideSites: number, sourceAnalysisId?: string): RecombinationCodonTreeSet {
  if (result.treeHmm.status === "complete" && result.treeHmm.viterbi !== undefined) {
    const states = result.treeHmm.states;
    return createRecombinationCodonTreeSet("fsart", "segment-ml", result.treeHmm.viterbi.runs.map((run) => ({ start: run.start, end: run.end, tree: states[run.state]?.tree ?? "", label: `FSART final Viterbi region ${run.start}–${run.end}` })), nucleotideSites, sourceAnalysisId);
  }
  if (result.partition.status === "complete" && result.partition.segments.length > 0) {
    return createRecombinationCodonTreeSet("fsart", "segment-ml", result.partition.segments.map((segment) => ({ start: segment.start, end: segment.end, tree: segment.tree, label: `FSART stepwise region ${segment.start}–${segment.end}` })), nucleotideSites, sourceAnalysisId);
  }
  throw new Error("FSART must finish either its tree-HMM/Viterbi reconstruction or its stepwise segment fit before handoff.");
}

export function createMosaicSprCodonTreeSet(result: MosaicSprAnalysisResult, nucleotideSites: number, sourceAnalysisId?: string): RecombinationCodonTreeSet {
  if (result.reconstruction.status !== "complete") throw new Error("MosaicSPR must finish its reconstruction before handoff.");
  const states = new Map(result.reconstruction.states.map((state) => [state.id, state.tree]));
  return createRecombinationCodonTreeSet("mosaicspr", "method-final-trees", result.reconstruction.runs.map((run) => ({ start: run.start, end: run.end, tree: states.get(run.stateId) ?? "", label: `MosaicSPR final region ${run.start}–${run.end}` })), nucleotideSites, sourceAnalysisId);
}

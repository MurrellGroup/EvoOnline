import type { RecombinationCodonTreeSet } from "@phylo-workbench/model-diffubar";
import type { FsartAnalysisResult } from "@phylo-workbench/model-fsart";
import type { JemsprAnalysisResult } from "@phylo-workbench/model-jemspr";
import type { MosaicSprAnalysisResult } from "@phylo-workbench/model-mosaicspr";
import type { SimulatedDataset } from "@phylo-workbench/model-simulator";

export interface NucleotideTreeRun {
  readonly start: number;
  readonly end: number;
  readonly tree: string;
  readonly label?: string;
  readonly mask?: number;
}

export interface RecombinationBundle {
  readonly format: "evoonline-recombination-tree-bundle";
  readonly schemaVersion: 1;
  readonly representation: "independent-regional-trees" | "spr-history";
  readonly sourceMethod: string;
  readonly alignment: {
    readonly nucleotideSites: number;
    readonly codonSites: number;
    readonly taxa?: number;
    readonly coordinates: "one-based-inclusive";
    readonly breakpointConvention: "after-site";
  };
  readonly downstreamLikelihood: {
    readonly codonAssignment: "middle-nucleotide";
    readonly branchScalePolicy: "fixed-relative";
    readonly branchLengthSource: RecombinationCodonTreeSet["branchLengthSource"];
  };
  readonly codonTreeSet: RecombinationCodonTreeSet;
  readonly regionalTrees: readonly {
    readonly id: string;
    readonly startCodon: number;
    readonly endCodon: number;
    readonly startNucleotide: number;
    readonly endNucleotide: number;
    readonly tree: string;
    readonly label?: string;
    readonly mask?: number;
  }[];
  readonly breakpoints: readonly { readonly afterCodon: number; readonly afterNucleotide: number }[];
  readonly history: Readonly<Record<string, unknown>>;
}

export function createCodonTreeSet(
  sourceMethod: string,
  branchLengthSource: RecombinationCodonTreeSet["branchLengthSource"],
  runsInput: readonly NucleotideTreeRun[],
  nucleotideSites: number,
): RecombinationCodonTreeSet {
  if (!Number.isInteger(nucleotideSites) || nucleotideSites <= 0 || nucleotideSites % 3 !== 0) throw new Error("Regional-tree output requires a codon-aligned nucleotide length divisible by three.");
  if (runsInput.length === 0) throw new Error("The recombination result contains no regional trees.");
  const runs = [...runsInput].sort((a, b) => a.start - b.start);
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index]!;
    if (!Number.isInteger(run.start) || !Number.isInteger(run.end) || run.start < 1 || run.end < run.start || !run.tree.includes("(")) throw new Error(`Regional tree ${index + 1} has invalid coordinates or Newick.`);
    if (index === 0 && run.start !== 1) throw new Error(`The first regional tree starts at nucleotide ${run.start}, not 1.`);
    if (index > 0 && run.start !== runs[index - 1]!.end + 1) throw new Error(`Regional trees ${index} and ${index + 1} overlap or leave a gap.`);
  }
  if (runs.at(-1)!.end !== nucleotideSites) throw new Error(`The final regional tree ends at nucleotide ${runs.at(-1)!.end}, not ${nucleotideSites}.`);
  const segments: Array<RecombinationCodonTreeSet["segments"][number]> = [];
  let active = 0;
  for (let codon = 1; codon <= nucleotideSites / 3; codon += 1) {
    const middle = 3 * codon - 1;
    while (active + 1 < runs.length && runs[active]!.end < middle) active += 1;
    const run = runs[active]!;
    if (middle < run.start || middle > run.end) throw new Error(`No regional tree covers codon ${codon}.`);
    const previous = segments.at(-1);
    if (previous !== undefined && previous.tree === run.tree && previous.mask === run.mask && previous.endCodon === codon - 1) {
      segments[segments.length - 1] = { ...previous, endCodon: codon, sourceNucleotideEnd: run.end };
    } else {
      segments.push({ startCodon: codon, endCodon: codon, tree: run.tree, sourceNucleotideStart: run.start, sourceNucleotideEnd: run.end, ...(run.label === undefined ? {} : { label: run.label }), ...(run.mask === undefined ? {} : { mask: run.mask }) });
    }
  }
  return { schemaVersion: 1, sourceMethod, branchLengthSource, branchScalePolicy: "fixed-relative", codonAssignment: "middle-nucleotide", segments };
}

export function fsartTreeSet(result: FsartAnalysisResult, sites: number): RecombinationCodonTreeSet {
  if (result.treeHmm.status === "complete" && result.treeHmm.viterbi !== undefined) {
    return createCodonTreeSet("fsart", "segment-ml", result.treeHmm.viterbi.runs.map((run) => ({ start: run.start, end: run.end, tree: result.treeHmm.states[run.state]?.tree ?? "", label: `FSART Viterbi ${run.start}-${run.end}` })), sites);
  }
  if (result.partition.status === "complete" && result.partition.segments.length > 0) {
    return createCodonTreeSet("fsart", "segment-ml", result.partition.segments.map((segment) => ({ start: segment.start, end: segment.end, tree: segment.tree, label: `FSART region ${segment.start}-${segment.end}` })), sites);
  }
  throw new Error("FSART produced no complete regional-tree reconstruction.");
}

export function mosaicTreeSet(result: MosaicSprAnalysisResult, sites: number): RecombinationCodonTreeSet {
  if (result.reconstruction.status !== "complete") throw new Error("MosaicSPR produced no complete reconstruction.");
  const states = new Map(result.reconstruction.states.map((state) => [state.id, state.tree]));
  return createCodonTreeSet("mosaicspr", "method-final-trees", result.reconstruction.runs.map((run) => ({ start: run.start, end: run.end, tree: states.get(run.stateId) ?? "", label: `MosaicSPR region ${run.start}-${run.end}` })), sites);
}

export function jemsprTreeSet(result: JemsprAnalysisResult, sites: number): RecombinationCodonTreeSet {
  if (result.likelihood.status !== "complete") throw new Error("JEMSPR linked branch-length likelihood was not completed.");
  return createCodonTreeSet("jemspr", "jemspr-linked-ml", result.likelihood.runs.map((run) => ({ start: run.start, end: run.end, tree: run.tree, mask: run.mask, label: `JEMSPR ML region ${run.start}-${run.end}` })), sites);
}

export function simulatorTreeSet(dataset: SimulatedDataset, nucleotideSites: number): RecombinationCodonTreeSet {
  const codons = nucleotideSites / 3;
  const regions = dataset.localTrees.length > 0 ? dataset.localTrees : [{ startCodon: 1, endCodon: codons, tree: dataset.tree, activeEventIds: [] }];
  return {
    schemaVersion: 1,
    sourceMethod: "simulation-truth",
    branchLengthSource: "method-final-trees",
    branchScalePolicy: "fixed-relative",
    codonAssignment: "middle-nucleotide",
    segments: regions.map((region) => ({ startCodon: region.startCodon, endCodon: region.endCodon, tree: region.tree.newick, label: `True local tree ${region.startCodon}-${region.endCodon}` })),
  };
}

export function createBundle(
  treeSet: RecombinationCodonTreeSet,
  nucleotideSites: number,
  taxa: number | undefined,
  representation: RecombinationBundle["representation"],
  history: Readonly<Record<string, unknown>>,
): RecombinationBundle {
  const regionalTrees = treeSet.segments.map((segment, index) => ({
    id: `R${index + 1}`,
    startCodon: segment.startCodon,
    endCodon: segment.endCodon,
    startNucleotide: segment.sourceNucleotideStart ?? (segment.startCodon - 1) * 3 + 1,
    endNucleotide: segment.sourceNucleotideEnd ?? segment.endCodon * 3,
    tree: segment.tree,
    ...(segment.label === undefined ? {} : { label: segment.label }),
    ...(segment.mask === undefined ? {} : { mask: segment.mask }),
  }));
  return {
    format: "evoonline-recombination-tree-bundle",
    schemaVersion: 1,
    representation,
    sourceMethod: treeSet.sourceMethod,
    alignment: { nucleotideSites, codonSites: nucleotideSites / 3, ...(taxa === undefined ? {} : { taxa }), coordinates: "one-based-inclusive", breakpointConvention: "after-site" },
    downstreamLikelihood: { codonAssignment: "middle-nucleotide", branchScalePolicy: "fixed-relative", branchLengthSource: treeSet.branchLengthSource },
    codonTreeSet: treeSet,
    regionalTrees,
    breakpoints: regionalTrees.slice(0, -1).map((region) => ({ afterCodon: region.endCodon, afterNucleotide: region.endNucleotide })),
    history,
  };
}

export function resultBundle(result: FsartAnalysisResult | MosaicSprAnalysisResult | JemsprAnalysisResult, treeSet: RecombinationCodonTreeSet, sites: number, taxa: number): RecombinationBundle {
  if (result.method === "fsart") return createBundle(treeSet, sites, taxa, "independent-regional-trees", { kind: "independent-regional-trees", interpretation: "each-region-tree-is-an-independent-estimate", criterion: result.treeHmm.status === "complete" ? result.treeHmm.criterion : result.partition.criterion, criterionValue: result.treeHmm.status === "complete" ? result.treeHmm.criterionValue : result.partition.criterionValue });
  if (result.method === "mosaic-spr") {
    const master = result.reconstruction.states.find((state) => state.id === result.reconstruction.masterStateId);
    return createBundle(treeSet, sites, taxa, "spr-history", { kind: "spr-history", interpretation: "master-tree-plus-spr-events", sprModel: "unrooted-edit-tape", masterTree: master?.tree ?? treeSet.segments[0]?.tree ?? "", breakpointEvents: result.reconstruction.events, states: result.reconstruction.states, derivations: result.reconstruction.derivations, searchCertificate: result.reconstruction.certificate });
  }
  const linked = result.likelihood;
  return createBundle(treeSet, sites, taxa, "spr-history", { kind: "spr-history", interpretation: "master-tree-plus-spr-events", sprModel: "rooted-switching-network", masterTree: linked.status === "complete" ? linked.masterTree : result.network.masterTree, eventTemplates: result.network.templates, eventOccurrences: result.network.occurrences, breakpointEvents: result.network.breakpointGaps, switchingNetwork: JSON.parse(result.networkJson), states: result.network.trees, temporal: result.network.temporal, searchCertificate: result.network.certificate, ...(linked.status === "complete" ? { branchLinkage: { policy: "shared-network-edge-lengths", atomicBranches: linked.atomicBranches, fixedZeroEdges: linked.fixedZeroEdges, nonidentifiableGroups: linked.nonidentifiableGroups, gtrModel: linked.model, rateVariation: linked.rateVariation, logLikelihood: linked.logLikelihood } } : {}) });
}

export function simulatorBundle(dataset: SimulatedDataset, treeSet: RecombinationCodonTreeSet, nucleotideSites: number, taxa: number): RecombinationBundle {
  return createBundle(treeSet, nucleotideSites, taxa, "spr-history", {
    kind: "spr-history",
    interpretation: "master-tree-plus-spr-events",
    sprModel: "rooted-switching-network",
    masterTree: dataset.carrierTree?.newick ?? dataset.tree.newick,
    eventOccurrences: dataset.recombinationEvents,
    breakpointEvents: dataset.recombinationEvents.flatMap((event) => event.breakpoints.map((afterCodon) => ({ eventId: event.id, afterCodon, visibleAfterSubsampling: event.visibleAfterSubsampling }))),
    switchingNetwork: { carrierTree: dataset.carrierTree, observedTree: dataset.tree, localTrees: dataset.localTrees, recombinationEvents: dataset.recombinationEvents },
    states: dataset.localTrees,
    note: "Exact simulator truth.",
  });
}

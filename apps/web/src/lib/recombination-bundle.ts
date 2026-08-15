import type { RecombinationCodonTreeSet } from "@phylo-workbench/model-diffubar/browser-source";
import type { FsartAnalysisResult } from "@phylo-workbench/model-fsart/browser-source";
import type { JemsprAnalysisResult } from "@phylo-workbench/model-jemspr/browser-source";
import type { MosaicSprAnalysisResult } from "@phylo-workbench/model-mosaicspr/browser-source";
import type { SimulatedDataset } from "@phylo-workbench/model-simulator/browser-source";

export const RECOMBINATION_TREE_BUNDLE_FORMAT = "evoonline-recombination-tree-bundle" as const;

export type RecombinationTreeRepresentation = "independent-regional-trees" | "spr-history";

export interface PortableRegionalTree {
  readonly id: string;
  readonly startCodon: number;
  readonly endCodon: number;
  readonly startNucleotide: number;
  readonly endNucleotide: number;
  readonly tree: string;
  readonly label?: string;
  readonly mask?: number;
}

export interface PortableBreakpoint {
  /** Break after this one-based codon in the downstream codon partition. */
  readonly afterCodon: number;
  /** Original nucleotide boundary when the detector retained it. */
  readonly afterNucleotide: number;
}

export interface IndependentRegionalHistory {
  readonly kind: "independent-regional-trees";
  readonly interpretation: "each-region-tree-is-an-independent-estimate";
  readonly criterion?: string;
  readonly criterionValue?: number | null;
}

export interface SprHistory {
  readonly kind: "spr-history";
  readonly interpretation: "master-tree-plus-spr-events";
  readonly sprModel: "rooted-switching-network" | "unrooted-edit-tape" | "flattened-regional-projection";
  readonly masterTree: string;
  readonly eventTemplates?: readonly unknown[];
  readonly eventOccurrences?: readonly unknown[];
  readonly breakpointEvents?: readonly unknown[];
  readonly regionalMasks?: readonly { readonly start: number; readonly end: number; readonly mask: number }[];
  readonly switchingNetwork?: unknown;
  readonly states?: readonly unknown[];
  readonly derivations?: readonly unknown[];
  readonly temporal?: unknown;
  readonly searchCertificate?: unknown;
  readonly branchLinkage?: {
    readonly policy: "shared-network-edge-lengths";
    readonly atomicBranches: readonly unknown[];
    readonly fixedZeroEdges: readonly unknown[];
    readonly nonidentifiableGroups: readonly (readonly string[])[];
    readonly gtrModel: unknown;
    readonly rateVariation: unknown;
    readonly logLikelihood: number;
  };
  readonly note?: string;
}

export interface EvoOnlineRecombinationTreeBundle {
  readonly format: typeof RECOMBINATION_TREE_BUNDLE_FORMAT;
  readonly schemaVersion: 1;
  readonly representation: RecombinationTreeRepresentation;
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
  /** Complete, detector-agnostic input consumed by FUBAR/FAME/FLAVOR. */
  readonly codonTreeSet: RecombinationCodonTreeSet;
  /** Human/tool-friendly duplicate with explicit nucleotide coordinates. */
  readonly regionalTrees: readonly PortableRegionalTree[];
  readonly breakpoints: readonly PortableBreakpoint[];
  readonly history: IndependentRegionalHistory | SprHistory;
}

function portableRegions(treeSet: RecombinationCodonTreeSet): readonly PortableRegionalTree[] {
  return treeSet.segments.map((segment, index) => ({
    id: `R${index + 1}`,
    startCodon: segment.startCodon,
    endCodon: segment.endCodon,
    startNucleotide: segment.sourceNucleotideStart ?? (segment.startCodon - 1) * 3 + 1,
    endNucleotide: segment.sourceNucleotideEnd ?? segment.endCodon * 3,
    tree: segment.tree,
    ...(segment.label === undefined ? {} : { label: segment.label }),
    ...(segment.mask === undefined ? {} : { mask: segment.mask }),
  }));
}

function portableBreakpoints(regions: readonly PortableRegionalTree[]): readonly PortableBreakpoint[] {
  return regions.slice(0, -1).map((region) => ({ afterCodon: region.endCodon, afterNucleotide: region.endNucleotide }));
}

function baseBundle(
  treeSet: RecombinationCodonTreeSet,
  nucleotideSites: number,
  representation: RecombinationTreeRepresentation,
  history: IndependentRegionalHistory | SprHistory,
  taxa?: number,
): EvoOnlineRecombinationTreeBundle {
  if (!Number.isInteger(nucleotideSites) || nucleotideSites <= 0 || nucleotideSites % 3 !== 0) {
    throw new Error("Portable recombination tree bundles require a positive codon-aligned nucleotide length.");
  }
  const regionalTrees = portableRegions(treeSet);
  return {
    format: RECOMBINATION_TREE_BUNDLE_FORMAT,
    schemaVersion: 1,
    representation,
    sourceMethod: treeSet.sourceMethod,
    alignment: {
      nucleotideSites,
      codonSites: nucleotideSites / 3,
      ...(taxa === undefined ? {} : { taxa }),
      coordinates: "one-based-inclusive",
      breakpointConvention: "after-site",
    },
    downstreamLikelihood: {
      codonAssignment: treeSet.codonAssignment,
      branchScalePolicy: treeSet.branchScalePolicy,
      branchLengthSource: treeSet.branchLengthSource,
    },
    codonTreeSet: treeSet,
    regionalTrees,
    breakpoints: portableBreakpoints(regionalTrees),
    history,
  };
}

export function createFsartRecombinationBundle(
  result: FsartAnalysisResult,
  treeSet: RecombinationCodonTreeSet,
): EvoOnlineRecombinationTreeBundle {
  const criterion = result.treeHmm.status === "complete" ? result.treeHmm.criterion : result.partition.criterion;
  const criterionValue = result.treeHmm.status === "complete" ? result.treeHmm.criterionValue : result.partition.criterionValue;
  return baseBundle(treeSet, result.diagnostics.sites, "independent-regional-trees", {
    kind: "independent-regional-trees",
    interpretation: "each-region-tree-is-an-independent-estimate",
    criterion,
    criterionValue,
  }, result.diagnostics.taxa);
}

function switchingNetworkFrom(result: JemsprAnalysisResult): unknown {
  try {
    const parsed = JSON.parse(result.networkJson) as { readonly switchingNetwork?: unknown };
    return parsed.switchingNetwork;
  } catch {
    return undefined;
  }
}

export function createJemsprRecombinationBundle(
  result: JemsprAnalysisResult,
  treeSet: RecombinationCodonTreeSet,
): EvoOnlineRecombinationTreeBundle {
  if (result.likelihood.status !== "complete") throw new Error("JEMSPR linked-ML trees are required for a portable downstream bundle.");
  const linked = result.likelihood;
  return baseBundle(treeSet, result.sites, "spr-history", {
    kind: "spr-history",
    interpretation: "master-tree-plus-spr-events",
    sprModel: "rooted-switching-network",
    masterTree: linked.masterTree,
    eventTemplates: result.network.templates,
    eventOccurrences: result.network.occurrences,
    breakpointEvents: result.network.breakpointGaps,
    regionalMasks: linked.runs.map((run) => ({ start: run.start, end: run.end, mask: run.mask })),
    switchingNetwork: switchingNetworkFrom(result),
    states: result.network.trees,
    temporal: result.network.temporal,
    searchCertificate: result.network.certificate,
    branchLinkage: {
      policy: "shared-network-edge-lengths",
      atomicBranches: linked.atomicBranches,
      fixedZeroEdges: linked.fixedZeroEdges,
      nonidentifiableGroups: linked.nonidentifiableGroups,
      gtrModel: linked.model,
      rateVariation: linked.rateVariation,
      logLikelihood: linked.logLikelihood,
    },
  }, result.taxa);
}

export function createMosaicSprRecombinationBundle(
  result: MosaicSprAnalysisResult,
  treeSet: RecombinationCodonTreeSet,
): EvoOnlineRecombinationTreeBundle {
  const reconstruction = result.reconstruction;
  const master = reconstruction.states.find((state) => state.id === reconstruction.masterStateId);
  if (reconstruction.status !== "complete" || master === undefined) throw new Error("MosaicSPR must have a complete master/edit reconstruction before export.");
  return baseBundle(treeSet, result.sites, "spr-history", {
    kind: "spr-history",
    interpretation: "master-tree-plus-spr-events",
    sprModel: "unrooted-edit-tape",
    masterTree: master.tree,
    breakpointEvents: reconstruction.events,
    states: reconstruction.states,
    derivations: reconstruction.derivations,
    searchCertificate: reconstruction.certificate,
  }, result.taxa);
}

/** Preserve the simulator's actual local-tree history instead of presenting it as inferred regional trees. */
export function createSimulationTruthRecombinationBundle(
  dataset: SimulatedDataset,
  treeSet: RecombinationCodonTreeSet,
  nucleotideSites: number,
  taxa?: number,
): EvoOnlineRecombinationTreeBundle {
  return baseBundle(treeSet, nucleotideSites, "spr-history", {
    kind: "spr-history",
    interpretation: "master-tree-plus-spr-events",
    sprModel: "rooted-switching-network",
    masterTree: dataset.carrierTree?.newick ?? dataset.tree.newick,
    eventOccurrences: dataset.recombinationEvents,
    breakpointEvents: dataset.recombinationEvents.flatMap((event) => event.breakpoints.map((afterCodon) => ({
      eventId: event.id,
      afterCodon,
      visibleAfterSubsampling: event.visibleAfterSubsampling,
    }))),
    switchingNetwork: {
      carrierTree: dataset.carrierTree,
      observedTree: dataset.tree,
      localTrees: dataset.localTrees,
      recombinationEvents: dataset.recombinationEvents,
    },
    states: dataset.localTrees.map((region, index) => ({
      id: `truth-${index + 1}`,
      startCodon: region.startCodon,
      endCodon: region.endCodon,
      tree: region.tree.newick,
      activeEventIds: region.activeEventIds,
    })),
    note: "Exact simulator truth: the carrier genealogy, sampled recombination events, and resulting local trees are retained with this route.",
  }, taxa);
}

/** Fallback for old saved analyses that predate portable history bundles. */
export function createProjectedRecombinationBundle(
  treeSet: RecombinationCodonTreeSet,
  nucleotideSites: number,
  taxa?: number,
): EvoOnlineRecombinationTreeBundle {
  const sprDerived = treeSet.sourceMethod === "jemspr" || treeSet.sourceMethod === "mosaicspr";
  if (!sprDerived) {
    return baseBundle(treeSet, nucleotideSites, "independent-regional-trees", {
      kind: "independent-regional-trees",
      interpretation: "each-region-tree-is-an-independent-estimate",
    }, taxa);
  }
  return baseBundle(treeSet, nucleotideSites, "spr-history", {
    kind: "spr-history",
    interpretation: "master-tree-plus-spr-events",
    sprModel: "flattened-regional-projection",
    masterTree: treeSet.segments[0]?.tree ?? "",
    note: "This bundle was reconstructed from a legacy downstream tree partition. Regional trees are complete, but the original SPR event tape/network was not retained in that saved analysis.",
  }, taxa);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function validateTreeSet(value: unknown, expectedCodonSites?: number): asserts value is RecombinationCodonTreeSet {
  if (!record(value) || value.schemaVersion !== 1 || value.branchScalePolicy !== "fixed-relative" || value.codonAssignment !== "middle-nucleotide") {
    throw new Error("The file does not contain an EvoOnline fixed-relative codon tree partition.");
  }
  if (typeof value.sourceMethod !== "string" || !["jemspr-linked-ml", "segment-ml", "method-final-trees"].includes(String(value.branchLengthSource)) || !Array.isArray(value.segments) || value.segments.length === 0) {
    throw new Error("The recombination tree partition has invalid provenance or no regions.");
  }
  let expectedStart = 1;
  for (const [index, segment] of value.segments.entries()) {
    if (!record(segment) || !integer(segment.startCodon) || !integer(segment.endCodon) || segment.startCodon !== expectedStart || segment.endCodon < segment.startCodon || typeof segment.tree !== "string" || !segment.tree.includes("(")) {
      throw new Error(`Recombination region ${index + 1} is invalid or leaves a gap in the codon partition.`);
    }
    expectedStart = segment.endCodon + 1;
  }
  if (expectedCodonSites !== undefined && expectedStart !== expectedCodonSites + 1) {
    throw new Error(`The saved tree set covers ${expectedStart - 1} codons, but the loaded alignment contains ${expectedCodonSites}.`);
  }
  if (value.sourceMethod === "jemspr" && value.branchLengthSource !== "jemspr-linked-ml") {
    throw new Error("JEMSPR imports must contain linked-ML polished regional trees.");
  }
}

export function parseRecombinationTreeBundle(text: string, expectedCodonSites?: number): EvoOnlineRecombinationTreeBundle {
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new Error("The recombination tree file is not valid JSON."); }
  if (!record(parsed) || parsed.format !== RECOMBINATION_TREE_BUNDLE_FORMAT || parsed.schemaVersion !== 1) {
    throw new Error("This is not an EvoOnline recombination-tree bundle (schema version 1).");
  }
  if (parsed.representation !== "independent-regional-trees" && parsed.representation !== "spr-history") throw new Error("The recombination bundle has an unknown tree representation.");
  validateTreeSet(parsed.codonTreeSet, expectedCodonSites);
  if (!record(parsed.alignment) || !integer(parsed.alignment.nucleotideSites) || !integer(parsed.alignment.codonSites) || parsed.alignment.nucleotideSites !== parsed.alignment.codonSites * 3) {
    throw new Error("The recombination bundle has invalid alignment dimensions.");
  }
  if (expectedCodonSites !== undefined && parsed.alignment.codonSites !== expectedCodonSites) {
    throw new Error(`The saved bundle contains ${parsed.alignment.codonSites} codons, but the loaded alignment contains ${expectedCodonSites}.`);
  }
  if (parsed.codonTreeSet.segments.at(-1)?.endCodon !== parsed.alignment.codonSites || parsed.sourceMethod !== parsed.codonTreeSet.sourceMethod) {
    throw new Error("The recombination bundle's alignment dimensions or source method disagree with its codon partition.");
  }
  if (!record(parsed.downstreamLikelihood)
    || parsed.downstreamLikelihood.codonAssignment !== parsed.codonTreeSet.codonAssignment
    || parsed.downstreamLikelihood.branchScalePolicy !== parsed.codonTreeSet.branchScalePolicy
    || parsed.downstreamLikelihood.branchLengthSource !== parsed.codonTreeSet.branchLengthSource) {
    throw new Error("The recombination bundle's likelihood policy disagrees with its regional trees.");
  }
  if (!Array.isArray(parsed.regionalTrees) || !Array.isArray(parsed.breakpoints) || !record(parsed.history) || parsed.history.kind !== parsed.representation) {
    throw new Error("The recombination bundle is incomplete or internally inconsistent.");
  }
  if (parsed.representation === "spr-history" && (typeof parsed.history.masterTree !== "string" || !parsed.history.masterTree.includes("("))) {
    throw new Error("The SPR bundle does not contain a valid master tree.");
  }
  const regionalTrees = portableRegions(parsed.codonTreeSet);
  if (parsed.regionalTrees.length !== regionalTrees.length) throw new Error("The portable region index disagrees with the codon tree partition.");
  return {
    ...(parsed as unknown as EvoOnlineRecombinationTreeBundle),
    regionalTrees,
    breakpoints: portableBreakpoints(regionalTrees),
  };
}

export function serializeRecombinationTreeBundle(bundle: EvoOnlineRecombinationTreeBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

export function recombinationBundleFilename(bundle: EvoOnlineRecombinationTreeBundle): string {
  const method = bundle.sourceMethod.toLowerCase().replaceAll(/[^a-z0-9-]+/g, "-");
  return `${method || "recombination"}.evo-recomb.json`;
}

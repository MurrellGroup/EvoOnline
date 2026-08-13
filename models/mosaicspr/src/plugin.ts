import type { PhyloWorkspaceSnapshot } from "@phylo-workbench/domain";
import {
  defaultsFromManifest,
  type AnalysisJobSpec,
  type ModelManifest,
  type ModelPlugin,
  type ModelValidation,
  type ValidationIssue,
} from "@phylo-workbench/model-sdk";
import { parseMosaicSprFasta } from "./alignment.js";
import type { MosaicSprAnalysisResult } from "./types.js";

export const mosaicSprManifest: ModelManifest = {
  id: "mosaic-spr",
  version: "0.1.0",
  title: "MosaicSPR: explicit recombination histories",
  shortTitle: "MosaicSPR",
  description: "Jointly infer an unknown master phylogeny, genomic regions, and explicit multi-step subtree-prune-regraft histories for every implied local tree.",
  category: "recombination",
  inputSlots: [{
    id: "alignment",
    label: "Nucleotide alignment",
    kind: "alignment",
    required: true,
    description: "Aligned nucleotide FASTA. Codon frame is not required.",
  }],
  parameters: [
    { id: "useBreakpointProposals", label: "Use fast triplet region proposals", description: "Recommended. Reuse FSART's pair-covered informative-triplet proposal code to seed local FastTree fits. These proposals never constrain the final SPR breakpoints.", type: "boolean", default: true },
    { id: "fastTreeFastest", label: "Use FastTree's fastest topology search", description: "Recommended for the proposal family. The SPR reconstruction itself is scored separately.", type: "boolean", default: true },
    { id: "minimumSegmentLength", label: "Minimum genomic run length", description: "Minimum length of a reconstructed local-tree run. The proposal stage also raises this when observed diversity is too low to estimate local trees safely.", type: "integer", default: 150, minimum: 30, maximum: 10000, step: 1 },
    { id: "maximumSprStates", label: "SPR topology-state budget", description: "Maximum connected topology states retained by column generation. This is a runtime budget, not a limit on the number of edits in a local tree.", type: "integer", default: 48, minimum: 8, maximum: 128, step: 4 },
    { id: "maximumSprIterations", label: "SPR expansion rounds", description: "Successive one-SPR graph layers. Repeated layers create unrestricted multi-SPR local trees.", type: "integer", default: 12, minimum: 1, maximum: 40, step: 1, advanced: true },
    { id: "sprBeamWidth", label: "SPR expansion beam", description: "Connected topology columns retained per expansion round.", type: "integer", default: 4, minimum: 1, maximum: 16, step: 1, advanced: true },
    { id: "sprParsimonyScreenLimit", label: "SPR Fitch screen", description: "Distinct one-SPR neighbours scored per expansion round after structural diversity screening.", type: "integer", default: 96, minimum: 8, maximum: 512, step: 8, advanced: true },
    { id: "maximumSprStarts", label: "Unknown-master starts", description: "Best distinct FastTree proposal topologies used as independent unknown-master searches.", type: "integer", default: 3, minimum: 1, maximum: 12, step: 1, advanced: true },
    { id: "sprSearchPatience", label: "Multi-edit look-ahead", description: "Non-improving graph layers allowed so a useful multi-SPR topology can be reached through neutral intermediate trees.", type: "integer", default: 5, minimum: 1, maximum: 20, step: 1, advanced: true },
    { id: "sprBreakpointPenalty", label: "Breakpoint penalty", description: "Zero selects the alignment-size MDL default; a positive value overrides it in parsimony units.", type: "number", default: 0, minimum: 0, maximum: 100, step: 0.1, advanced: true },
    { id: "sprMovePenalty", label: "Per-SPR edit penalty", description: "Zero selects the taxon-count MDL default. Every composed edit at a breakpoint is charged.", type: "number", default: 0, minimum: 0, maximum: 100, step: 0.1, advanced: true },
    { id: "sprMasterPenalty", label: "Master-description penalty", description: "Zero selects the default compact-history penalty. The master topology remains free to change.", type: "number", default: 0, minimum: 0, maximum: 100, step: 0.1, advanced: true },
    { id: "window", label: "Triplet events per flank", description: "Only affects optional region proposals; it does not define reconstructed breakpoints.", type: "integer", default: 24, minimum: 8, maximum: 128, step: 2, advanced: true },
    { id: "maximumTriplets", label: "Triplet proposal budget", description: "All-pairs coverage is always retained before supplemental triplets are sampled.", type: "integer", default: 250000, minimum: 100, maximum: 10000000, step: 1000, advanced: true },
    { id: "maximumSignals", label: "Retained proposal peaks", description: "Bounded heap for triplet peaks entering region proposal aggregation.", type: "integer", default: 1024, minimum: 32, maximum: 10000, step: 32, advanced: true },
    { id: "maximumReportedSignals", label: "Refined proposal peaks", description: "Bounded number of triplet peaks receiving uncertainty refinement.", type: "integer", default: 256, minimum: 16, maximum: 4000, step: 16, advanced: true },
    { id: "maximumConsensusBreakpoints", label: "Proposal boundary limit", description: "Limits only the FastTree seed family, never the final event count.", type: "integer", default: 14, minimum: 1, maximum: 30, step: 1, advanced: true },
  ],
  runtimes: ["browser-wasm"],
  outputKinds: ["master-tree", "unrestricted-spr-graph", "spr-edit-tape", "implied-local-trees", "linked-tanglegram", "region-track", "svg", "csv", "json"],
  citation: "Exploratory EvoOnline algorithm. Region proposals optionally reuse FSART's RDP-inspired informative-triplet scanner; MosaicSPR is a distinct unknown-master, explicit unrooted-SPR reconstruction and does not claim global topology-space optimality.",
};

export function validateMosaicSprWorkspace(workspace: PhyloWorkspaceSnapshot): ModelValidation {
  const issues: ValidationIssue[] = [];
  if (workspace.alignment === undefined) issues.push({ severity: "error", code: "ALIGNMENT_REQUIRED", message: "Load an aligned nucleotide FASTA.", artifact: "alignment" });
  else {
    try {
      const parsed = parseMosaicSprFasta(workspace.alignment.text);
      if (parsed.taxa < 4) issues.push({ severity: "warning", code: "LOW_TAXA", message: "At least four taxa are recommended for a meaningful SPR history.", artifact: "alignment" });
    } catch (error) {
      issues.push({ severity: "error", code: "INVALID_ALIGNMENT", message: error instanceof Error ? error.message : String(error), artifact: "alignment" });
    }
  }
  return { ready: !issues.some((issue) => issue.severity === "error"), issues };
}

export const mosaicSprPlugin: ModelPlugin<MosaicSprAnalysisResult> = {
  manifest: mosaicSprManifest,
  validate: validateMosaicSprWorkspace,
  defaultParameters: () => defaultsFromManifest(mosaicSprManifest),
  createJob: (workspace, parameters): AnalysisJobSpec => ({
    schemaVersion: 1,
    model: { id: mosaicSprManifest.id, version: mosaicSprManifest.version },
    inputs: { alignmentSha256: workspace.alignment.sha256 },
    parameters,
    requestedRuntime: "browser-wasm",
  }),
  resultToCsv: (result) => result.eventCsv,
};

import type { PhyloWorkspaceSnapshot } from "@phylo-workbench/domain";
import {
  defaultsFromManifest,
  type AnalysisJobSpec,
  type ModelManifest,
  type ModelPlugin,
  type ModelValidation,
  type ValidationIssue,
} from "@phylo-workbench/model-sdk";
import { parseJemsprFasta } from "./alignment.js";
import type { JemsprAnalysisResult } from "./types.js";

export const jemsprManifest: ModelManifest = {
  id: "jemspr",
  version: "0.1.0",
  title: "JEMSPR: joint master and event-network inference",
  shortTitle: "JEMSPR",
  description: "Infer a rooted latent master, unrestricted local-tree path, and one coherent switching network of persistent, potentially overlapping rooted-SPR events directly from an alignment.",
  category: "recombination",
  inputSlots: [{ id: "alignment", label: "Nucleotide alignment", kind: "alignment", required: true, description: "Aligned nucleotide FASTA. JEMSPR infers every tree, root candidate, event, and boundary internally." }],
  parameters: [
    { id: "scoreMethod", label: "Parsimony score", description: "Fitch is fastest. Sankoff uses the transition/transversion costs below and retains exact ambiguity handling.", type: "select", default: "fitch", options: [{ value: "fitch", label: "Fitch (recommended)" }, { value: "sankoff", label: "Weighted Sankoff" }] },
    { id: "minimumWindow", label: "Smallest multiscale window", description: "Smallest data-independent dyadic window used to generate internal NJ topology guidance. These windows are not breakpoint proposals or constraints.", type: "integer", default: 120, minimum: 24, maximum: 5000, step: 4 },
    { id: "maximumGraphStates", label: "Rooted-tree graph budget", description: "Maximum verified rooted topologies retained per root-placement start.", type: "integer", default: 36, minimum: 6, maximum: 128, step: 2 },
    { id: "maximumReticulations", label: "Reticulation-template cap", description: "Maximum explicit switching-network reticulations considered by the exact-scored network beam.", type: "integer", default: 5, minimum: 0, maximum: 10, step: 1 },
    { id: "overlapCap", label: "Maximum concurrent events", description: "All active-event masks through this overlap depth are decoded exactly. Three is the practical default for nested/crossing histories; increase if the result touches the cap.", type: "integer", default: 3, minimum: 0, maximum: 6, step: 1 },
    { id: "boundaryConvention", label: "Alignment-edge events", description: "Open is recommended for alignments that may be a subregion. Closed charges endpoints outside neither edge; penalized-open applies censoring costs.", type: "select", default: "open", options: [{ value: "open", label: "Open (recommended)" }, { value: "penalized-open", label: "Penalized open" }, { value: "closed", label: "Closed" }] },
    { id: "rootPlacements", label: "Root-placement starts", description: "Distinct inferred root placements searched independently. Rooting is not silently fixed by neighbor joining.", type: "integer", default: 3, minimum: 1, maximum: 12, step: 1, advanced: true },
    { id: "maximumDyadicTrees", label: "Multiscale NJ guide trees", description: "Maximum unique internally inferred whole/dyadic-window trees used only to guide rooted-SPR expansion.", type: "integer", default: 16, minimum: 1, maximum: 64, step: 1, advanced: true },
    { id: "maximumGraphIterations", label: "Tree-space expansion rounds", description: "Adaptive pricing/bridge rounds for each inferred root placement.", type: "integer", default: 10, minimum: 1, maximum: 40, step: 1, advanced: true },
    { id: "neighbourScreen", label: "rSPR neighbours priced per round", description: "Structurally generated neighbours retained for full all-interval pricing after the deterministic parsimony screen.", type: "integer", default: 72, minimum: 4, maximum: 512, step: 4, advanced: true },
    { id: "frontierStates", label: "Occupied-tree frontier", description: "Frequently occupied graph states expanded on every round.", type: "integer", default: 4, minimum: 1, maximum: 16, step: 1, advanced: true },
    { id: "nearImprovers", label: "Near-improver bridge columns", description: "Non-improving rooted-SPR columns retained to cross coordinated-move valleys.", type: "integer", default: 2, minimum: 0, maximum: 12, step: 1, advanced: true },
    { id: "pathBreakpointPenalty", label: "Path breakpoint penalty", description: "Cost per local-tree boundary. Zero selects the more conservative log2(alignment length + 1) rule.", type: "number", default: 4, minimum: 0, maximum: 100, step: 0.1, advanced: true },
    { id: "pathEndpointPenalty", label: "Path rSPR endpoint penalty", description: "Multi-rSPR changes at one boundary pay this per graph edge. Zero selects a taxon-count rule.", type: "number", default: 1, minimum: 0, maximum: 100, step: 0.1, advanced: true },
    { id: "pathSpanPenalty", label: "Path master-distance span penalty", description: "This term identifies a compact latent master without requiring it to occur locally. Zero selects the more conservative inverse-window rule.", type: "number", default: 0.002, minimum: 0, maximum: 1, step: 0.0005, advanced: true },
    { id: "networkBeamWidth", label: "Switching-network beam", description: "Diverse exact-scored networks retained after each reticulation addition, including reserved latent bridge prefixes.", type: "integer", default: 8, minimum: 1, maximum: 32, step: 1, advanced: true },
    { id: "eventPoolSize", label: "Residual event-template pool", description: "Per-network budget shared by path-guided bridge moves and residual rooted-SPR moves regenerated inside current event contexts.", type: "integer", default: 20, minimum: 1, maximum: 48, step: 1, advanced: true },
    { id: "eventOpenPenalty", label: "Event opening penalty", description: "Cost for starting one persistent reticulation-template occurrence.", type: "number", default: 2, minimum: 0, maximum: 100, step: 0.1, advanced: true },
    { id: "eventClosePenalty", label: "Event closure penalty", description: "Cost for observing an event closure. Zero makes each tract pay primarily at opening.", type: "number", default: 0, minimum: 0, maximum: 100, step: 0.1, advanced: true },
    { id: "networkBreakpointPenalty", label: "Network breakpoint-coordinate penalty", description: "Charged once at a genomic coordinate regardless of how many event bits change there.", type: "number", default: 2, minimum: 0, maximum: 100, step: 0.1, advanced: true },
    { id: "eventSpanPenalty", label: "Active-event span penalty", description: "Per-nucleotide cost for each simultaneously active reticulation template.", type: "number", default: 0.002, minimum: 0, maximum: 1, step: 0.0005, advanced: true },
    { id: "reticulationPenalty", label: "Network structural penalty", description: "Cost per retained reticulation template, including unused templates during beam search.", type: "number", default: 2, minimum: 0, maximum: 100, step: 0.1, advanced: true },
    { id: "boundaryCensorPenalty", label: "Open-edge censoring penalty", description: "Per active event at either alignment edge under penalized-open boundaries.", type: "number", default: 2, minimum: 0, maximum: 100, step: 0.1, advanced: true },
    { id: "uncertaintyTolerance", label: "Endpoint range tolerance", description: "Consecutive endpoint coordinates whose exact fixed-network directional min-marginal is within this many parsimony units of the selected endpoint are reported as its uncertainty range.", type: "number", default: 2, minimum: 0, maximum: 100, step: 0.1, advanced: true },
    { id: "transitionCost", label: "Sankoff transition cost", description: "A↔G and C↔T cost; used only with weighted Sankoff.", type: "number", default: 0.5, minimum: 0, maximum: 10, step: 0.1, advanced: true },
    { id: "transversionCost", label: "Sankoff transversion cost", description: "All other nucleotide-change costs; used only with weighted Sankoff.", type: "number", default: 1, minimum: 0, maximum: 10, step: 0.1, advanced: true },
  ],
  runtimes: ["browser-wasm"],
  outputKinds: ["rooted-master-tree", "adaptive-rspr-path", "switching-network", "overlapping-event-intervals", "local-trees", "tree-sequence-edges", "linked-tanglegram", "svg", "csv", "tsv", "json"],
  citation: "JEMSPR exploratory algorithm, following the attached 'Joint Inference of a Latent Master Phylogeny and Overlapping Recombination Events' algorithmic specification (2026).",
};

export function validateJemsprWorkspace(workspace: PhyloWorkspaceSnapshot): ModelValidation {
  const issues: ValidationIssue[] = [];
  if (workspace.alignment === undefined) issues.push({ severity: "error", code: "ALIGNMENT_REQUIRED", message: "Load an aligned nucleotide FASTA.", artifact: "alignment" });
  else {
    try {
      const alignment = parseJemsprFasta(workspace.alignment.text);
      if (alignment.informativePositions.length < 4) issues.push({ severity: "warning", code: "LOW_VARIATION", message: "The alignment has very few variable nucleotide sites; recombination events may be unidentifiable.", artifact: "alignment" });
      if (alignment.taxa > 64) issues.push({ severity: "warning", code: "LARGE_TAXON_SET", message: "Rooted-SPR tree-space search grows rapidly above 64 taxa. JEMSPR will use its bounded streaming neighbourhood screen; begin with conservative graph/network budgets and test stability.", artifact: "alignment" });
    } catch (error) {
      issues.push({ severity: "error", code: "INVALID_ALIGNMENT", message: error instanceof Error ? error.message : String(error), artifact: "alignment" });
    }
  }
  return { ready: !issues.some((issue) => issue.severity === "error"), issues };
}

export const jemsprPlugin: ModelPlugin<JemsprAnalysisResult> = {
  manifest: jemsprManifest,
  validate: validateJemsprWorkspace,
  defaultParameters: () => defaultsFromManifest(jemsprManifest),
  createJob: (workspace, parameters): AnalysisJobSpec => ({ schemaVersion: 1, model: { id: jemsprManifest.id, version: jemsprManifest.version }, inputs: { alignmentSha256: workspace.alignment.sha256 }, parameters, requestedRuntime: "browser-wasm" }),
  resultToCsv: (result) => result.eventsCsv,
};

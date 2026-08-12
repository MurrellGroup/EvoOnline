import type { PhyloWorkspaceSnapshot } from "@phylo-workbench/domain";
import {
  defaultsFromManifest,
  type AnalysisJobSpec,
  type ModelManifest,
  type ModelPlugin,
  type ModelValidation,
  type ValidationIssue,
} from "@phylo-workbench/model-sdk";
import { normalizeDifFubarTreeText, parseFasta, parseNewick } from "@phylo-workbench/model-diffubar";
import { cladeShiftSitesToCsv } from "./pipeline.js";
import type { CladeShiftAnalysisResult } from "./types.js";

export const cladeShiftManifest: ModelManifest = {
  id: "clade-shift",
  version: "0.1.0",
  title: "Discover persistent selection changes with CladeShift",
  shortTitle: "CladeShift",
  description: "Find codons whose selective stringency relaxed or intensified persistently in an untagged descendant clade, and infer the initiating branch.",
  category: "selection",
  inputSlots: [
    {
      id: "alignment",
      label: "Codon alignment",
      kind: "alignment",
      required: true,
      description: "Aligned nucleotide FASTA whose width is divisible by three.",
    },
    {
      id: "tree",
      label: "Phylogeny",
      kind: "tree",
      required: true,
      description: "An ordinary untagged Newick or NEXUS tree with branch lengths.",
    },
  ],
  parameters: [
    {
      id: "backend",
      label: "Compute backend",
      description: "The all-clade message scan is CPU/SIMD-oriented and parallelizes over codon sites.",
      type: "select",
      default: "wasm-parallel",
      options: [
        { value: "wasm-parallel", label: "Parallel WASM (recommended)" },
        { value: "wasm", label: "Single-worker WASM" },
      ],
    },
    {
      id: "posteriorThreshold",
      label: "Shift posterior threshold",
      description: "A site is detected when the posterior probability of any persistent clade shift exceeds this value.",
      type: "number",
      default: 0.9,
      minimum: 0.5,
      maximum: 0.999,
      step: 0.01,
    },
    {
      id: "minimumDescendantTips",
      label: "Minimum clade size",
      description: "Candidate initiating branches must subtend at least this many tips. One includes terminal-branch shifts; two restricts the scan to multi-tip clades.",
      type: "integer",
      default: 1,
      minimum: 1,
      maximum: 100000,
      step: 1,
    },
    {
      id: "gridPoints",
      label: "Null grid points per axis",
      description: "FUBAR grid used for baseline alpha-beta uncertainty. Sixteen is a fast interactive default; twenty matches ordinary FUBAR.",
      type: "integer",
      default: 16,
      minimum: 8,
      maximum: 32,
      step: 1,
      advanced: true,
    },
    {
      id: "posteriorComponents",
      label: "Maximum null components",
      description: "Hard per-codon cap for adaptive FUBAR posterior compression. Increase it if the reported captured mass misses its target.",
      type: "integer",
      default: 96,
      minimum: 1,
      maximum: 256,
      step: 1,
      advanced: true,
    },
    {
      id: "posteriorMassTarget",
      label: "Null posterior mass target",
      description: "Retain highest-mass FUBAR categories until this target is reached or the component cap is exhausted. The actual mass is always reported.",
      type: "number",
      default: 0.9,
      minimum: 0.5,
      maximum: 1,
      step: 0.01,
      advanced: true,
    },
    {
      id: "intensityPreset",
      label: "Selection-intensity prior",
      description: "Fixed log-symmetric K states are integrated rather than optimized separately for every clade.",
      type: "select",
      default: "fast",
      options: [
        { value: "fast", label: "Fast · 4 K states" },
        { value: "thorough", label: "Thorough · 6 K states" },
      ],
      advanced: true,
    },
    {
      id: "shiftPrior",
      label: "Prior P(any clade shift)",
      description: "Prior mass for one persistent shift at a site; split equally between relaxation and intensification, then uniformly over eligible branches and K states.",
      type: "number",
      default: 0.2,
      minimum: 0.001,
      maximum: 0.95,
      step: 0.01,
      advanced: true,
    },
    {
      id: "inferenceIterations",
      label: "Null EM iterations",
      description: "Maximum Dirichlet-EM iterations for the baseline FUBAR mixture.",
      type: "integer",
      default: 1000,
      minimum: 100,
      maximum: 10000,
      step: 100,
      advanced: true,
    },
    {
      id: "concentration",
      label: "Null Dirichlet concentration",
      description: "Per-category FUBAR pseudocount used for the baseline empirical-Bayes mixture.",
      type: "number",
      default: 0.5,
      minimum: 0.001,
      maximum: 10,
      step: 0.1,
      advanced: true,
    },
    {
      id: "fitMode",
      label: "Global codon fit",
      description: "Empirical-fast is intended for interactive analysis.",
      type: "select",
      default: "empirical-fast",
      options: [
        { value: "empirical-fast", label: "Empirical fast" },
        { value: "reference-compatible", label: "Reference-compatible" },
      ],
      advanced: true,
    },
  ],
  runtimes: ["browser-wasm", "server-native"],
  outputKinds: ["site-shift-posterior", "initiating-branch-posterior", "annotated-tree", "structure-map", "csv"],
  citation: "Exploratory EvoOnline model; the omega^K intensity transform is motivated by Wertheim et al. (2015) RELAX, but CladeShift is a distinct unvalidated site-wise change-point scan.",
};

export function validateCladeShiftWorkspace(workspace: PhyloWorkspaceSnapshot): ModelValidation {
  const issues: ValidationIssue[] = [];
  let alignment;
  let tree;
  if (workspace.alignment === undefined) issues.push({ severity: "error", code: "ALIGNMENT_REQUIRED", message: "Load a codon alignment.", artifact: "alignment" });
  else {
    try { alignment = parseFasta(workspace.alignment.text); }
    catch (error) { issues.push({ severity: "error", code: "INVALID_ALIGNMENT", message: error instanceof Error ? error.message : String(error), artifact: "alignment" }); }
  }
  if (workspace.tree === undefined) issues.push({ severity: "error", code: "TREE_REQUIRED", message: "Upload or infer a phylogeny.", artifact: "tree" });
  else {
    try { tree = parseNewick(workspace.tree.text); }
    catch (error) { issues.push({ severity: "error", code: "INVALID_TREE", message: error instanceof Error ? error.message : String(error), artifact: "tree" }); }
  }
  if (alignment !== undefined && tree !== undefined) {
    const alignmentNames = new Set(alignment.names);
    const treeNames = new Set(tree.tips.map((tip) => tip.name));
    if (alignment.names.some((name) => !treeNames.has(name)) || tree.tips.some((tip) => !alignmentNames.has(tip.name))) {
      issues.push({ severity: "error", code: "TIP_NAME_MISMATCH", message: "Tree tips and FASTA identifiers do not match.", artifact: "tree" });
    }
  }
  return { ready: !issues.some((issue) => issue.severity === "error"), issues };
}

export const cladeShiftPlugin: ModelPlugin<CladeShiftAnalysisResult> = {
  manifest: cladeShiftManifest,
  prepareTreeInput: (text) => normalizeDifFubarTreeText(text).newick,
  validate: validateCladeShiftWorkspace,
  defaultParameters: () => defaultsFromManifest(cladeShiftManifest),
  createJob: (workspace, parameters): AnalysisJobSpec => ({
    schemaVersion: 1,
    model: { id: cladeShiftManifest.id, version: cladeShiftManifest.version },
    inputs: { alignmentSha256: workspace.alignment.sha256, treeSha256: workspace.tree.sha256 },
    parameters,
    requestedRuntime: "auto",
  }),
  resultToCsv: (result) => cladeShiftSitesToCsv(result.sites),
};

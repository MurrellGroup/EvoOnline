import type { PhyloWorkspaceSnapshot } from "@phylo-workbench/domain";
import {
  defaultsFromManifest,
  type AnalysisJobSpec,
  type ModelManifest,
  type ModelPlugin,
  type ModelValidation,
  type ValidationIssue,
} from "@phylo-workbench/model-sdk";
import { GENETIC_CODE_OPTIONS, normalizeDifFubarTreeText, parseFasta, parseNewick } from "@phylo-workbench/model-diffubar";
import { bsrelResultsToCsv } from "./pipeline.js";
import type { BsrelAnalysisResult } from "./types.js";

export const bsrelManifest: ModelManifest = {
  id: "bsrel",
  version: "0.1.0",
  title: "Branch-wise episodic selection with BS-REL",
  shortTitle: "BS-REL",
  description: "Test every selected branch with a fixed three-rate branch-site random-effects model. No AIC or adaptive complexity selection.",
  category: "selection",
  inputSlots: [
    { id: "alignment", label: "Codon alignment", kind: "alignment", required: true, description: "Aligned in-frame nucleotide FASTA." },
    { id: "tree", label: "Phylogeny", kind: "tree", required: true, description: "Untagged Newick or NEXUS tree with branch lengths." },
  ],
  parameters: [
    {
      id: "geneticCode",
      label: "Genetic code",
      description: "NCBI translation table used for sense-codon states, stop filtering, and synonymous/nonsynonymous changes.",
      type: "select",
      default: "1",
      options: GENETIC_CODE_OPTIONS,
    },
    {
      id: "backend",
      label: "Compute backend",
      description: "Parallel SIMD WASM evaluates codon sites across workers and is the recommended branch-test runtime.",
      type: "select",
      default: "wasm-parallel",
      options: [
        { value: "wasm-parallel", label: "Parallel WASM (recommended)" },
        { value: "wasm", label: "Single-worker WASM" },
        { value: "auto", label: "Automatic compatibility mode" },
      ],
    },
    {
      id: "branchScope",
      label: "Branches to test",
      description: "All branches share the fitted alternative; this controls which branch-specific nulls and multiplicity tests are run.",
      type: "select",
      default: "all",
      options: [
        { value: "all", label: "All branches" },
        { value: "internal", label: "Internal branches only" },
        { value: "terminal", label: "Terminal branches only" },
      ],
    },
    { id: "significanceThreshold", label: "Holm significance threshold", description: "Family-wise corrected threshold used for highlighting.", type: "number", default: 0.05, minimum: 0.001, maximum: 0.25, step: 0.005 },
    { id: "alternativeIterations", label: "Alternative optimizer steps", description: "Maximum joint L-BFGS steps across every branch mixture; it stops early on convergence.", type: "integer", default: 45, minimum: 2, maximum: 100, step: 1, advanced: true },
    { id: "nullIterations", label: "Local null optimizer rounds", description: "Batched coordinate rounds inside each branch's fixed two-sided message blanket.", type: "integer", default: 10, minimum: 2, maximum: 40, step: 1, advanced: true },
    { id: "maximumOmega", label: "Maximum positive omega", description: "Smooth upper bound for the positive rate class; 1000 retains strong episodic bursts.", type: "number", default: 1000, minimum: 5, maximum: 10000, step: 5, advanced: true },
    {
      id: "fitMode",
      label: "Global codon fit",
      description: "Empirical-fast is intended for interactive browser analyses.",
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
  outputKinds: ["branch-test-table", "annotated-phylogeny", "csv", "svg"],
  citation: "Kosakovsky Pond et al. (2011), A Random Effects Branch-Site Model for Detecting Episodic Diversifying Selection",
};

export function validateBsrelWorkspace(workspace: PhyloWorkspaceSnapshot): ModelValidation {
  const issues: ValidationIssue[] = [];
  let alignment;
  let tree;
  try {
    if (workspace.alignment === undefined) throw new Error("Load a codon alignment.");
    alignment = parseFasta(workspace.alignment.text);
  } catch (error) {
    issues.push({ severity: "error", code: "INVALID_ALIGNMENT", message: error instanceof Error ? error.message : String(error), artifact: "alignment" });
  }
  try {
    if (workspace.tree === undefined) throw new Error("Upload or infer a phylogeny.");
    tree = parseNewick(workspace.tree.text);
  } catch (error) {
    issues.push({ severity: "error", code: "INVALID_TREE", message: error instanceof Error ? error.message : String(error), artifact: "tree" });
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

export const bsrelPlugin: ModelPlugin<BsrelAnalysisResult> = {
  manifest: bsrelManifest,
  prepareTreeInput: (text) => normalizeDifFubarTreeText(text).newick.replaceAll(/\{[^}]+\}/g, ""),
  validate: validateBsrelWorkspace,
  defaultParameters: () => defaultsFromManifest(bsrelManifest),
  createJob: (workspace, parameters): AnalysisJobSpec => ({
    schemaVersion: 1,
    model: { id: bsrelManifest.id, version: bsrelManifest.version },
    inputs: { alignmentSha256: workspace.alignment.sha256, treeSha256: workspace.tree.sha256 },
    parameters,
    requestedRuntime: "auto",
  }),
  resultToCsv: bsrelResultsToCsv,
};

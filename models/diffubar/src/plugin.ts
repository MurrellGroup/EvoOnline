import type { PhyloWorkspaceSnapshot } from "@phylo-workbench/domain";
import {
  defaultsFromManifest,
  type AnalysisJobSpec,
  type ModelManifest,
  type ModelPlugin,
  type ModelValidation,
  type ParameterValues,
  type ValidationIssue,
} from "@phylo-workbench/model-sdk";
import { parseFasta } from "./io/fasta.js";
import { normalizeDifFubarTreeText, parseTaggedNewick } from "./io/newick.js";
import { resultsToCsv } from "./pipeline.js";
import type { AnalysisResult } from "./types.js";

export const difFubarManifest: ModelManifest = {
  id: "diffubar",
  version: "0.1.0",
  title: "Differential selection with DifFUBAR",
  shortTitle: "DifFUBAR",
  description: "Compare site-wise selective pressure between two tagged foreground branch groups.",
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
      description: "Newick or NEXUS tree with branch lengths.",
    },
    {
      id: "foreground",
      label: "Two foreground groups",
      kind: "selection",
      required: true,
      description: "Branches tagged as G1 and G2 in the phylogeny.",
    },
  ],
  parameters: [
    {
      id: "backend",
      label: "Compute backend",
      description: "Auto prefers WebGPU and falls back to parallel WASM.",
      type: "select",
      default: "auto",
      options: [
        { value: "auto", label: "Auto (recommended)" },
        { value: "webgpu", label: "WebGPU" },
        { value: "wasm-parallel", label: "Parallel WASM" },
        { value: "wasm", label: "Single-worker WASM" },
      ],
    },
    {
      id: "foregroundGrid",
      label: "Foreground grid",
      description: "Grid resolution for both tagged groups.",
      type: "integer",
      default: 6,
      minimum: 2,
      maximum: 12,
      step: 1,
    },
    {
      id: "backgroundGrid",
      label: "Background grid",
      description: "Grid resolution for untagged branches.",
      type: "integer",
      default: 4,
      minimum: 2,
      maximum: 10,
      step: 1,
    },
    {
      id: "iterations",
      label: "Gibbs iterations",
      description: "Total posterior sampling iterations.",
      type: "integer",
      default: 2500,
      minimum: 250,
      maximum: 100000,
      step: 250,
    },
    {
      id: "burnin",
      label: "Burn-in",
      description: "Initial Gibbs iterations discarded.",
      type: "integer",
      default: 500,
      minimum: 0,
      maximum: 50000,
      step: 100,
    },
    {
      id: "posteriorThreshold",
      label: "Posterior threshold",
      description: "Threshold used to mark detected codon sites.",
      type: "number",
      default: 0.95,
      minimum: 0.5,
      maximum: 0.999,
      step: 0.01,
    },
    {
      id: "seed",
      label: "Random seed",
      description: "Fixed seed for reproducible posterior sampling.",
      type: "integer",
      default: 1234,
      minimum: 1,
      maximum: 2147483647,
      step: 1,
      advanced: true,
    },
    {
      id: "fitMode",
      label: "Global fit",
      description: "Empirical-fast is the normal interactive mode.",
      type: "select",
      default: "empirical-fast",
      options: [
        { value: "empirical-fast", label: "Empirical fast" },
        { value: "reference-compatible", label: "Reference-compatible" },
      ],
      advanced: true,
    },
    {
      id: "samplerMode",
      label: "Sampler",
      description: "Fast-exact preserves the uncollapsed posterior with rejection draws.",
      type: "select",
      default: "fast-exact",
      options: [
        { value: "fast-exact", label: "Fast exact" },
        { value: "reference", label: "Reference transition" },
        { value: "collapsed", label: "Collapsed" },
      ],
      advanced: true,
    },
  ],
  runtimes: ["browser-webgpu", "browser-wasm", "server-native"],
  outputKinds: ["site-posterior-table", "detected-site-set", "csv"],
  citation: "Murrell et al., DifFUBAR preprint (2025)",
};

export function validateDifFubarWorkspace(workspace: PhyloWorkspaceSnapshot): ModelValidation {
  const issues: ValidationIssue[] = [];
  let alignment;
  let tree;
  if (workspace.alignment === undefined) {
    issues.push({ severity: "error", code: "ALIGNMENT_REQUIRED", message: "Load a codon alignment.", artifact: "alignment" });
  } else {
    try {
      alignment = parseFasta(workspace.alignment.text);
    } catch (error) {
      issues.push({
        severity: "error",
        code: error instanceof Error && "code" in error ? String(error.code) : "INVALID_ALIGNMENT",
        message: error instanceof Error ? error.message : String(error),
        artifact: "alignment",
      });
    }
  }
  if (workspace.tree === undefined) {
    issues.push({ severity: "error", code: "TREE_REQUIRED", message: "Upload or infer a phylogeny.", artifact: "tree" });
  } else {
    try {
      tree = parseTaggedNewick(workspace.tree.text);
    } catch (error) {
      issues.push({
        severity: "error",
        code: error instanceof Error && "code" in error ? String(error.code) : "INVALID_TREE",
        message: error instanceof Error ? error.message : String(error),
        artifact: workspace.tree.tags.length === 2 ? "tree" : "foreground",
      });
    }
  }
  if (alignment !== undefined && tree !== undefined) {
    const alignmentNames = new Set(alignment.names);
    const treeNames = new Set(tree.tips.map((tip) => tip.name));
    const absentFromTree = alignment.names.filter((name) => !treeNames.has(name));
    const absentFromAlignment = tree.tips.map((tip) => tip.name).filter((name) => !alignmentNames.has(name));
    if (absentFromTree.length > 0 || absentFromAlignment.length > 0) {
      const examples = [...absentFromTree.slice(0, 2), ...absentFromAlignment.slice(0, 2)].join(", ");
      issues.push({
        severity: "error",
        code: "TIP_NAME_MISMATCH",
        message: `Tree tips and FASTA identifiers do not match${examples.length > 0 ? ` (${examples})` : ""}.`,
        artifact: "tree",
      });
    }
  }
  return { ready: !issues.some((issue) => issue.severity === "error"), issues };
}

export const difFubarPlugin: ModelPlugin<AnalysisResult> = {
  manifest: difFubarManifest,
  prepareTreeInput: (text) => normalizeDifFubarTreeText(text).newick,
  validate: validateDifFubarWorkspace,
  defaultParameters: () => defaultsFromManifest(difFubarManifest),
  createJob: (workspace, parameters): AnalysisJobSpec => ({
    schemaVersion: 1,
    model: { id: difFubarManifest.id, version: difFubarManifest.version },
    inputs: {
      alignmentSha256: workspace.alignment.sha256,
      treeSha256: workspace.tree.sha256,
    },
    parameters,
    seed: Number(parameters.seed ?? 1234),
    requestedRuntime: "auto",
  }),
  resultToCsv: resultsToCsv,
};

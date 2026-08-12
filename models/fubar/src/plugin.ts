import type { PhyloWorkspaceSnapshot } from "@phylo-workbench/domain";
import {
  defaultsFromManifest,
  type AnalysisJobSpec,
  type ModelManifest,
  type ModelPlugin,
  type ModelValidation,
  type ValidationIssue,
} from "@phylo-workbench/model-sdk";
import {
  normalizeDifFubarTreeText,
  GENETIC_CODE_OPTIONS,
  parseFasta,
  parseNewick,
} from "@phylo-workbench/model-diffubar";
import { fubarResultsToCsv } from "./pipeline.js";
import type { FubarAnalysisResult } from "./types.js";

export const fubarManifest: ModelManifest = {
  id: "fubar",
  version: "0.2.0",
  title: "Pervasive selection with FUBAR",
  shortTitle: "FUBAR",
  description: "Infer site-wise positive and purifying selection from a single branch-class codon model.",
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
      description: "An untagged Newick or NEXUS tree with branch lengths.",
    },
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
      description: "Parallel WASM is fastest on many desktop CPUs; WebGPU remains available explicitly.",
      type: "select",
      default: "wasm-parallel",
      options: [
        { value: "wasm-parallel", label: "Parallel WASM (recommended)" },
        { value: "webgpu", label: "WebGPU (experimental)" },
        { value: "wasm", label: "Single-worker WASM" },
        { value: "auto", label: "Automatic compatibility mode" },
      ],
    },
    {
      id: "gridPoints",
      label: "Grid points per axis",
      description: "CodonMolecularEvolution.jl uses 20, producing 400 alpha-beta categories.",
      type: "integer",
      default: 20,
      minimum: 8,
      maximum: 40,
      step: 1,
    },
    {
      id: "approximateFel",
      label: "Also calculate approximate FEL",
      description: "Optional frequentist LRT from the same conditional likelihood grid. Its results stay separate from the FUBAR posterior.",
      type: "boolean",
      default: false,
    },
    {
      id: "inferenceMethod",
      label: "Posterior inference",
      description: "Dirichlet-EM is deterministic and remains the default; Gibbs provides exact allocation sampling.",
      type: "select",
      default: "dirichlet-em",
      options: [
        { value: "dirichlet-em", label: "Dirichlet-EM (default)" },
        { value: "gibbs", label: "Exact Gibbs sampling" },
      ],
    },
    {
      id: "posteriorThreshold",
      label: "Posterior threshold",
      description: "Threshold applied to both positive and purifying selection evidence.",
      type: "number",
      default: 0.95,
      minimum: 0.5,
      maximum: 0.999,
      step: 0.01,
    },
    {
      id: "iterations",
      label: "Inference iterations",
      description: "Maximum EM steps, or total Gibbs iterations when Gibbs is selected.",
      type: "integer",
      default: 2500,
      minimum: 100,
      maximum: 100000,
      step: 100,
      advanced: true,
    },
    {
      id: "burnin",
      label: "Gibbs burn-in",
      description: "Initial Gibbs iterations discarded; ignored by Dirichlet-EM.",
      type: "integer",
      default: 500,
      minimum: 0,
      maximum: 50000,
      step: 100,
      advanced: true,
    },
    {
      id: "concentration",
      label: "Dirichlet concentration",
      description: "Per-category pseudocount used by CodonMolecularEvolution DirichletFUBAR.",
      type: "number",
      default: 0.5,
      minimum: 0.001,
      maximum: 10,
      step: 0.1,
      advanced: true,
    },
    {
      id: "seed",
      label: "Gibbs random seed",
      description: "Fixed seed for reproducible Gibbs sampling; ignored by Dirichlet-EM.",
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
  ],
  runtimes: ["browser-webgpu", "browser-wasm", "server-native"],
  outputKinds: ["site-posterior-table", "posterior-surface", "detected-site-set", "conditional-likelihood-surface", "csv"],
  citation: "Murrell et al., FUBAR; implementation follows CodonMolecularEvolution.jl DirichletFUBAR and optional FIFEFUBAR",
};

export function validateFubarWorkspace(workspace: PhyloWorkspaceSnapshot): ModelValidation {
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
      tree = parseNewick(workspace.tree.text);
    } catch (error) {
      issues.push({
        severity: "error",
        code: error instanceof Error && "code" in error ? String(error.code) : "INVALID_TREE",
        message: error instanceof Error ? error.message : String(error),
        artifact: "tree",
      });
    }
  }
  if (alignment !== undefined && tree !== undefined) {
    const alignmentNames = new Set(alignment.names);
    const treeNames = new Set(tree.tips.map((tip) => tip.name));
    const mismatch = alignment.names.some((name) => !treeNames.has(name))
      || tree.tips.some((tip) => !alignmentNames.has(tip.name));
    if (mismatch) issues.push({
      severity: "error",
      code: "TIP_NAME_MISMATCH",
      message: "Tree tips and FASTA identifiers do not match.",
      artifact: "tree",
    });
  }
  return { ready: !issues.some((issue) => issue.severity === "error"), issues };
}

export const fubarPlugin: ModelPlugin<FubarAnalysisResult> = {
  manifest: fubarManifest,
  prepareTreeInput: (text) => normalizeDifFubarTreeText(text).newick,
  validate: validateFubarWorkspace,
  defaultParameters: () => defaultsFromManifest(fubarManifest),
  createJob: (workspace, parameters): AnalysisJobSpec => ({
    schemaVersion: 1,
    model: { id: fubarManifest.id, version: fubarManifest.version },
    inputs: {
      alignmentSha256: workspace.alignment.sha256,
      treeSha256: workspace.tree.sha256,
    },
    parameters,
    requestedRuntime: "auto",
  }),
  resultToCsv: fubarResultsToCsv,
};

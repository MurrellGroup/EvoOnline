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
import { fameResultsToCsv, flavorResultsToCsv } from "./pipeline.js";
import type { FameAnalysisResult, FlavorAnalysisResult } from "./types.js";

const commonParameters: ModelManifest["parameters"] = [
  {
    id: "backend",
    label: "Compute backend",
    description: "Parallel f64 WASM is the optimized branch-mixture engine; single-worker mode is useful for diagnostics.",
    type: "select",
    default: "wasm-parallel",
    options: [
      { value: "wasm-parallel", label: "Parallel WASM (recommended)" },
      { value: "wasm", label: "Single-worker WASM" },
      { value: "auto", label: "Automatic compatibility mode" },
    ],
  },
  {
    id: "inferenceMethod",
    label: "Posterior inference",
    description: "Dirichlet-EM matches the operative Julia draft path; Gibbs is an additional exact allocation sampler.",
    type: "select",
    default: "dirichlet-em",
    options: [
      { value: "dirichlet-em", label: "Dirichlet-EM (default)" },
      { value: "gibbs", label: "Exact Gibbs sampling" },
    ],
  },
  {
    id: "posteriorThreshold",
    label: "Positive posterior threshold",
    description: "The draft FAME/FLAVOR reporting threshold is 0.90.",
    type: "number",
    default: 0.9,
    minimum: 0.5,
    maximum: 0.999,
    step: 0.01,
  },
  {
    id: "iterations",
    label: "Inference iterations",
    description: "Maximum EM steps, or total Gibbs iterations.",
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
    description: "Per-category pseudocount; the development branch uses 0.1.",
    type: "number",
    default: 0.1,
    minimum: 0.001,
    maximum: 10,
    step: 0.05,
    advanced: true,
  },
  {
    id: "seed",
    label: "Gibbs random seed",
    description: "Ignored by Dirichlet-EM.",
    type: "integer",
    default: 1234,
    minimum: 1,
    maximum: 2147483647,
    step: 1,
    advanced: true,
  },
  {
    id: "gridPreset",
    label: "Rate grid",
    description: "Fast uses an 8-ish-point transformed grid per axis. Julia draft restores all 3,375 FAME / 6,720 FLAVOR categories and is much slower.",
    type: "select",
    default: "fast",
    options: [
      { value: "fast", label: "Fast interactive (recommended)" },
      { value: "julia-draft", label: "Full Julia-draft grid" },
    ],
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
];

const commonInputs: ModelManifest["inputSlots"] = [
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
];

export const fameManifest: ModelManifest = {
  id: "fame",
  version: "0.1.0-dev-port",
  title: "Episodic selection with FAME",
  shortTitle: "FAME",
  description: "Experimental site-wise branch-mixture model with a purifying/neutral ω component and a second component that may exceed one.",
  category: "selection",
  inputSlots: commonInputs,
  parameters: [
    {
      id: "weightIntegration",
      label: "Branch-mixture weight integration",
      description: "Likelihood quadrature is statistically valid and faster. Julia-draft mode exactly retains its arithmetic mean of log likelihoods for reproduction.",
      type: "select",
      default: "likelihood-quadrature",
      options: [
        { value: "likelihood-quadrature", label: "Likelihood quadrature (recommended)" },
        { value: "julia-draft-log-average", label: "Julia draft compatibility" },
      ],
    },
    ...commonParameters,
    {
      id: "quadraturePoints",
      label: "Likelihood quadrature points",
      description: "Gauss-Legendre nodes on the mixture-weight interval; 4 is the interactive accuracy/speed default.",
      type: "integer",
      default: 4,
      minimum: 2,
      maximum: 32,
      step: 1,
      advanced: true,
    },
    {
      id: "draftWeightPoints",
      label: "Julia-draft weight points",
      description: "The source uses 20 equally spaced values including both endpoints.",
      type: "integer",
      default: 20,
      minimum: 2,
      maximum: 64,
      step: 1,
      advanced: true,
    },
  ],
  runtimes: ["browser-wasm", "server-native"],
  outputKinds: ["site-posterior-table", "posterior-surface", "detected-site-set", "csv"],
  citation: "Experimental FAME implementation, CodonMolecularEvolution.jl MixtureModels branch at 4c65c984",
};

export const flavorManifest: ModelManifest = {
  id: "flavor",
  version: "0.1.0-dev-port",
  title: "Episodic selection with FLAVOR",
  shortTitle: "FLAVOR",
  description: "Experimental site-wise Gamma distribution of branch ω values, contrasted with a distribution capped at ω=1.",
  category: "selection",
  inputSlots: commonInputs,
  parameters: [
    {
      id: "transitionEngine",
      label: "Transition matrices",
      description: "Julia-style interpolation shares one 50-node transition table across every alpha value, branch, and site for each Gamma distribution. Direct uniformization is the slower no-interpolation accuracy reference.",
      type: "select",
      default: "julia-interpolated",
      options: [
        { value: "julia-interpolated", label: "Julia-style interpolated (recommended)" },
        { value: "direct-uniformization", label: "Direct uniformization reference" },
      ],
    },
    ...commonParameters,
    {
      id: "gammaSlices",
      label: "Discrete Gamma slices",
      description: "Mid-quantile approximation to the branch-wise ω distribution; fast mode defaults to 12, while the development branch uses 20.",
      type: "integer",
      default: 12,
      minimum: 8,
      maximum: 40,
      step: 2,
      advanced: true,
    },
  ],
  runtimes: ["browser-wasm", "server-native"],
  outputKinds: ["site-posterior-table", "posterior-surface", "detected-site-set", "csv"],
  citation: "Experimental FLAVOR implementation, CodonMolecularEvolution.jl MixtureModels branch at 4c65c984",
};

export function validateBameWorkspace(workspace: PhyloWorkspaceSnapshot): ModelValidation {
  const issues: ValidationIssue[] = [];
  let alignment;
  let tree;
  if (workspace.alignment === undefined) issues.push({ severity: "error", code: "ALIGNMENT_REQUIRED", message: "Load a codon alignment.", artifact: "alignment" });
  else {
    try { alignment = parseFasta(workspace.alignment.text); }
    catch (error) {
      issues.push({ severity: "error", code: error instanceof Error && "code" in error ? String(error.code) : "INVALID_ALIGNMENT", message: error instanceof Error ? error.message : String(error), artifact: "alignment" });
    }
  }
  if (workspace.tree === undefined) issues.push({ severity: "error", code: "TREE_REQUIRED", message: "Upload or infer a phylogeny.", artifact: "tree" });
  else {
    try { tree = parseNewick(workspace.tree.text); }
    catch (error) {
      issues.push({ severity: "error", code: error instanceof Error && "code" in error ? String(error.code) : "INVALID_TREE", message: error instanceof Error ? error.message : String(error), artifact: "tree" });
    }
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

function createPlugin<R>(manifest: ModelManifest, resultToCsv: (result: R) => string): ModelPlugin<R> {
  return {
    manifest,
    prepareTreeInput: (text) => normalizeDifFubarTreeText(text).newick,
    validate: validateBameWorkspace,
    defaultParameters: () => defaultsFromManifest(manifest),
    createJob: (workspace, parameters): AnalysisJobSpec => ({
      schemaVersion: 1,
      model: { id: manifest.id, version: manifest.version },
      inputs: { alignmentSha256: workspace.alignment.sha256, treeSha256: workspace.tree.sha256 },
      parameters,
      requestedRuntime: "auto",
    }),
    resultToCsv,
  };
}

export const famePlugin = createPlugin<FameAnalysisResult>(fameManifest, fameResultsToCsv);
export const flavorPlugin = createPlugin<FlavorAnalysisResult>(flavorManifest, flavorResultsToCsv);

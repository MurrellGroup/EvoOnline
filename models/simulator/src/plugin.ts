import type { PhyloWorkspaceSnapshot } from "@phylo-workbench/domain";
import type { AnalysisJobSpec, ModelManifest, ModelPlugin, ModelValidation } from "@phylo-workbench/model-sdk";
import { DEFAULT_SIMULATOR_CONFIG, encodeSimulatorConfig } from "./config.js";
import type { SimulatorAnalysisResult } from "./types.js";

export const simulatorManifest: ModelManifest = {
  id: "simulator",
  version: "0.1.0",
  title: "Evolutionary dataset simulator",
  shortTitle: "Simulators",
  description: "Design time-varying sampled coalescent genealogies, evolve codons under MG94 or SCUFF, and optionally add branch-interior ancestral recombination with hidden parental lineages.",
  category: "utility",
  inputSlots: [],
  parameters: [],
  runtimes: ["browser-wasm"],
  outputKinds: ["time-tree", "fasta", "newick", "local-tree-truth", "recombination-events", "scuff-diagnostics", "batch-datasets"],
  citation: "SCUFF follows the Halpern–Bruno codon process with piecewise OU amino-acid fitness described by Sadiq et al.; genealogy simulation uses a heterochronous Kingman coalescent with independently specified sampling intensity.",
};

export function validateSimulatorWorkspace(_workspace: PhyloWorkspaceSnapshot): ModelValidation {
  return { ready: true, issues: [] };
}

export const simulatorPlugin: ModelPlugin<SimulatorAnalysisResult> = {
  manifest: simulatorManifest,
  validate: validateSimulatorWorkspace,
  defaultParameters: () => ({ simulatorConfig: encodeSimulatorConfig(DEFAULT_SIMULATOR_CONFIG) }),
  createJob: (_workspace, parameters): AnalysisJobSpec => ({
    schemaVersion: 1,
    model: { id: simulatorManifest.id, version: simulatorManifest.version },
    inputs: { alignmentSha256: "generated-in-browser" },
    parameters,
    seed: DEFAULT_SIMULATOR_CONFIG.seed,
    requestedRuntime: "browser-wasm",
  }),
};

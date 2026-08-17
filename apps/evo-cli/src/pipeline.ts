import { famePlugin, flavorPlugin, globalGammaPlugin } from "@phylo-workbench/model-bame";
import { bsrelPlugin } from "@phylo-workbench/model-bsrel";
import { cladeShiftPlugin } from "@phylo-workbench/model-cladeshift";
import { difFubarPlugin } from "@phylo-workbench/model-diffubar";
import { fsartPlugin } from "@phylo-workbench/model-fsart";
import { fubarPlugin } from "@phylo-workbench/model-fubar";
import { jemsprPlugin } from "@phylo-workbench/model-jemspr";
import { mosaicSprPlugin } from "@phylo-workbench/model-mosaicspr";
import { decodeSimulatorConfig, simulatorPlugin } from "@phylo-workbench/model-simulator";
import type { ModelPlugin, ParameterValues } from "@phylo-workbench/model-sdk";

export const PIPELINE_SCHEMA_VERSION = 1 as const;
export type PipelineNodeKind = "fasttree" | "user-trees" | "true-tree" | "model";
export type PipelineStage = "input" | "source" | "selection";
export type SourceOutputKind = "inferred-tree" | "user-tree" | "regional-trees" | "simulation-truth";

export interface PipelineNode {
  readonly id: string;
  readonly kind: PipelineNodeKind;
  readonly modelId?: string;
  readonly parameters: ParameterValues;
}

export interface PipelineExecution {
  /** Maximum logical CPUs used by the CLI. Browser exports may omit this. */
  readonly maxCpus?: number;
}

export interface MethodVisualizationSettings {
  /** Generic posterior call threshold used by posterior-based methods. */
  readonly posteriorThreshold?: number;
  /** FUBAR positive-selection threshold; falls back to posteriorThreshold. */
  readonly positivePosteriorThreshold?: number;
  /** FUBAR purifying-selection threshold; falls back to posteriorThreshold. */
  readonly purifyingPosteriorThreshold?: number;
  /** Corrected p-value threshold used by branch tests such as BS-REL. */
  readonly significanceThreshold?: number;
  /** Bayes-factor call threshold for evidence-based summaries. */
  readonly bayesFactorThreshold?: number;
  /** Metric identifier selected for the method in comparison plots. */
  readonly siteMetric?: string;
  /** Maximum detected sites drawn in a posterior-distribution plot. */
  readonly maxSitesPerPlot?: number;
}

export interface PipelineVisualization {
  /** Defaults applied to every instance of a method, keyed by method id. */
  readonly methods?: Readonly<Record<string, MethodVisualizationSettings>>;
  /** Per-component overrides, keyed by the pipeline component id. */
  readonly nodes?: Readonly<Record<string, MethodVisualizationSettings>>;
}

export interface PipelineDefinition {
  readonly schemaVersion: typeof PIPELINE_SCHEMA_VERSION;
  readonly id: string;
  readonly name: string;
  readonly nodes: readonly PipelineNode[];
  readonly execution?: PipelineExecution;
  readonly visualization?: PipelineVisualization;
}

const plugins = [
  difFubarPlugin,
  fubarPlugin,
  bsrelPlugin,
  famePlugin,
  flavorPlugin,
  globalGammaPlugin,
  cladeShiftPlugin,
  fsartPlugin,
  mosaicSprPlugin,
  jemsprPlugin,
  simulatorPlugin,
] as readonly ModelPlugin<unknown>[];

export const pluginById = new Map(plugins.map((plugin) => [plugin.manifest.id, plugin]));
export const recombinationModelIds = new Set(["fsart", "mosaic-spr", "jemspr"]);
export const acceptedSourceKinds: Readonly<Record<string, readonly SourceOutputKind[]>> = {
  diffubar: ["user-tree"],
  fubar: ["inferred-tree", "user-tree", "regional-trees", "simulation-truth"],
  bsrel: ["inferred-tree", "user-tree", "simulation-truth"],
  fame: ["inferred-tree", "user-tree", "regional-trees", "simulation-truth"],
  flavor: ["inferred-tree", "user-tree", "regional-trees", "simulation-truth"],
  glamma: ["inferred-tree", "user-tree", "simulation-truth"],
  "clade-shift": ["inferred-tree", "user-tree", "simulation-truth"],
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parameterValues(value: unknown): value is ParameterValues {
  return record(value) && Object.values(value).every((entry) =>
    typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean");
}

const VISUALIZATION_NUMBER_KEYS = new Set([
  "posteriorThreshold",
  "positivePosteriorThreshold",
  "purifyingPosteriorThreshold",
  "significanceThreshold",
  "bayesFactorThreshold",
  "maxSitesPerPlot",
]);

function visualizationSettings(value: unknown, label: string): MethodVisualizationSettings {
  if (!record(value)) throw new Error(`${label} must be an object.`);
  const output: Record<string, number | string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (VISUALIZATION_NUMBER_KEYS.has(key)) {
      if (typeof entry !== "number" || !Number.isFinite(entry)) throw new Error(`${label}.${key} must be a finite number.`);
      if (key === "maxSitesPerPlot") {
        if (!Number.isInteger(entry) || entry < 1) throw new Error(`${label}.${key} must be a positive integer.`);
      } else if (key === "bayesFactorThreshold") {
        if (!(entry > 0)) throw new Error(`${label}.${key} must be greater than zero.`);
      } else if (!(entry >= 0 && entry <= 1)) throw new Error(`${label}.${key} must be between zero and one.`);
      output[key] = entry;
      continue;
    }
    if (key === "siteMetric") {
      if (typeof entry !== "string" || entry.trim().length === 0) throw new Error(`${label}.siteMetric must be a non-empty metric identifier.`);
      output[key] = entry;
      continue;
    }
    throw new Error(`${label} contains unknown visualization setting '${key}'.`);
  }
  return output;
}

function visualizationMap(value: unknown, label: string): Readonly<Record<string, MethodVisualizationSettings>> | undefined {
  if (value === undefined) return undefined;
  if (!record(value)) throw new Error(`${label} must be an object keyed by method or component id.`);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, visualizationSettings(entry, `${label}.${key}`)]));
}

function parseVisualization(value: unknown): PipelineVisualization | undefined {
  if (value === undefined) return undefined;
  if (!record(value)) throw new Error("Pipeline visualization must be an object.");
  for (const key of Object.keys(value)) if (key !== "methods" && key !== "nodes") throw new Error(`Pipeline visualization contains unknown section '${key}'.`);
  const methods = visualizationMap(value.methods, "visualization.methods");
  const nodes = visualizationMap(value.nodes, "visualization.nodes");
  return { ...(methods === undefined ? {} : { methods }), ...(nodes === undefined ? {} : { nodes }) };
}

function parseExecution(value: unknown): PipelineExecution | undefined {
  if (value === undefined) return undefined;
  if (!record(value)) throw new Error("Pipeline execution must be an object.");
  for (const key of Object.keys(value)) if (key !== "maxCpus") throw new Error(`Pipeline execution contains unknown setting '${key}'.`);
  if (value.maxCpus === undefined) return {};
  if (typeof value.maxCpus !== "number" || !Number.isInteger(value.maxCpus) || value.maxCpus < 1) throw new Error("execution.maxCpus must be a positive integer.");
  return { maxCpus: value.maxCpus };
}

export function parsePipelineDefinition(text: string): PipelineDefinition {
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch (error) { throw new Error(`Pipeline configuration is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  if (!record(parsed) || parsed.schemaVersion !== PIPELINE_SCHEMA_VERSION || typeof parsed.id !== "string" || typeof parsed.name !== "string" || !Array.isArray(parsed.nodes)) {
    throw new Error("This is not an EvoOnline pipeline definition (schema version 1).");
  }
  const nodes = parsed.nodes.map((value, index): PipelineNode => {
    if (!record(value) || typeof value.id !== "string" || !["fasttree", "user-trees", "true-tree", "model"].includes(String(value.kind)) || !parameterValues(value.parameters)) {
      throw new Error(`Pipeline component ${index + 1} is invalid.`);
    }
    if (value.kind === "model" && typeof value.modelId !== "string") throw new Error(`Pipeline component ${index + 1} has no method identifier.`);
    return {
      id: value.id,
      kind: value.kind as PipelineNodeKind,
      ...(typeof value.modelId === "string" ? { modelId: value.modelId } : {}),
      parameters: value.parameters,
    };
  });
  const execution = parseExecution(parsed.execution);
  const visualization = parseVisualization(parsed.visualization);
  return normalizePipeline({
    schemaVersion: PIPELINE_SCHEMA_VERSION,
    id: parsed.id,
    name: parsed.name,
    nodes,
    ...(execution === undefined ? {} : { execution }),
    ...(visualization === undefined ? {} : { visualization }),
  });
}

export function nodeStage(node: PipelineNode): PipelineStage | undefined {
  if (node.kind === "model" && node.modelId === "simulator") return "input";
  if (node.kind === "fasttree" || node.kind === "user-trees" || node.kind === "true-tree") return "source";
  if (node.modelId !== undefined && recombinationModelIds.has(node.modelId)) return "source";
  if (node.modelId !== undefined && node.modelId in acceptedSourceKinds) return "selection";
  return undefined;
}

export function sourceOutputKind(node: PipelineNode): SourceOutputKind | undefined {
  if (node.kind === "fasttree") return "inferred-tree";
  if (node.kind === "user-trees") return "user-tree";
  if (node.kind === "true-tree") return "simulation-truth";
  return node.modelId !== undefined && recombinationModelIds.has(node.modelId) ? "regional-trees" : undefined;
}

export function nodesCompatible(source: PipelineNode, target: PipelineNode): boolean {
  const output = sourceOutputKind(source);
  return output !== undefined && target.modelId !== undefined && (acceptedSourceKinds[target.modelId] ?? []).includes(output);
}

export function simulatorHasRecombination(nodes: readonly PipelineNode[]): boolean {
  const simulator = nodes.find((node) => node.modelId === "simulator");
  if (simulator === undefined) return false;
  return decodeSimulatorConfig(simulator.parameters.simulatorConfig).recombination.enabled;
}

export function compatibleSources(target: PipelineNode, nodes: readonly PipelineNode[]): readonly PipelineNode[] {
  const compatible = nodes.filter((source) => nodeStage(source) === "source" && nodesCompatible(source, target));
  if (!simulatorHasRecombination(nodes)) return compatible;
  return compatible.filter((source) => source.kind !== "true-tree" || (target.modelId !== undefined && (acceptedSourceKinds[target.modelId] ?? []).includes("regional-trees")));
}

function stageRank(node: PipelineNode): number {
  const stage = nodeStage(node);
  return stage === "input" ? 0 : stage === "source" ? 1 : stage === "selection" ? 2 : 3;
}

export function normalizePipeline(definition: PipelineDefinition): PipelineDefinition {
  const normalized = definition.nodes.map((node): PipelineNode => {
    if (node.kind === "fasttree") return { id: node.id, kind: node.kind, parameters: { model: "gtr", fastest: false, ...node.parameters } };
    if (node.kind === "user-trees" || node.kind === "true-tree") return { id: node.id, kind: node.kind, parameters: {} };
    const modelId = node.modelId;
    if (modelId === undefined) throw new Error("A model pipeline component has no method identifier.");
    const plugin = pluginById.get(modelId);
    if (plugin === undefined) throw new Error(`Pipeline method '${modelId}' is not available in evo-cli.`);
    return { id: node.id, kind: "model", modelId, parameters: { ...plugin.defaultParameters(), ...node.parameters } };
  });
  const sorted = normalized.map((node, index) => ({ node, index })).sort((left, right) => stageRank(left.node) - stageRank(right.node) || left.index - right.index).map(({ node }) => node);
  validateTopology(sorted);
  return { ...definition, name: definition.name.trim() || "Untitled pipeline", nodes: sorted };
}

export function validateTopology(nodes: readonly PipelineNode[]): void {
  const errors: string[] = [];
  const identifiers = new Set<string>();
  for (const node of nodes) {
    if (identifiers.has(node.id)) errors.push(`Pipeline component identifier '${node.id}' is duplicated.`);
    identifiers.add(node.id);
  }
  const simulators = nodes.filter((node) => node.modelId === "simulator");
  const trueTrees = nodes.filter((node) => node.kind === "true-tree");
  if (simulators.length > 1) errors.push("A pipeline can contain only one Simulator input.");
  if (trueTrees.length > 1) errors.push("A pipeline can contain only one True tree source.");
  if (trueTrees.length > 0 && simulators.length === 0) errors.push("True tree requires a Simulator input.");
  if (simulators.length > 0 && nodes.some((node) => node.kind === "user-trees")) errors.push("User trees cannot be used with Simulator input; use True tree.");
  for (const node of nodes) {
    const stage = nodeStage(node);
    if (stage === undefined) errors.push(`Component '${node.id}' has no declared pipeline contract.`);
    if (stage === "selection" && compatibleSources(node, nodes).length === 0) errors.push(`${node.modelId ?? node.id} has no compatible tree-producing source.`);
  }
  if (errors.length > 0) throw new Error([...new Set(errors)].join(" "));
}

export function methodLabel(node: PipelineNode): string {
  if (node.kind === "fasttree") return "FastTree";
  if (node.kind === "user-trees") return "User trees";
  if (node.kind === "true-tree") return "True tree";
  return node.modelId === undefined ? node.id : pluginById.get(node.modelId)?.manifest.shortTitle ?? node.modelId;
}

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import {
  createAlignmentArtifact,
  createTreeArtifact,
  type AlignmentArtifact,
  type TreeArtifact,
} from "@phylo-workbench/domain";
import type { ModelParameter, ParameterValues } from "@phylo-workbench/model-sdk";
import type { RecombinationCodonTreeSet } from "@phylo-workbench/model-diffubar/browser-source";
import type { FsartAnalysisResult } from "@phylo-workbench/model-fsart/browser-source";
import type { MosaicSprAnalysisResult } from "@phylo-workbench/model-mosaicspr/browser-source";
import type { JemsprAnalysisResult } from "@phylo-workbench/model-jemspr/browser-source";
import {
  decodeSimulatorConfig,
  type SimulatedDataset,
  type SimulatorAnalysisResult,
} from "@phylo-workbench/model-simulator/browser-source";
import type { WidgetBridge } from "@phylo-workbench/viewer-bridge";
import {
  getRegisteredModel,
  modelRegistry,
  type BrowserExecutorServices,
  type BrowserModelExecutor,
} from "../model-registry.js";
import { PipelineComparisonStudio } from "./PipelineComparisonStudio.js";
import { SimulatorSetup } from "./simulator/SimulatorSetup.js";
import { saveAnalysis, type SavedAnalysis } from "../lib/analysis-store.js";
import { downloadText } from "../lib/file-download.js";
import type { PipelineComparisonRecord } from "../lib/pipeline-comparison.js";
import {
  createFsartRecombinationBundle,
  createJemsprRecombinationBundle,
  createMosaicSprRecombinationBundle,
  createSimulationTruthRecombinationBundle,
  type EvoOnlineRecombinationTreeBundle,
} from "../lib/recombination-bundle.js";
import {
  createFsartCodonTreeSet,
  createJemsprCodonTreeSet,
  createMosaicSprCodonTreeSet,
} from "../lib/recombination-handoff.js";
import {
  PIPELINE_ADD_EVENT,
  PIPELINE_DRAG_TYPE,
  PIPELINE_SCHEMA_VERSION,
  PIPELINE_STORAGE_KEY,
  compatiblePipelineSources,
  createPipelineId,
  decodePipelineShare,
  encodePipelineShare,
  isPipelineAlignmentFile,
  isPipelineTreeFile,
  matchPipelineTrees,
  parsePipelineDefinition,
  pipelineAcceptedSourceKinds,
  pipelineFilePath,
  pipelineNodeStage,
  pipelineSourceOutputKind,
  sortPipelineNodes,
  stringifyPipelineDefinition,
  type PipelineDefinition,
  type PipelineNode,
  type PipelineNodeKind,
  type PipelineSourceOutputKind,
  type TreeMatch,
} from "../lib/pipeline.js";

const DATA_NODE_ID = "pipeline-data-upload";
const FILE_ACCEPT = ".fa,.fas,.fasta,.fna,.ffn,.aln,.nwk,.newick,.tree,.tre,.nex,.nexus";

interface PipelineBuilderProps {
  readonly alignmentBridge?: WidgetBridge;
  readonly executorServices: BrowserExecutorServices;
  readonly onAnalysesCompleted: (analyses: readonly SavedAnalysis[]) => void;
}

interface PairingReportRow {
  readonly alignment: string;
  readonly status: "matched" | "missing" | "ambiguous";
  readonly tree?: string;
  readonly candidates: readonly string[];
}

interface PipelineLogEntry {
  readonly id: string;
  readonly dataset: string;
  readonly component: string;
  readonly tone: "running" | "complete" | "error" | "info";
  readonly detail: string;
}

interface LegacyFileSystemEntry {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly name: string;
  readonly fullPath: string;
  file?(success: (file: File) => void, failure?: (error: DOMException) => void): void;
  createReader?(): { readEntries(success: (entries: readonly LegacyFileSystemEntry[]) => void, failure?: (error: DOMException) => void): void };
}

interface RecombinationOutput {
  readonly treeSet: RecombinationCodonTreeSet;
  readonly bundle: EvoOnlineRecombinationTreeBundle;
}

interface PipelineSourceProduct {
  readonly node: PipelineNode;
  readonly outputKind: PipelineSourceOutputKind;
  readonly tree: TreeArtifact;
  readonly recombinationTrees?: RecombinationCodonTreeSet;
  readonly recombinationBundle?: EvoOnlineRecombinationTreeBundle;
}

function emptyDefinition(): PipelineDefinition {
  return {
    schemaVersion: PIPELINE_SCHEMA_VERSION,
    id: createPipelineId(),
    name: "Untitled pipeline",
    nodes: [],
  };
}

function modelForNode(node: PipelineNode) {
  if (node.kind !== "model" || node.modelId === undefined) return undefined;
  return modelRegistry.find((registration) => registration.plugin.manifest.id === node.modelId);
}

function normalizeDefinition(definition: PipelineDefinition): PipelineDefinition {
  const nodes = definition.nodes.map((node): PipelineNode => {
    if (node.kind === "fasttree") return { id: node.id, kind: node.kind, parameters: { model: "gtr", fastest: false, ...node.parameters } };
    if (node.kind === "user-trees") return { id: node.id, kind: node.kind, parameters: {} };
    if (node.kind === "true-tree") return { id: node.id, kind: node.kind, parameters: {} };
    const registration = modelForNode(node);
    if (registration === undefined) {
      throw new Error(`Pipeline method '${node.modelId ?? "unknown"}' is not available.`);
    }
    return { id: node.id, kind: "model", modelId: registration.plugin.manifest.id, parameters: { ...registration.plugin.defaultParameters(), ...node.parameters } };
  });
  const sortedNodes = sortPipelineNodes(nodes);
  const issues = topologyIssuesForNodes(sortedNodes);
  if (issues.length > 0) throw new Error(issues.join(" "));
  return { ...definition, name: definition.name.trim() || "Untitled pipeline", nodes: sortedNodes };
}

function newNode(kind: PipelineNodeKind, modelId?: string): PipelineNode {
  if (kind === "fasttree") return { id: createPipelineId("component"), kind, parameters: { model: "gtr", fastest: false } };
  if (kind === "user-trees") return { id: createPipelineId("component"), kind, parameters: {} };
  if (kind === "true-tree") return { id: createPipelineId("component"), kind, parameters: {} };
  if (modelId === undefined) throw new Error("No analysis method was supplied.");
  const registration = getRegisteredModel(modelId);
  return { id: createPipelineId("component"), kind, modelId, parameters: registration.plugin.defaultParameters() };
}

function nodeTitle(node: PipelineNode): string {
  if (node.kind === "fasttree") return "FastTree";
  if (node.kind === "user-trees") return "User trees";
  if (node.kind === "true-tree") return "True tree";
  return modelForNode(node)?.plugin.manifest.shortTitle ?? node.modelId ?? "Unavailable method";
}

function nodeInstanceLabel(node: PipelineNode, peers: readonly PipelineNode[]): string {
  const matching = peers.filter((candidate) => candidate.kind === node.kind && candidate.modelId === node.modelId);
  if (matching.length <= 1) return nodeTitle(node);
  return `${nodeTitle(node)} ${matching.findIndex((candidate) => candidate.id === node.id) + 1}`;
}

function nodeGlyph(node: PipelineNode): string {
  if (node.kind === "fasttree") return "FT";
  if (node.kind === "user-trees") return "NW";
  if (node.kind === "true-tree") return "T✓";
  return modelForNode(node)?.glyph ?? "?";
}

function nodeCategory(node: PipelineNode): string {
  if (node.kind === "fasttree") return "tree inference";
  if (node.kind === "user-trees") return "filename matching";
  if (node.kind === "true-tree") return "simulation truth";
  if (node.modelId === "simulator") return "generated data input";
  return `${modelForNode(node)?.plugin.manifest.category ?? "analysis"} method`;
}

function sourceKindLabel(kind: PipelineSourceOutputKind): string {
  if (kind === "inferred-tree") return "inferred tree";
  if (kind === "user-tree") return "matched user tree";
  if (kind === "regional-trees") return "regional tree set";
  return "true tree / recombination graph";
}

function acceptedSourceLabel(node: PipelineNode): string {
  const kinds = pipelineAcceptedSourceKinds(node);
  if (kinds.length === 0) return "no pipeline source";
  return kinds.map(sourceKindLabel).join(", ");
}

function simulatorRecombinationEnabled(nodes: readonly PipelineNode[]): boolean {
  const simulator = nodes.find((node) => node.modelId === "simulator");
  return simulator !== undefined && decodeSimulatorConfig(simulator.parameters.simulatorConfig).recombination.enabled;
}

function compatibleSourcesForPipeline(target: PipelineNode, nodes: readonly PipelineNode[]): readonly PipelineNode[] {
  const sources = nodes.filter((node) => pipelineNodeStage(node) === "source");
  const compatible = compatiblePipelineSources(target, sources);
  if (!simulatorRecombinationEnabled(nodes)) return compatible;
  return compatible.filter((source) => source.kind !== "true-tree" || pipelineAcceptedSourceKinds(target).includes("regional-trees"));
}

function topologyIssuesForNodes(nodes: readonly PipelineNode[]): readonly string[] {
  const issues: string[] = [];
  const simulators = nodes.filter((node) => node.modelId === "simulator");
  const trueTrees = nodes.filter((node) => node.kind === "true-tree");
  const sources = nodes.filter((node) => pipelineNodeStage(node) === "source");
  if (simulators.length > 1) issues.push("A pipeline can contain only one Simulator input.");
  if (trueTrees.length > 1) issues.push("A pipeline can contain only one True tree source.");
  if (trueTrees.length > 0 && simulators.length === 0) issues.push("True tree can only be placed after a Simulator input.");
  if (simulators.length > 0 && nodes.some((node) => node.kind === "user-trees")) issues.push("User trees cannot be matched in a Simulator pipeline; use True tree for simulator truth.");
  for (const node of nodes) {
    const stage = pipelineNodeStage(node);
    if (stage === undefined) {
      issues.push(`${nodeTitle(node)} has no declared pipeline input/output contract.`);
    } else if (stage === "selection" && compatibleSourcesForPipeline(node, nodes).length === 0) {
      const trueGraphIsOnlyStaticRoute = simulatorRecombinationEnabled(nodes) && sources.some((source) => source.kind === "true-tree" && compatiblePipelineSources(node, [source]).length > 0);
      issues.push(trueGraphIsOnlyStaticRoute
        ? `${nodeTitle(node)} cannot consume a true recombination graph. Add a compatible inferred single-tree source, or use a regional-tree-aware selection method.`
        : `${nodeTitle(node)} cannot be placed: no source produces its required ${acceptedSourceLabel(node)} input.`);
    }
  }
  return [...new Set(issues)];
}

function compactParameterControl({
  parameter,
  value,
  onChange,
}: {
  readonly parameter: ModelParameter;
  readonly value: string | number | boolean;
  readonly onChange: (value: string | number | boolean) => void;
}) {
  if (parameter.type === "select") {
    return <label className="pipeline-compact-field"><span>{parameter.label}</span><select value={String(value)} onChange={(event) => onChange(event.target.value)}>{parameter.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>;
  }
  if (parameter.type === "boolean") {
    return <label className="pipeline-compact-toggle"><input type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} /><span>{parameter.label}</span></label>;
  }
  return <label className="pipeline-compact-field"><span>{parameter.label}</span><input type="number" value={Number(value)} min={parameter.minimum} max={parameter.maximum} step={parameter.step} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

function fileWithPath(file: File, path: string): File {
  if (file.webkitRelativePath.length > 0) return file;
  try {
    Object.defineProperty(file, "webkitRelativePath", { configurable: true, value: path.replace(/^\/+/, "") });
  } catch {
    // The filename still provides deterministic matching if this legacy File is non-extensible.
  }
  return file;
}

async function readDirectoryEntries(entry: LegacyFileSystemEntry): Promise<readonly LegacyFileSystemEntry[]> {
  const reader = entry.createReader?.();
  if (reader === undefined) return [];
  const output: LegacyFileSystemEntry[] = [];
  while (true) {
    const batch = await new Promise<readonly LegacyFileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) return output;
    output.push(...batch);
  }
}

async function filesFromEntry(entry: LegacyFileSystemEntry): Promise<readonly File[]> {
  if (entry.isFile && entry.file !== undefined) {
    const file = await new Promise<File>((resolve, reject) => entry.file?.(resolve, reject));
    return [fileWithPath(file, entry.fullPath)];
  }
  if (!entry.isDirectory) return [];
  const children = await readDirectoryEntries(entry);
  return (await Promise.all(children.map(filesFromEntry))).flat();
}

async function filesFromDrop(event: DragEvent<HTMLElement>): Promise<readonly File[]> {
  const entries = [...event.dataTransfer.items]
    .map((item) => (item as unknown as { readonly webkitGetAsEntry?: () => LegacyFileSystemEntry | null }).webkitGetAsEntry?.())
    .filter((entry): entry is LegacyFileSystemEntry => entry !== undefined && entry !== null);
  if (entries.length === 0) return [...event.dataTransfer.files];
  return (await Promise.all(entries.map(filesFromEntry))).flat();
}

async function readPipelineFile(file: File): Promise<string> {
  if (file.size > 50 * 1024 * 1024) throw new Error(`${pipelineFilePath(file)} is larger than 50 MiB.`);
  return file.text();
}

function createAnalysisId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `analysis-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function recombinationOutput(modelId: string, result: unknown, alignment: AlignmentArtifact, analysisId: string): RecombinationOutput | undefined {
  if (modelId === "fsart") {
    const typed = result as FsartAnalysisResult;
    const treeSet = createFsartCodonTreeSet(typed, alignment.sites, analysisId);
    return { treeSet, bundle: createFsartRecombinationBundle(typed, treeSet) };
  }
  if (modelId === "mosaic-spr") {
    const typed = result as MosaicSprAnalysisResult;
    const treeSet = createMosaicSprCodonTreeSet(typed, alignment.sites, analysisId);
    return { treeSet, bundle: createMosaicSprRecombinationBundle(typed, treeSet) };
  }
  if (modelId === "jemspr") {
    const typed = result as JemsprAnalysisResult;
    const treeSet = createJemsprCodonTreeSet(typed, alignment.sites, analysisId);
    return { treeSet, bundle: createJemsprRecombinationBundle(typed, treeSet) };
  }
  return undefined;
}

function simulatorTruthTreeSet(dataset: SimulatedDataset, codonSites: number): RecombinationCodonTreeSet {
  const regions = dataset.localTrees.length > 0
    ? dataset.localTrees
    : [{ startCodon: 1, endCodon: codonSites, tree: dataset.tree, activeEventIds: [] }];
  return {
    schemaVersion: 1,
    sourceMethod: "simulation-truth",
    branchLengthSource: "method-final-trees",
    branchScalePolicy: "fixed-relative",
    codonAssignment: "middle-nucleotide",
    segments: regions.map((region) => ({
      startCodon: region.startCodon,
      endCodon: region.endCodon,
      tree: region.tree.newick,
      label: `True local tree ${region.startCodon}–${region.endCodon}`,
    })),
  };
}

function storedPipelines(): readonly PipelineDefinition[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PIPELINE_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((value) => {
      try { return [normalizeDefinition(parsePipelineDefinition(JSON.stringify(value)))]; }
      catch { return []; }
    });
  } catch {
    return [];
  }
}

function persistPipelines(pipelines: readonly PipelineDefinition[]): void {
  localStorage.setItem(PIPELINE_STORAGE_KEY, JSON.stringify(pipelines));
}

function safeFilename(value: string): string {
  const normalized = value.trim().toLocaleLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
  return normalized || "evoonline-pipeline";
}

export function PipelineBuilder({ alignmentBridge, executorServices, onAnalysesCompleted }: PipelineBuilderProps) {
  const directoryInput = useRef<HTMLInputElement>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const activeExecutor = useRef<BrowserModelExecutor | undefined>(undefined);
  const runGeneration = useRef(0);
  const [definition, setDefinition] = useState<PipelineDefinition>(() => emptyDefinition());
  const [selectedNodeId, setSelectedNodeId] = useState(DATA_NODE_ID);
  const [files, setFiles] = useState<readonly File[]>([]);
  const [savedDefinitions, setSavedDefinitions] = useState<readonly PipelineDefinition[]>(() => storedPipelines());
  const [notice, setNotice] = useState<{ readonly tone: "error" | "info" | "success"; readonly text: string }>();
  const [shareUrl, setShareUrl] = useState<string>();
  const [runState, setRunState] = useState<"idle" | "running">("idle");
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("Ready");
  const [pairingReport, setPairingReport] = useState<readonly PairingReportRow[]>([]);
  const [runLog, setRunLog] = useState<readonly PipelineLogEntry[]>([]);
  const [comparisonRecords, setComparisonRecords] = useState<readonly PipelineComparisonRecord[]>([]);

  useEffect(() => { directoryInput.current?.setAttribute("webkitdirectory", ""); }, []);

  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const shared = hash.get("pipeline");
    if (shared === null) return;
    try {
      const next = normalizeDefinition(decodePipelineShare(shared));
      setDefinition(next);
      setSelectedNodeId(next.nodes[0]?.id ?? DATA_NODE_ID);
      setNotice({ tone: "success", text: `Shared pipeline “${next.name}” loaded. Add the input files to rerun it.` });
    } catch (error) {
      setNotice({ tone: "error", text: `The shared pipeline could not be loaded: ${error instanceof Error ? error.message : String(error)}` });
    }
  }, []);

  useEffect(() => () => {
    runGeneration.current += 1;
    activeExecutor.current?.cancel();
    activeExecutor.current?.dispose();
  }, []);

  const alignmentFiles = useMemo(() => files.filter(isPipelineAlignmentFile), [files]);
  const treeFiles = useMemo(() => files.filter(isPipelineTreeFile), [files]);
  const ignoredFiles = files.length - alignmentFiles.length - treeFiles.length;
  const selectedNode = definition.nodes.find((node) => node.id === selectedNodeId);
  const simulatorNode = useMemo(() => definition.nodes.find((node) => pipelineNodeStage(node) === "input"), [definition.nodes]);
  const sourceNodes = useMemo(() => definition.nodes.filter((node) => pipelineNodeStage(node) === "source"), [definition.nodes]);
  const selectionNodes = useMemo(() => definition.nodes.filter((node) => pipelineNodeStage(node) === "selection"), [definition.nodes]);
  const usesUserTrees = sourceNodes.some((node) => node.kind === "user-trees");
  const simulatedDatasetCount = simulatorNode === undefined ? undefined : decodeSimulatorConfig(simulatorNode.parameters.simulatorConfig).tree.replicates;

  const pipelineIssues = useMemo(() => {
    const issues: string[] = [];
    if (simulatorNode === undefined && alignmentFiles.length === 0) issues.push("Add at least one FASTA alignment or use Simulator as the input.");
    if (simulatorNode !== undefined && !decodeSimulatorConfig(simulatorNode.parameters.simulatorConfig).simulateAlignment) issues.push("Pipeline analysis requires Simulator → Simulate alignments to be enabled.");
    if (!definition.nodes.some((node) => node.kind === "model" && node.modelId !== "simulator")) issues.push("Add at least one analysis method after the input.");
    for (const node of definition.nodes) {
      if (node.kind !== "model") continue;
      const registration = modelForNode(node);
      if (registration === undefined) issues.push(`${nodeTitle(node)} is unavailable.`);
    }
    issues.push(...topologyIssuesForNodes(definition.nodes));
    if (definition.nodes.some((node) => node.kind === "fasttree") && alignmentBridge === undefined) issues.push("The local FastTree runtime is still loading.");
    return [...new Set(issues)];
  }, [alignmentBridge, alignmentFiles.length, definition.nodes, simulatorNode]);

  const updateDefinition = (updater: (current: PipelineDefinition) => PipelineDefinition): void => {
    setDefinition((current) => updater(current));
    setShareUrl(undefined);
    setPairingReport([]);
  };

  const addFiles = (incoming: readonly File[]): void => {
    setFiles((current) => {
      const next = new Map<string, File>(current.map((file) => [`${pipelineFilePath(file)}\0${file.size}\0${file.lastModified}`, file] as const));
      for (const file of incoming) next.set(`${pipelineFilePath(file)}\0${file.size}\0${file.lastModified}`, file);
      return [...next.values()].sort((left, right) => pipelineFilePath(left).localeCompare(pipelineFilePath(right)));
    });
    setPairingReport([]);
    setRunLog([]);
    setComparisonRecords([]);
    setNotice({ tone: "success", text: `${incoming.length} file${incoming.length === 1 ? "" : "s"} added to the pipeline input.` });
  };

  const fileInputChanged = (event: ChangeEvent<HTMLInputElement>): void => {
    addFiles([...(event.target.files ?? [])]);
    event.target.value = "";
  };

  const dataDropped = (event: DragEvent<HTMLDivElement>): void => {
    if (event.dataTransfer.getData(PIPELINE_DRAG_TYPE).length > 0) return;
    event.preventDefault();
    event.stopPropagation();
    void filesFromDrop(event).then(addFiles).catch((error: unknown) => setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) }));
  };

  const addPipelineNode = (kind: PipelineNodeKind, modelId?: string): void => {
    try {
      if (kind !== "model" || modelId === "simulator") {
        const existing = kind === "model" ? undefined : definition.nodes.find((node) => node.kind === kind);
        const existingSimulator = modelId === "simulator" ? definition.nodes.find((node) => node.modelId === "simulator") : undefined;
        if (existingSimulator !== undefined) { setSelectedNodeId(existingSimulator.id); setNotice({ tone: "info", text: "Simulator is already the input for this pipeline." }); return; }
        if (existing !== undefined) { setSelectedNodeId(existing.id); setNotice({ tone: "info", text: `${nodeTitle(existing)} is already in this pipeline.` }); return; }
      }
      const node = newNode(kind, modelId);
      const stage = pipelineNodeStage(node);
      if (stage === undefined) throw new Error(`${nodeTitle(node)} has no declared pipeline input/output contract and cannot be placed.`);
      const prospectiveNodes = sortPipelineNodes([...definition.nodes, node]);
      const compatibleSources = compatibleSourcesForPipeline(node, prospectiveNodes);
      const prospectiveIssues = topologyIssuesForNodes(prospectiveNodes);
      if (prospectiveIssues.length > 0) throw new Error(prospectiveIssues.join(" "));
      const connectedSelections = stage === "source"
        ? definition.nodes.filter((candidate) => pipelineNodeStage(candidate) === "selection" && compatibleSourcesForPipeline(candidate, prospectiveNodes).some((source) => source.id === node.id))
        : [];
      updateDefinition((current) => ({ ...current, nodes: sortPipelineNodes([...current.nodes, node]) }));
      setComparisonRecords([]);
      setSelectedNodeId(node.id);
      const route = stage === "selection"
        ? ` It receives ${compatibleSources.map(nodeTitle).join(", ")} output${compatibleSources.length === 1 ? "" : "s"}.`
        : stage === "input"
          ? " It replaces Data upload and generates every replicate with retained ground truth."
        : connectedSelections.length > 0
          ? ` It also feeds ${connectedSelections.map(nodeTitle).join(", ")}.`
          : ` It reads each ${definition.nodes.some((candidate) => candidate.modelId === "simulator") || node.modelId === "simulator" ? "generated" : "uploaded"} alignment directly.`;
      setNotice({ tone: "success", text: `${nodeTitle(node)} added to the ${stage === "input" ? "input" : stage === "source" ? "source" : "selection"} stage.${route}` });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    }
  };

  useEffect(() => {
    const addFromSidebar = (event: Event): void => {
      const detail = (event as CustomEvent<{ readonly kind?: PipelineNodeKind; readonly modelId?: string }>).detail;
      if (detail?.kind === "fasttree" || detail?.kind === "user-trees" || detail?.kind === "true-tree" || detail?.kind === "model") addPipelineNode(detail.kind, detail.modelId);
    };
    window.addEventListener(PIPELINE_ADD_EVENT, addFromSidebar);
    return () => window.removeEventListener(PIPELINE_ADD_EVENT, addFromSidebar);
  }, [definition.nodes]);

  const canvasDropped = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const raw = event.dataTransfer.getData(PIPELINE_DRAG_TYPE);
    if (raw.length === 0) return;
    try {
      const payload = JSON.parse(raw) as { readonly kind?: PipelineNodeKind; readonly modelId?: string };
      if (payload.kind === "fasttree" || payload.kind === "user-trees" || payload.kind === "true-tree" || payload.kind === "model") addPipelineNode(payload.kind, payload.modelId);
    } catch {
      setNotice({ tone: "error", text: "That pipeline component could not be added." });
    }
  };

  const removeNode = (nodeId: string): void => {
    const removing = definition.nodes.find((node) => node.id === nodeId);
    if (removing === undefined) return;
    const nextNodes = definition.nodes.filter((node) => node.id !== nodeId);
    const issues = topologyIssuesForNodes(nextNodes);
    if (issues.length > 0) {
      setNotice({ tone: "error", text: `Cannot remove ${nodeTitle(removing)}. ${issues.join(" ")}` });
      return;
    }
    updateDefinition((current) => ({ ...current, nodes: current.nodes.filter((node) => node.id !== nodeId) }));
    setComparisonRecords([]);
    setSelectedNodeId(DATA_NODE_ID);
    setNotice({ tone: "info", text: `${nodeTitle(removing)} removed.` });
  };

  const updateNodeParameter = (nodeId: string, parameterId: string, value: string | number | boolean): void => {
    updateDefinition((current) => ({
      ...current,
      nodes: current.nodes.map((node) => node.id === nodeId ? { ...node, parameters: { ...node.parameters, [parameterId]: value } } : node),
    }));
    setComparisonRecords([]);
  };

  const updateNodeParameters = (nodeId: string, parameters: ParameterValues): void => {
    updateDefinition((current) => ({
      ...current,
      nodes: current.nodes.map((node) => node.id === nodeId ? { ...node, parameters } : node),
    }));
    setComparisonRecords([]);
  };

  const savePipelineLocally = (): void => {
    try {
      const normalized = normalizeDefinition(definition);
      const next = [normalized, ...savedDefinitions.filter((saved) => saved.id !== normalized.id)];
      persistPipelines(next);
      setDefinition(normalized);
      setSavedDefinitions(next);
      setNotice({ tone: "success", text: `“${normalized.name}” saved on this device.` });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    }
  };

  const openSavedPipeline = (id: string): void => {
    const saved = savedDefinitions.find((candidate) => candidate.id === id);
    if (saved === undefined) return;
    setDefinition(saved);
    setSelectedNodeId(saved.nodes[0]?.id ?? DATA_NODE_ID);
    setFiles([]);
    setPairingReport([]);
    setRunLog([]);
    setComparisonRecords([]);
    setShareUrl(undefined);
    setNotice({ tone: "info", text: `“${saved.name}” loaded. Input data is never stored with a pipeline.` });
  };

  const exportPipeline = (): void => {
    const normalized = normalizeDefinition(definition);
    downloadText(stringifyPipelineDefinition(normalized), `${safeFilename(normalized.name)}.evo-pipeline.json`, "application/json;charset=utf-8");
    setNotice({ tone: "success", text: "Portable pipeline definition downloaded." });
  };

  const importPipeline = async (file: File): Promise<void> => {
    try {
      const next = normalizeDefinition(parsePipelineDefinition(await file.text()));
      setDefinition(next);
      setSelectedNodeId(next.nodes[0]?.id ?? DATA_NODE_ID);
      setFiles([]);
      setPairingReport([]);
      setRunLog([]);
      setComparisonRecords([]);
      setShareUrl(undefined);
      setNotice({ tone: "success", text: `“${next.name}” imported. Add the input files to rerun it.` });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    }
  };

  const importChanged = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    if (file !== undefined) void importPipeline(file);
    event.target.value = "";
  };

  const sharePipeline = async (): Promise<void> => {
    try {
      const normalized = normalizeDefinition(definition);
      const url = new URL(window.location.href);
      url.hash = `pipeline=${encodePipelineShare(normalized)}`;
      const value = url.toString();
      setShareUrl(value);
      try {
        await navigator.clipboard.writeText(value);
        setNotice({ tone: "success", text: "Share link copied. It contains settings only; the recipient supplies their own inputs." });
      } catch {
        setNotice({ tone: "info", text: "Share link created below. It contains settings only; the recipient supplies their own inputs." });
      }
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    }
  };

  const appendLog = (entry: Omit<PipelineLogEntry, "id">): void => {
    setRunLog((current) => [...current, { ...entry, id: createPipelineId("log") }]);
  };

  const runPipeline = async (): Promise<void> => {
    if (pipelineIssues.length > 0) return;
    const generation = ++runGeneration.current;
    const normalized = normalizeDefinition(definition);
    const normalizedSimulator = normalized.nodes.find((node) => pipelineNodeStage(node) === "input");
    const normalizedSources = normalized.nodes.filter((node) => pipelineNodeStage(node) === "source");
    const normalizedSelections = normalized.nodes.filter((node) => pipelineNodeStage(node) === "selection");
    const selectionRouteCount = normalizedSelections.reduce((total, selection) => total + compatibleSourcesForPipeline(selection, normalized.nodes).length, 0);
    let matched: readonly TreeMatch<File>[] = normalizedSimulator === undefined ? matchPipelineTrees(files) as readonly TreeMatch<File>[] : [];
    const report = usesUserTrees ? matched.map((match): PairingReportRow => ({
      alignment: pipelineFilePath(match.alignment),
      status: match.status,
      ...(match.tree === undefined ? {} : { tree: pipelineFilePath(match.tree) }),
      candidates: match.candidates.map(pipelineFilePath),
    })) : [];
    setDefinition(normalized);
    setPairingReport(report);
    setRunLog([]);
    setComparisonRecords([]);
    setProgress(0);
    setProgressLabel(normalizedSimulator === undefined ? "Input manifest ready" : "Simulator ready");
    setRunState("running");
    setNotice({ tone: "info", text: normalizedSimulator !== undefined
      ? `Simulator will generate ${decodeSimulatorConfig(normalizedSimulator.parameters.simulatorConfig).tree.replicates} dataset${decodeSimulatorConfig(normalizedSimulator.parameters.simulatorConfig).tree.replicates === 1 ? "" : "s"}. True tree and every inferred source will run as independent, parallel routes.`
      : usesUserTrees
        ? `Input pairing report created for all ${matched.length} alignment${matched.length === 1 ? "" : "s"}. Analysis will start from exactly these matches and follow only compatible source routes.`
        : `Input manifest created for ${matched.length} alignment${matched.length === 1 ? "" : "s"}; only compatible source routes will run.` });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    const completed: SavedAnalysis[] = [];
    const completedComparisons: PipelineComparisonRecord[] = [];
    let failedDatasets = 0;
    let finishedSteps = 0;
    const stepsPerDataset = normalizedSources.length + selectionRouteCount;
    let simulatorResult: SimulatorAnalysisResult | undefined;
    let simulatorAnalysis: SavedAnalysis | undefined;
    let totalSteps = Math.max(1, matched.length * stepsPerDataset);
    if (normalizedSimulator !== undefined) {
      const registration = modelForNode(normalizedSimulator);
      if (registration === undefined) {
        setRunState("idle");
        setNotice({ tone: "error", text: "Simulator is not registered." });
        return;
      }
      const expectedDatasets = decodeSimulatorConfig(normalizedSimulator.parameters.simulatorConfig).tree.replicates;
      totalSteps = Math.max(1, 1 + expectedDatasets * stepsPerDataset);
      setProgressLabel("Simulator · generating alignments and truth");
      appendLog({ dataset: "Pipeline input", component: "Simulator", tone: "running", detail: `Generating ${expectedDatasets} reproducible dataset${expectedDatasets === 1 ? "" : "s"}` });
      const executor = registration.createExecutor(executorServices);
      activeExecutor.current = executor;
      try {
        simulatorResult = await executor.run("", "", normalizedSimulator.parameters, (entry) => {
          if (generation !== runGeneration.current) return;
          const fraction = Math.max(0, Math.min(1, entry.fraction));
          setProgress(fraction / totalSteps);
          setProgressLabel(`Simulator · ${entry.message ?? entry.stage}`);
        }) as SimulatorAnalysisResult;
        const analysisId = createAnalysisId();
        simulatorAnalysis = {
          id: analysisId,
          modelId: "simulator",
          title: `Simulator · ${normalized.name}`,
          createdAt: Date.now(),
          parameters: { ...normalizedSimulator.parameters },
          result: simulatorResult,
        };
        await saveAnalysis(simulatorAnalysis);
        completed.push(simulatorAnalysis);
        matched = simulatorResult.datasets.map((dataset, index): TreeMatch<File> => {
          if (dataset.fasta === undefined) throw new Error(`Simulated dataset ${index + 1} did not contain an alignment.`);
          const alignmentFile = new File([dataset.fasta], `simulated-dataset-${index + 1}.fasta`, { type: "text/plain", lastModified: Date.now() + index });
          return { alignment: alignmentFile, candidates: [], status: "missing" };
        });
        finishedSteps = 1;
        totalSteps = Math.max(1, 1 + matched.length * stepsPerDataset);
        setProgress(finishedSteps / totalSteps);
        appendLog({ dataset: "Pipeline input", component: "Simulator", tone: "complete", detail: `${matched.length} alignment${matched.length === 1 ? "" : "s"} generated with exact parameter, tree, and recombination truth retained` });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setRunState("idle");
        setProgressLabel("Simulator failed");
        appendLog({ dataset: "Pipeline input", component: "Simulator", tone: "error", detail: error instanceof Error ? error.message : String(error) });
        setNotice({ tone: "error", text: `Simulator could not create the pipeline input: ${error instanceof Error ? error.message : String(error)}` });
        return;
      } finally {
        executor.dispose();
        if (activeExecutor.current === executor) activeExecutor.current = undefined;
      }
    }
    for (let datasetIndex = 0; datasetIndex < matched.length; datasetIndex += 1) {
      if (generation !== runGeneration.current) break;
      const match = matched[datasetIndex]!;
      const datasetName = pipelineFilePath(match.alignment);
      const simulationDataset = simulatorResult?.datasets[datasetIndex];
      const simulationSource = simulatorAnalysis === undefined || simulationDataset === undefined ? undefined : {
        simulationAnalysisId: simulatorAnalysis.id,
        datasetId: simulationDataset.id,
        datasetIndex,
      };
      let datasetFailed = false;
      let alignment: AlignmentArtifact;
      try {
        setProgressLabel(`Reading ${datasetName}`);
        alignment = await createAlignmentArtifact(datasetName, await readPipelineFile(match.alignment));
        appendLog({ dataset: datasetName, component: normalizedSimulator === undefined ? "Data upload" : "Simulator", tone: "complete", detail: `${alignment.taxa} taxa · ${alignment.sites.toLocaleString()} sites` });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") break;
        failedDatasets += 1;
        finishedSteps += stepsPerDataset;
        setProgress(finishedSteps / totalSteps);
        appendLog({ dataset: datasetName, component: normalizedSimulator === undefined ? "Data upload" : "Simulator", tone: "error", detail: error instanceof Error ? error.message : String(error) });
        continue;
      }

      if (simulatorAnalysis !== undefined && simulationDataset !== undefined) {
        completedComparisons.push({
          analysis: simulatorAnalysis,
          datasetName,
          sourceNodeId: "simulation-ground-truth",
          sourceLabel: "Simulation truth",
          methodNodeId: `truth-${simulationDataset.id}`,
          methodLabel: "Truth",
          simulationDataset,
        });
      }

      const products = new Map<string, PipelineSourceProduct>();
      for (const node of normalizedSources) {
        if (generation !== runGeneration.current) return;
        const title = nodeInstanceLabel(node, normalizedSources);
        const outputKind = pipelineSourceOutputKind(node);
        const baseProgress = finishedSteps / totalSteps;
        setProgress(baseProgress);
        setProgressLabel(`${datasetName} · ${title}`);
        appendLog({ dataset: datasetName, component: title, tone: "running", detail: `Source branch started from ${normalizedSimulator === undefined ? "Data upload" : "Simulator"}` });
        try {
          if (outputKind === undefined) throw new Error(`${title} has no declared source output.`);
          let product: PipelineSourceProduct;
          if (node.kind === "true-tree") {
            if (simulationDataset === undefined) throw new Error("True tree requires a Simulator input.");
            const treeSet = simulatorTruthTreeSet(simulationDataset, Math.floor(alignment.sites / 3));
            const representative = treeSet.segments[0];
            if (representative === undefined) throw new Error("The simulator produced no true genealogy.");
            const tree = await createTreeArtifact(`${datasetName.replace(/\.[^.]+$/u, "")}.true-tree.nwk`, representative.tree, "editor");
            const bundle = createSimulationTruthRecombinationBundle(simulationDataset, treeSet, alignment.sites, alignment.taxa);
            product = {
              node,
              outputKind,
              tree,
              ...(treeSet.segments.length <= 1 ? {} : { recombinationTrees: treeSet }),
              recombinationBundle: bundle,
            };
            appendLog({ dataset: datasetName, component: title, tone: "complete", detail: treeSet.segments.length <= 1 ? "Exact simulated tree" : `Exact simulated recombination graph · ${treeSet.segments.length} local trees` });
          } else if (node.kind === "user-trees") {
            if (match.status === "missing") throw new Error(`No tree filename matches ${datasetName} after removing extensions.`);
            if (match.status === "ambiguous") throw new Error(`More than one tree matches ${datasetName}: ${match.candidates.map(pipelineFilePath).join(", ")}.`);
            if (match.tree === undefined) throw new Error(`The matched tree for ${datasetName} is unavailable.`);
            const tree = await createTreeArtifact(pipelineFilePath(match.tree), await readPipelineFile(match.tree), "upload");
            product = { node, outputKind, tree };
            appendLog({ dataset: datasetName, component: title, tone: "complete", detail: pipelineFilePath(match.tree) });
          } else if (node.kind === "fasttree") {
            if (alignmentBridge === undefined) throw new Error("The local FastTree runtime is unavailable.");
            const snapshot = await alignmentBridge.request<{ readonly tree?: string }>("run-fasttree", {
              alignment: alignment.text,
              model: String(node.parameters.model ?? "gtr"),
              fastest: Boolean(node.parameters.fastest ?? false),
            }, 10 * 60_000);
            if (!snapshot.tree) throw new Error("FastTree returned no tree.");
            const tree = await createTreeArtifact(`${datasetName.replace(/\.[^.]+$/u, "")}.fasttree.nwk`, snapshot.tree, "fasttree");
            product = { node, outputKind, tree };
            appendLog({ dataset: datasetName, component: title, tone: "complete", detail: `${node.parameters.fastest ? "fastest" : "standard"} GTR+CAT tree` });
          } else {
            const registration = modelForNode(node);
            if (registration === undefined || node.modelId === undefined) throw new Error(`${title} is not registered.`);
            const validation = registration.plugin.validate({ alignment });
            if (!validation.ready) throw new Error(validation.issues.filter((issue) => issue.severity === "error").map((issue) => issue.message).join(" ") || `${title} inputs are invalid.`);
            const executor = registration.createExecutor(executorServices);
            activeExecutor.current = executor;
            let result: unknown;
            try {
              result = await executor.run(alignment.text, "", node.parameters, (entry) => {
                if (generation !== runGeneration.current) return;
                const fraction = Math.max(0, Math.min(1, entry.fraction));
                setProgress(baseProgress + fraction / totalSteps);
                setProgressLabel(`${datasetName} · ${title} · ${entry.message ?? entry.stage}`);
              });
            } finally {
              executor.dispose();
              if (activeExecutor.current === executor) activeExecutor.current = undefined;
            }
            const analysisId = createAnalysisId();
            let regional: RecombinationOutput | undefined;
            let handoffError: unknown;
            try {
              regional = recombinationOutput(node.modelId, result, alignment, analysisId);
            } catch (error) {
              handoffError = error;
            }
            const saved: SavedAnalysis = {
              id: analysisId,
              modelId: node.modelId,
              title: `${registration.plugin.manifest.shortTitle} · ${datasetName} · ${normalized.name}`,
              createdAt: Date.now() + completed.length,
              parameters: { ...node.parameters },
              alignment,
              result,
              ...(regional === undefined ? {} : { recombinationTrees: regional.treeSet, recombinationBundle: regional.bundle }),
              ...(simulationSource === undefined ? {} : { simulationSource }),
            };
            await saveAnalysis(saved);
            completed.push(saved);
            if (regional === undefined) {
              const reason = handoffError instanceof Error ? ` ${handoffError.message}` : "";
              throw new Error(`${title} completed and was saved, but it did not produce a usable regional-tree output.${reason}`);
            }
            const representative = regional.treeSet.segments[0];
            if (representative === undefined) throw new Error(`${title} completed and was saved, but produced no regional tree.`);
            const tree = await createTreeArtifact(`${node.modelId}-${datasetName.replace(/\.[^.]+$/u, "")}-region-1.nwk`, representative.tree, "editor");
            product = { node, outputKind, tree, recombinationTrees: regional.treeSet, recombinationBundle: regional.bundle };
            appendLog({ dataset: datasetName, component: title, tone: "complete", detail: `${registration.completionMessage(result)} Regional-tree output ready.` });
          }
          products.set(node.id, product);
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") return;
          datasetFailed = true;
          appendLog({ dataset: datasetName, component: title, tone: "error", detail: error instanceof Error ? error.message : String(error) });
        } finally {
          finishedSteps += 1;
          setProgress(finishedSteps / totalSteps);
        }
      }

      for (const node of normalizedSelections) {
        const routes = compatibleSourcesForPipeline(node, normalized.nodes);
        for (const source of routes) {
          if (generation !== runGeneration.current) return;
          const title = nodeInstanceLabel(node, normalizedSelections);
          const sourceTitle = nodeInstanceLabel(source, normalizedSources);
          const routeTitle = `${title} via ${sourceTitle}`;
          const product = products.get(source.id);
          const baseProgress = finishedSteps / totalSteps;
          setProgress(baseProgress);
          setProgressLabel(`${datasetName} · ${routeTitle}`);
          if (product === undefined) {
            datasetFailed = true;
            appendLog({ dataset: datasetName, component: routeTitle, tone: "error", detail: `Skipped because ${sourceTitle} did not produce its declared ${pipelineSourceOutputKind(source) === undefined ? "tree" : sourceKindLabel(pipelineSourceOutputKind(source)!)} output.` });
          } else {
            appendLog({ dataset: datasetName, component: routeTitle, tone: "running", detail: `Started from ${sourceTitle} output` });
            try {
            const registration = modelForNode(node);
            if (registration === undefined || node.modelId === undefined) throw new Error(`${title} is not registered.`);
            const acceptsTree = registration.plugin.manifest.inputSlots.some((slot) => slot.id === "tree");
            const requiresTree = registration.plugin.manifest.inputSlots.some((slot) => slot.id === "tree" && slot.required);
            let methodTree = product.tree;
            if (methodTree !== undefined && registration.plugin.prepareTreeInput !== undefined) {
              methodTree = await createTreeArtifact(methodTree.name, registration.plugin.prepareTreeInput(methodTree.text), methodTree.source);
            }
            const validation = registration.plugin.validate({ alignment, ...(methodTree === undefined ? {} : { tree: methodTree }) });
            if (requiresTree && methodTree === undefined) throw new Error(`${title} needs a tree, but ${sourceTitle} produced none.`);
            if (!validation.ready) throw new Error(validation.issues.filter((issue) => issue.severity === "error").map((issue) => issue.message).join(" ") || `${title} inputs are invalid.`);
            const executor = registration.createExecutor(executorServices);
            activeExecutor.current = executor;
            let result: unknown;
            try {
              result = await executor.run(alignment.text, methodTree?.text ?? "", node.parameters, (entry) => {
                if (generation !== runGeneration.current) return;
                const fraction = Math.max(0, Math.min(1, entry.fraction));
                setProgress(baseProgress + fraction / totalSteps);
                setProgressLabel(`${datasetName} · ${routeTitle} · ${entry.message ?? entry.stage}`);
              }, product.recombinationTrees === undefined ? undefined : { recombinationTrees: product.recombinationTrees });
            } finally {
              executor.dispose();
              if (activeExecutor.current === executor) activeExecutor.current = undefined;
            }
            const analysisId = createAnalysisId();
            const saved: SavedAnalysis = {
              id: analysisId,
              modelId: node.modelId,
              title: `${registration.plugin.manifest.shortTitle} · ${datasetName} · via ${sourceTitle} · ${normalized.name}`,
              createdAt: Date.now() + completed.length,
              parameters: { ...node.parameters },
              alignment,
              ...(acceptsTree && methodTree !== undefined ? { tree: methodTree } : {}),
              result,
              ...(product.recombinationTrees === undefined ? {} : { recombinationTrees: product.recombinationTrees }),
              ...(product.recombinationBundle === undefined ? {} : { recombinationBundle: product.recombinationBundle }),
              ...(simulationSource === undefined ? {} : { simulationSource }),
            };
            await saveAnalysis(saved);
            completed.push(saved);
            completedComparisons.push({ analysis: saved, datasetName, sourceNodeId: source.id, sourceLabel: sourceTitle, methodNodeId: node.id, methodLabel: title });
            setComparisonRecords([...completedComparisons]);
            appendLog({ dataset: datasetName, component: routeTitle, tone: "complete", detail: registration.completionMessage(result) });
            } catch (error) {
              if (error instanceof DOMException && error.name === "AbortError") return;
              datasetFailed = true;
              appendLog({ dataset: datasetName, component: routeTitle, tone: "error", detail: error instanceof Error ? error.message : String(error) });
            }
          }
          finishedSteps += 1;
          setProgress(finishedSteps / totalSteps);
        }
      }
      if (datasetFailed) failedDatasets += 1;
    }

    if (generation !== runGeneration.current) return;
    activeExecutor.current = undefined;
    setRunState("idle");
    setProgress(1);
    setProgressLabel("Pipeline complete");
    if (completed.length > 0) onAnalysesCompleted(completed);
    const comparisonMessage = completedComparisons.length > 1 ? " Cross-method aggregate tables and plots are ready below." : "";
    setNotice(failedDatasets === 0
      ? { tone: "success", text: `Pipeline complete: ${completed.length} analysis result${completed.length === 1 ? "" : "s"} saved.${comparisonMessage}` }
      : { tone: completed.length === 0 ? "error" : "info", text: `Pipeline finished with ${completed.length} saved result${completed.length === 1 ? "" : "s"}; ${failedDatasets} dataset${failedDatasets === 1 ? "" : "s"} had one or more failed routes.${comparisonMessage} See the run log below.` });
  };

  const cancelPipeline = (): void => {
    runGeneration.current += 1;
    activeExecutor.current?.cancel();
    activeExecutor.current = undefined;
    setRunState("idle");
    setProgressLabel("Cancelled");
    setNotice({ tone: "info", text: "Pipeline cancelled. Results completed before cancellation remain saved." });
  };

  return (
    <div className="pipeline-workspace">
      <section className="pipeline-header">
        <div><p className="eyebrow">Batch analysis / pipeline mode</p><h1>Pipeline builder</h1><p>Components are placed by their declared inputs and outputs. Methods in the same stage run side by side; selection results are never treated as inputs to other selection methods.</p></div>
        <div className="pipeline-header__actions">
          <input className="pipeline-name" aria-label="Pipeline name" value={definition.name} disabled={runState === "running"} onChange={(event) => updateDefinition((current) => ({ ...current, name: event.target.value }))} />
          <select aria-label="Add pipeline component" defaultValue="" disabled={runState === "running"} onChange={(event) => { const [kind, modelId] = event.target.value.split(":"); if (kind === "fasttree" || kind === "user-trees" || kind === "true-tree") addPipelineNode(kind); else if (kind === "model" && modelId !== undefined) addPipelineNode("model", modelId); event.target.value = ""; }}><option value="">Add component…</option><optgroup label="Input"><option value="model:simulator">Simulator</option></optgroup><optgroup label="Trees"><option value="fasttree">FastTree</option><option value="user-trees">User trees</option><option value="true-tree">True tree</option></optgroup><optgroup label="Methods">{modelRegistry.filter((registration) => registration.plugin.manifest.id !== "simulator").map((registration) => <option key={registration.plugin.manifest.id} value={`model:${registration.plugin.manifest.id}`}>{registration.plugin.manifest.shortTitle}</option>)}</optgroup></select>
          <select aria-label="Open saved pipeline" defaultValue="" disabled={runState === "running"} onChange={(event) => { openSavedPipeline(event.target.value); event.target.value = ""; }}><option value="">Open saved…</option>{savedDefinitions.map((saved) => <option key={saved.id} value={saved.id}>{saved.name}</option>)}</select>
          <button type="button" className="button button--secondary" disabled={runState === "running"} onClick={savePipelineLocally}>Save</button>
          <button type="button" className="button button--quiet" disabled={runState === "running"} onClick={exportPipeline}>Export</button>
          <button type="button" className="button button--quiet" disabled={runState === "running"} onClick={() => importInput.current?.click()}>Import</button>
          <button type="button" className="button button--quiet" disabled={runState === "running"} onClick={() => void sharePipeline()}>Share link</button>
          <button type="button" className="button button--quiet" disabled={runState === "running"} onClick={() => { const next = emptyDefinition(); setDefinition(next); setFiles([]); setSelectedNodeId(DATA_NODE_ID); setPairingReport([]); setRunLog([]); setComparisonRecords([]); setShareUrl(undefined); setNotice({ tone: "info", text: "New empty pipeline created." }); }}>New</button>
          <input ref={importInput} className="visually-hidden" type="file" accept=".json,.evo-pipeline.json" onChange={importChanged} />
        </div>
      </section>

      {notice !== undefined && <div className={`notice notice--${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>{notice.text}<button type="button" aria-label="Dismiss message" onClick={() => setNotice(undefined)}>×</button></div>}
      {shareUrl !== undefined && <div className="pipeline-share"><label><span>Shareable settings link</span><input readOnly value={shareUrl} onFocus={(event) => event.target.select()} /></label><small>Simulator designs are embedded; uploaded alignment and tree files are not.</small></div>}

      <div className="pipeline-builder-grid">
        <div className="pipeline-canvas" onDragOver={(event) => event.preventDefault()} onDrop={canvasDropped}>
          {simulatorNode === undefined ? <div className={`pipeline-node pipeline-node--data ${selectedNodeId === DATA_NODE_ID ? "is-selected" : ""}`} role="button" tabIndex={0} onDragOver={(event) => event.preventDefault()} onDrop={dataDropped} onClick={() => setSelectedNodeId(DATA_NODE_ID)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setSelectedNodeId(DATA_NODE_ID); }}>
            <span className="pipeline-node__order">01</span><span className="pipeline-node__glyph">FA</span><div><strong>Data upload</strong><small>{alignmentFiles.length === 0 ? "Required first component" : `${alignmentFiles.length} FASTA · ${treeFiles.length} tree file${treeFiles.length === 1 ? "" : "s"}`}</small></div><span className="pipeline-node__locked">Required</span>
          </div> : <div className={`pipeline-node pipeline-node--data ${selectedNodeId === simulatorNode.id ? "is-selected" : ""}`} role="button" tabIndex={0} onClick={() => setSelectedNodeId(simulatorNode.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setSelectedNodeId(simulatorNode.id); }}>
            <span className="pipeline-node__order">01</span><span className="pipeline-node__glyph">{nodeGlyph(simulatorNode)}</span><div><strong>Simulator</strong><small>{simulatedDatasetCount} generated dataset{simulatedDatasetCount === 1 ? "" : "s"} · truth retained</small></div><div className="pipeline-node__controls"><button type="button" aria-label="Remove Simulator" disabled={runState === "running"} onClick={(event) => { event.stopPropagation(); removeNode(simulatorNode.id); }}>×</button></div>
          </div>}
          {sourceNodes.length > 0 && <><div className="pipeline-stage-connector" aria-hidden="true"><span>↓</span><strong>{simulatorNode === undefined ? "alignment" : "generated alignment"}</strong></div><section className="pipeline-stage"><header><span>02</span><div><strong>Tree &amp; recombination sources</strong><small>Parallel branches · each reads {simulatorNode === undefined ? "Data upload" : "Simulator"} directly</small></div></header><div className="pipeline-stage__nodes">{sourceNodes.map((node, index) => <div key={node.id} className={`pipeline-node ${selectedNodeId === node.id ? "is-selected" : ""}`} role="button" tabIndex={0} onClick={() => setSelectedNodeId(node.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setSelectedNodeId(node.id); }}><span className="pipeline-node__order">02{String.fromCharCode(65 + index)}</span><span className="pipeline-node__glyph">{nodeGlyph(node)}</span><div><strong>{nodeTitle(node)}</strong><small>{nodeCategory(node)}</small><span className="pipeline-node__route">Outputs: {pipelineSourceOutputKind(node) === undefined ? "unavailable" : sourceKindLabel(pipelineSourceOutputKind(node)!)}</span></div><div className="pipeline-node__controls"><button type="button" aria-label={`Remove ${nodeTitle(node)}`} disabled={runState === "running"} onClick={(event) => { event.stopPropagation(); removeNode(node.id); }}>×</button></div></div>)}</div></section></>}
          {selectionNodes.length > 0 && <><div className="pipeline-stage-connector pipeline-stage-connector--typed" aria-hidden="true"><span>↓</span><strong>compatible tree outputs only</strong></div><section className="pipeline-stage pipeline-stage--selection"><header><span>03</span><div><strong>Selection analyses</strong><small>Parallel terminal branches · outputs stop here</small></div></header><div className="pipeline-stage__nodes">{selectionNodes.map((node, index) => <div key={node.id} className={`pipeline-node ${selectedNodeId === node.id ? "is-selected" : ""}`} role="button" tabIndex={0} onClick={() => setSelectedNodeId(node.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setSelectedNodeId(node.id); }}><span className="pipeline-node__order">03{String.fromCharCode(65 + index)}</span><span className="pipeline-node__glyph">{nodeGlyph(node)}</span><div><strong>{nodeTitle(node)}</strong><small>{nodeCategory(node)}</small><span className="pipeline-node__route">Inputs: {compatibleSourcesForPipeline(node, definition.nodes).map(nodeTitle).join(" · ")}</span></div><div className="pipeline-node__controls"><button type="button" aria-label={`Remove ${nodeTitle(node)}`} disabled={runState === "running"} onClick={(event) => { event.stopPropagation(); removeNode(node.id); }}>×</button></div></div>)}</div></section></>}
          {sourceNodes.length === 0 && selectionNodes.length === 0 && <div className="pipeline-canvas__empty"><strong>Drop a source component here</strong><span>{simulatorNode === undefined ? "Start with Simulator, FastTree, User trees, or a recombination method." : "Add True tree, FastTree, or a recombination method; compatible sources can run side by side."} Selection methods become placeable only after a compatible source exists.</span></div>}
        </div>

        <aside className="pipeline-inspector">
          {selectedNodeId === DATA_NODE_ID ? <><div className="pipeline-inspector__heading"><span>FA</span><div><p className="eyebrow">Required input</p><h2>Data upload</h2></div></div><div className="pipeline-upload" onDragOver={(event) => event.preventDefault()} onDrop={dataDropped}><strong>Drop FASTA files or a directory</strong><span>Tree files in the same selection are retained for User trees matching.</span><div><label className="button button--secondary">Choose files<input type="file" multiple accept={FILE_ACCEPT} onChange={fileInputChanged} /></label><button type="button" className="button button--quiet" onClick={() => directoryInput.current?.click()}>Choose folder</button><input ref={directoryInput} className="visually-hidden" type="file" multiple onChange={fileInputChanged} /></div></div><div className="pipeline-file-summary"><div><span>Alignments</span><strong>{alignmentFiles.length}</strong></div><div><span>Tree files</span><strong>{treeFiles.length}</strong></div><div><span>Ignored</span><strong>{ignoredFiles}</strong></div></div>{files.length > 0 && <><div className="pipeline-file-list">{files.map((file) => <span key={`${pipelineFilePath(file)}-${file.size}`} className={isPipelineAlignmentFile(file) ? "is-alignment" : isPipelineTreeFile(file) ? "is-tree" : "is-ignored"}>{pipelineFilePath(file)}</span>)}</div><button type="button" className="button button--quiet button--full" disabled={runState === "running"} onClick={() => { setFiles([]); setPairingReport([]); setRunLog([]); setComparisonRecords([]); }}>Clear files</button></>}</> : selectedNode !== undefined ? <>
            <div className="pipeline-inspector__heading"><span>{nodeGlyph(selectedNode)}</span><div><p className="eyebrow">Component settings</p><h2>{nodeTitle(selectedNode)}</h2></div></div>
            <div className="pipeline-routing-summary">
              <strong>{pipelineNodeStage(selectedNode) === "input" ? "Input generator" : pipelineNodeStage(selectedNode) === "source" ? "Source branch" : "Terminal analysis"}</strong>
              <span>{pipelineNodeStage(selectedNode) === "input"
                ? "Simulator → generated alignments + retained ground truth"
                : pipelineNodeStage(selectedNode) === "source"
                  ? `${simulatorNode === undefined ? "Data upload" : "Simulator"} → ${nodeTitle(selectedNode)} → ${pipelineSourceOutputKind(selectedNode) === undefined ? "unavailable" : sourceKindLabel(pipelineSourceOutputKind(selectedNode)!)}`
                  : `${compatibleSourcesForPipeline(selectedNode, definition.nodes).map(nodeTitle).join(" · ")} → ${nodeTitle(selectedNode)} → saved result`}</span>
              {selectedNode.modelId === "diffubar" && <small>Matched user trees must contain both G1 and G2 branch tags; this is checked before execution.</small>}
            </div>
            {selectedNode.modelId === "simulator" ? <div className="pipeline-simulator-settings"><SimulatorSetup parameters={selectedNode.parameters} onChange={(parameters) => updateNodeParameters(selectedNode.id, parameters)} disabled={runState === "running"} /></div>
              : selectedNode.kind === "fasttree" ? <div className="pipeline-compact-grid"><label className="pipeline-compact-field"><span>Model</span><select value={String(selectedNode.parameters.model ?? "gtr")} onChange={(event) => updateNodeParameter(selectedNode.id, "model", event.target.value)}><option value="gtr">GTR + CAT</option></select></label><label className="pipeline-compact-toggle"><input type="checkbox" checked={Boolean(selectedNode.parameters.fastest ?? false)} onChange={(event) => updateNodeParameter(selectedNode.id, "fastest", event.target.checked)} /><span>Fastest topology search</span></label></div>
              : selectedNode.kind === "user-trees" ? <div className="pipeline-match-rule"><strong>Exact stem matching</strong><span><code>sample.fasta</code> matches <code>sample.nwk</code>, <code>sample.tree</code>, or another supported tree extension. Zero or multiple matches stop only this source route; other source branches continue.</span></div>
              : selectedNode.kind === "true-tree" ? <div className="pipeline-match-rule"><strong>Exact simulator truth</strong><span>Uses the generated genealogy directly. With recombination, it also passes the exact local-tree partition and retains the carrier tree and event graph. Inferred tree/recombination sources beside it still run as separate routes.</span></div>
              : <div className="pipeline-compact-grid">{(modelForNode(selectedNode)?.plugin.manifest.parameters ?? []).map((parameter) => <div key={parameter.id}>{compactParameterControl({ parameter, value: selectedNode.parameters[parameter.id] ?? parameter.default, onChange: (value) => updateNodeParameter(selectedNode.id, parameter.id, value) })}</div>)}</div>}
          </> : null}
        </aside>
      </div>

      <section className="pipeline-run-panel">
        <div><p className="eyebrow">Validate and run</p><h2>{simulatedDatasetCount ?? alignmentFiles.length} dataset{(simulatedDatasetCount ?? alignmentFiles.length) === 1 ? "" : "s"} · {sourceNodes.length} source branch{sourceNodes.length === 1 ? "" : "es"} · {selectionNodes.length} terminal selection{selectionNodes.length === 1 ? "" : "s"}</h2>{pipelineIssues.length > 0 ? <ul>{pipelineIssues.map((issue) => <li key={issue}>{issue}</li>)}</ul> : <p>Ready. Each source reads the {simulatorNode === undefined ? "uploaded" : "generated"} alignment independently; each selection runs once per compatible source output and is saved independently.</p>}</div>
        {runState === "running" ? <div className="pipeline-run-progress"><strong>{progressLabel}</strong><div><span style={{ width: `${Math.round(progress * 100)}%` }} /></div><small>{Math.round(progress * 100)}%</small><button type="button" className="button button--quiet" onClick={cancelPipeline}>Cancel</button></div> : <button type="button" className="button button--run" disabled={pipelineIssues.length > 0} onClick={() => void runPipeline()}><span>Run pipeline</span><small>Pair inputs · execute locally · aggregate compatible selection results</small></button>}
      </section>

      {pairingReport.length > 0 && <section className="pipeline-report" aria-live="polite"><div className="pipeline-report__heading"><div><p className="eyebrow">Reported before computation</p><h2>User-tree input pairing</h2></div><span>{pairingReport.filter((row) => row.status === "matched").length}/{pairingReport.length} matched</span></div><div className="pipeline-pairing-table" role="table" aria-label="Full list of user tree matches"><div className="pipeline-pairing-table__header" role="row"><span role="columnheader">Alignment file</span><span role="columnheader">Matched tree file</span><span role="columnheader">Status</span></div>{pairingReport.map((row) => <div key={row.alignment} role="row"><span role="cell">{row.alignment}</span><span role="cell">{row.tree ?? (row.candidates.length > 0 ? row.candidates.join(", ") : "—")}</span><strong role="cell" className={`is-${row.status}`}>{row.status}</strong></div>)}</div></section>}

      {comparisonRecords.length > 0 && <PipelineComparisonStudio records={comparisonRecords} />}

      {runLog.length > 0 && <section className="pipeline-report"><div className="pipeline-report__heading"><div><p className="eyebrow">Batch record</p><h2>Run log</h2></div><span>{runLog.filter((entry) => entry.tone === "complete").length} completed steps</span></div><div className="pipeline-log">{runLog.map((entry) => <div key={entry.id}><span>{entry.dataset}</span><strong>{entry.component}</strong><small className={`is-${entry.tone}`}>{entry.tone}</small><p>{entry.detail}</p></div>)}</div></section>}
    </div>
  );
}

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
import type { WidgetBridge } from "@phylo-workbench/viewer-bridge";
import {
  getRegisteredModel,
  modelRegistry,
  type BrowserExecutorServices,
  type BrowserModelExecutor,
} from "../model-registry.js";
import { saveAnalysis, type SavedAnalysis } from "../lib/analysis-store.js";
import { downloadText } from "../lib/file-download.js";
import {
  createFsartRecombinationBundle,
  createJemsprRecombinationBundle,
  createMosaicSprRecombinationBundle,
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
  createPipelineId,
  decodePipelineShare,
  encodePipelineShare,
  isPipelineAlignmentFile,
  isPipelineTreeFile,
  matchPipelineTrees,
  parsePipelineDefinition,
  pipelineFilePath,
  stringifyPipelineDefinition,
  type PipelineDefinition,
  type PipelineNode,
  type PipelineNodeKind,
  type TreeMatch,
} from "../lib/pipeline.js";

const DATA_NODE_ID = "pipeline-data-upload";
const FILE_ACCEPT = ".fa,.fas,.fasta,.fna,.ffn,.aln,.nwk,.newick,.tree,.tre,.nex,.nexus";
const REGIONAL_SELECTION_METHODS = new Set(["fubar", "fame", "flavor"]);

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
    const registration = modelForNode(node);
    if (registration === undefined || registration.plugin.manifest.id === "simulator") {
      throw new Error(`Pipeline method '${node.modelId ?? "unknown"}' is not available.`);
    }
    return { id: node.id, kind: "model", modelId: registration.plugin.manifest.id, parameters: { ...registration.plugin.defaultParameters(), ...node.parameters } };
  });
  return { ...definition, name: definition.name.trim() || "Untitled pipeline", nodes };
}

function newNode(kind: PipelineNodeKind, modelId?: string): PipelineNode {
  if (kind === "fasttree") return { id: createPipelineId("component"), kind, parameters: { model: "gtr", fastest: false } };
  if (kind === "user-trees") return { id: createPipelineId("component"), kind, parameters: {} };
  if (modelId === undefined) throw new Error("No analysis method was supplied.");
  const registration = getRegisteredModel(modelId);
  if (registration.plugin.manifest.id === "simulator") throw new Error("The simulator starts from generated data and cannot follow a pipeline upload.");
  return { id: createPipelineId("component"), kind, modelId, parameters: registration.plugin.defaultParameters() };
}

function nodeTitle(node: PipelineNode): string {
  if (node.kind === "fasttree") return "FastTree";
  if (node.kind === "user-trees") return "User trees";
  return modelForNode(node)?.plugin.manifest.shortTitle ?? node.modelId ?? "Unavailable method";
}

function nodeGlyph(node: PipelineNode): string {
  if (node.kind === "fasttree") return "FT";
  if (node.kind === "user-trees") return "NW";
  return modelForNode(node)?.glyph ?? "?";
}

function nodeCategory(node: PipelineNode): string {
  if (node.kind === "fasttree") return "tree inference";
  if (node.kind === "user-trees") return "filename matching";
  return `${modelForNode(node)?.plugin.manifest.category ?? "analysis"} method`;
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
  const usesUserTrees = definition.nodes.some((node) => node.kind === "user-trees");

  const pipelineIssues = useMemo(() => {
    const issues: string[] = [];
    if (alignmentFiles.length === 0) issues.push("Add at least one FASTA alignment.");
    if (!definition.nodes.some((node) => node.kind === "model")) issues.push("Add at least one analysis method.");
    let hasTree = false;
    for (const node of definition.nodes) {
      if (node.kind === "fasttree" || node.kind === "user-trees") { hasTree = true; continue; }
      const registration = modelForNode(node);
      if (registration === undefined) { issues.push(`${nodeTitle(node)} is unavailable.`); continue; }
      if (registration.plugin.manifest.inputSlots.some((slot) => slot.id === "tree" && slot.required) && !hasTree) {
        issues.push(`${registration.plugin.manifest.shortTitle} needs FastTree, User trees, or a recombination component before it.`);
      }
      if (registration.plugin.manifest.category === "recombination") hasTree = true;
    }
    if (definition.nodes.some((node) => node.kind === "fasttree") && alignmentBridge === undefined) issues.push("The local FastTree runtime is still loading.");
    return [...new Set(issues)];
  }, [alignmentBridge, alignmentFiles.length, definition.nodes]);

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
    setNotice({ tone: "success", text: `${incoming.length} file${incoming.length === 1 ? "" : "s"} added to the pipeline input.` });
  };

  const fileInputChanged = (event: ChangeEvent<HTMLInputElement>): void => {
    addFiles([...(event.target.files ?? [])]);
    event.target.value = "";
  };

  const dataDropped = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    void filesFromDrop(event).then(addFiles).catch((error: unknown) => setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) }));
  };

  const addPipelineNode = (kind: PipelineNodeKind, modelId?: string): void => {
    try {
      if (kind !== "model") {
        const existing = definition.nodes.find((node) => node.kind === kind);
        if (existing !== undefined) { setSelectedNodeId(existing.id); setNotice({ tone: "info", text: `${nodeTitle(existing)} is already in this pipeline.` }); return; }
      }
      const node = newNode(kind, modelId);
      updateDefinition((current) => ({ ...current, nodes: [...current.nodes, node] }));
      setSelectedNodeId(node.id);
      setNotice({ tone: "success", text: `${nodeTitle(node)} added. Click the component to edit its settings.` });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    }
  };

  useEffect(() => {
    const addFromSidebar = (event: Event): void => {
      const detail = (event as CustomEvent<{ readonly kind?: PipelineNodeKind; readonly modelId?: string }>).detail;
      if (detail?.kind === "fasttree" || detail?.kind === "user-trees" || detail?.kind === "model") addPipelineNode(detail.kind, detail.modelId);
    };
    window.addEventListener(PIPELINE_ADD_EVENT, addFromSidebar);
    return () => window.removeEventListener(PIPELINE_ADD_EVENT, addFromSidebar);
  }, [definition.nodes]);

  const canvasDropped = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const raw = event.dataTransfer.getData(PIPELINE_DRAG_TYPE);
    if (raw.length === 0) return;
    try {
      const payload = JSON.parse(raw) as { readonly kind?: PipelineNodeKind | "pipeline-node"; readonly modelId?: string; readonly nodeId?: string };
      if (payload.kind === "pipeline-node") return;
      if (payload.kind === "fasttree" || payload.kind === "user-trees" || payload.kind === "model") addPipelineNode(payload.kind, payload.modelId);
    } catch {
      setNotice({ tone: "error", text: "That pipeline component could not be added." });
    }
  };

  const reorderNode = (event: DragEvent<HTMLElement>, targetId: string): void => {
    event.preventDefault();
    try {
      const payload = JSON.parse(event.dataTransfer.getData(PIPELINE_DRAG_TYPE)) as { readonly kind?: string; readonly nodeId?: string };
      if (payload.kind !== "pipeline-node" || payload.nodeId === undefined || payload.nodeId === targetId) return;
      event.stopPropagation();
      updateDefinition((current) => {
        const moving = current.nodes.find((node) => node.id === payload.nodeId);
        if (moving === undefined) return current;
        const remaining = current.nodes.filter((node) => node.id !== moving.id);
        const targetIndex = remaining.findIndex((node) => node.id === targetId);
        if (targetIndex < 0) return current;
        return { ...current, nodes: [...remaining.slice(0, targetIndex), moving, ...remaining.slice(targetIndex)] };
      });
    } catch {
      // Ignore unrelated drags over an existing component.
    }
  };

  const moveNode = (nodeId: string, offset: -1 | 1): void => {
    updateDefinition((current) => {
      const index = current.nodes.findIndex((node) => node.id === nodeId);
      const target = index + offset;
      if (index < 0 || target < 0 || target >= current.nodes.length) return current;
      const nodes = [...current.nodes];
      const [moving] = nodes.splice(index, 1);
      if (moving === undefined) return current;
      nodes.splice(target, 0, moving);
      return { ...current, nodes };
    });
  };

  const removeNode = (nodeId: string): void => {
    updateDefinition((current) => ({ ...current, nodes: current.nodes.filter((node) => node.id !== nodeId) }));
    setSelectedNodeId(DATA_NODE_ID);
  };

  const updateNodeParameter = (nodeId: string, parameterId: string, value: string | number | boolean): void => {
    updateDefinition((current) => ({
      ...current,
      nodes: current.nodes.map((node) => node.id === nodeId ? { ...node, parameters: { ...node.parameters, [parameterId]: value } } : node),
    }));
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
    const matched = matchPipelineTrees(files) as readonly TreeMatch<File>[];
    const report = usesUserTrees ? matched.map((match): PairingReportRow => ({
      alignment: pipelineFilePath(match.alignment),
      status: match.status,
      ...(match.tree === undefined ? {} : { tree: pipelineFilePath(match.tree) }),
      candidates: match.candidates.map(pipelineFilePath),
    })) : [];
    setDefinition(normalized);
    setPairingReport(report);
    setRunLog([]);
    setProgress(0);
    setProgressLabel("Input manifest ready");
    setRunState("running");
    setNotice({ tone: "info", text: usesUserTrees ? `Input pairing report created for all ${matched.length} alignment${matched.length === 1 ? "" : "s"}. Analysis will start from exactly these matches.` : `Input manifest created for ${matched.length} alignment${matched.length === 1 ? "" : "s"}.` });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    const completed: SavedAnalysis[] = [];
    let failedDatasets = 0;
    const totalSteps = Math.max(1, matched.length * normalized.nodes.length);
    for (let datasetIndex = 0; datasetIndex < matched.length; datasetIndex += 1) {
      if (generation !== runGeneration.current) break;
      const match = matched[datasetIndex]!;
      const datasetName = pipelineFilePath(match.alignment);
      let currentTree: TreeArtifact | undefined;
      let currentRegionalTree: TreeArtifact | undefined;
      let currentRecombinationTrees: RecombinationCodonTreeSet | undefined;
      let currentRecombinationBundle: EvoOnlineRecombinationTreeBundle | undefined;
      try {
        setProgressLabel(`Reading ${datasetName}`);
        const alignment = await createAlignmentArtifact(datasetName, await readPipelineFile(match.alignment));
        appendLog({ dataset: datasetName, component: "Data upload", tone: "complete", detail: `${alignment.taxa} taxa · ${alignment.sites.toLocaleString()} sites` });
        for (let nodeIndex = 0; nodeIndex < normalized.nodes.length; nodeIndex += 1) {
          if (generation !== runGeneration.current) throw new DOMException("Pipeline cancelled.", "AbortError");
          const node = normalized.nodes[nodeIndex]!;
          const title = nodeTitle(node);
          const baseProgress = (datasetIndex * normalized.nodes.length + nodeIndex) / totalSteps;
          setProgress(baseProgress);
          setProgressLabel(`${datasetName} · ${title}`);
          appendLog({ dataset: datasetName, component: title, tone: "running", detail: "Started" });

          if (node.kind === "user-trees") {
            if (match.status === "missing") throw new Error(`No tree filename matches ${datasetName} after removing extensions.`);
            if (match.status === "ambiguous") throw new Error(`More than one tree matches ${datasetName}: ${match.candidates.map(pipelineFilePath).join(", ")}.`);
            if (match.tree === undefined) throw new Error(`The matched tree for ${datasetName} is unavailable.`);
            currentTree = await createTreeArtifact(pipelineFilePath(match.tree), await readPipelineFile(match.tree), "upload");
            currentRegionalTree = undefined;
            currentRecombinationTrees = undefined;
            currentRecombinationBundle = undefined;
            appendLog({ dataset: datasetName, component: title, tone: "complete", detail: pipelineFilePath(match.tree) });
          } else if (node.kind === "fasttree") {
            if (alignmentBridge === undefined) throw new Error("The local FastTree runtime is unavailable.");
            const snapshot = await alignmentBridge.request<{ readonly tree?: string }>("run-fasttree", {
              alignment: alignment.text,
              model: String(node.parameters.model ?? "gtr"),
              fastest: Boolean(node.parameters.fastest ?? false),
            }, 10 * 60_000);
            if (!snapshot.tree) throw new Error("FastTree returned no tree.");
            currentTree = await createTreeArtifact(`${datasetName.replace(/\.[^.]+$/u, "")}.fasttree.nwk`, snapshot.tree, "fasttree");
            currentRegionalTree = undefined;
            currentRecombinationTrees = undefined;
            currentRecombinationBundle = undefined;
            appendLog({ dataset: datasetName, component: title, tone: "complete", detail: `${node.parameters.fastest ? "fastest" : "standard"} GTR+CAT tree` });
          } else {
            const registration = modelForNode(node);
            if (registration === undefined || node.modelId === undefined) throw new Error(`${title} is not registered.`);
            const acceptsTree = registration.plugin.manifest.inputSlots.some((slot) => slot.id === "tree");
            const requiresTree = registration.plugin.manifest.inputSlots.some((slot) => slot.id === "tree" && slot.required);
            let methodTree = REGIONAL_SELECTION_METHODS.has(node.modelId) && currentRegionalTree !== undefined ? currentRegionalTree : currentTree;
            if (methodTree !== undefined && registration.plugin.prepareTreeInput !== undefined) {
              methodTree = await createTreeArtifact(methodTree.name, registration.plugin.prepareTreeInput(methodTree.text), methodTree.source);
            }
            const validation = registration.plugin.validate({ alignment, ...(methodTree === undefined ? {} : { tree: methodTree }) });
            if (requiresTree && methodTree === undefined) throw new Error(`${title} needs a tree, but no upstream component produced one.`);
            if (!validation.ready) throw new Error(validation.issues.filter((issue) => issue.severity === "error").map((issue) => issue.message).join(" ") || `${title} inputs are invalid.`);
            const executor = registration.createExecutor(executorServices);
            activeExecutor.current = executor;
            let result: unknown;
            try {
              result = await executor.run(alignment.text, methodTree?.text ?? "", node.parameters, (entry) => {
                if (generation !== runGeneration.current) return;
                const fraction = Math.max(0, Math.min(1, entry.fraction));
                setProgress(baseProgress + fraction / totalSteps);
                setProgressLabel(`${datasetName} · ${title} · ${entry.message ?? entry.stage}`);
              }, REGIONAL_SELECTION_METHODS.has(node.modelId) && currentRecombinationTrees !== undefined ? { recombinationTrees: currentRecombinationTrees } : undefined);
            } finally {
              executor.dispose();
              if (activeExecutor.current === executor) activeExecutor.current = undefined;
            }
            const analysisId = createAnalysisId();
            const regional = recombinationOutput(node.modelId, result, alignment, analysisId);
            if (regional !== undefined) {
              currentRecombinationTrees = regional.treeSet;
              currentRecombinationBundle = regional.bundle;
              const representative = regional.treeSet.segments[0];
              if (representative === undefined) throw new Error(`${title} produced no regional tree.`);
              const previousRegionalTree = currentRegionalTree;
              currentRegionalTree = await createTreeArtifact(`${node.modelId}-${datasetName.replace(/\.[^.]+$/u, "")}-region-1.nwk`, representative.tree, "editor");
              if (currentTree === undefined || currentTree === previousRegionalTree) currentTree = currentRegionalTree;
            }
            const usesRegionalTrees = REGIONAL_SELECTION_METHODS.has(node.modelId) && currentRecombinationTrees !== undefined;
            const savedRecombinationTrees = regional?.treeSet ?? (usesRegionalTrees ? currentRecombinationTrees : undefined);
            const savedRecombinationBundle = regional?.bundle ?? (usesRegionalTrees ? currentRecombinationBundle : undefined);
            const saved: SavedAnalysis = {
              id: analysisId,
              modelId: node.modelId,
              title: `${registration.plugin.manifest.shortTitle} · ${datasetName} · ${normalized.name}`,
              createdAt: Date.now() + completed.length,
              parameters: { ...node.parameters },
              alignment,
              ...(acceptsTree && methodTree !== undefined ? { tree: methodTree } : {}),
              result,
              ...(savedRecombinationTrees === undefined ? {} : { recombinationTrees: savedRecombinationTrees }),
              ...(savedRecombinationBundle === undefined ? {} : { recombinationBundle: savedRecombinationBundle }),
            };
            await saveAnalysis(saved);
            completed.push(saved);
            appendLog({ dataset: datasetName, component: title, tone: "complete", detail: registration.completionMessage(result) });
          }
          setProgress((datasetIndex * normalized.nodes.length + nodeIndex + 1) / totalSteps);
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") break;
        failedDatasets += 1;
        appendLog({ dataset: datasetName, component: "Pipeline", tone: "error", detail: error instanceof Error ? error.message : String(error) });
      }
    }

    if (generation !== runGeneration.current) return;
    activeExecutor.current = undefined;
    setRunState("idle");
    setProgress(1);
    setProgressLabel("Pipeline complete");
    if (completed.length > 0) onAnalysesCompleted(completed);
    setNotice(failedDatasets === 0
      ? { tone: "success", text: `Pipeline complete: ${completed.length} analysis result${completed.length === 1 ? "" : "s"} saved.` }
      : { tone: completed.length === 0 ? "error" : "info", text: `Pipeline finished with ${completed.length} saved result${completed.length === 1 ? "" : "s"}; ${failedDatasets} dataset${failedDatasets === 1 ? "" : "s"} stopped. See the run log below.` });
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
        <div><p className="eyebrow">Batch analysis / pipeline mode</p><h1>Pipeline builder</h1><p>Arrange local analysis components once, then run the same settings across every uploaded alignment.</p></div>
        <div className="pipeline-header__actions">
          <input className="pipeline-name" aria-label="Pipeline name" value={definition.name} disabled={runState === "running"} onChange={(event) => updateDefinition((current) => ({ ...current, name: event.target.value }))} />
          <select aria-label="Add pipeline component" defaultValue="" disabled={runState === "running"} onChange={(event) => { const [kind, modelId] = event.target.value.split(":"); if (kind === "fasttree" || kind === "user-trees") addPipelineNode(kind); else if (kind === "model" && modelId !== undefined) addPipelineNode("model", modelId); event.target.value = ""; }}><option value="">Add component…</option><optgroup label="Trees"><option value="fasttree">FastTree</option><option value="user-trees">User trees</option></optgroup><optgroup label="Methods">{modelRegistry.filter((registration) => registration.plugin.manifest.id !== "simulator").map((registration) => <option key={registration.plugin.manifest.id} value={`model:${registration.plugin.manifest.id}`}>{registration.plugin.manifest.shortTitle}</option>)}</optgroup></select>
          <select aria-label="Open saved pipeline" defaultValue="" disabled={runState === "running"} onChange={(event) => { openSavedPipeline(event.target.value); event.target.value = ""; }}><option value="">Open saved…</option>{savedDefinitions.map((saved) => <option key={saved.id} value={saved.id}>{saved.name}</option>)}</select>
          <button type="button" className="button button--secondary" disabled={runState === "running"} onClick={savePipelineLocally}>Save</button>
          <button type="button" className="button button--quiet" disabled={runState === "running"} onClick={exportPipeline}>Export</button>
          <button type="button" className="button button--quiet" disabled={runState === "running"} onClick={() => importInput.current?.click()}>Import</button>
          <button type="button" className="button button--quiet" disabled={runState === "running"} onClick={() => void sharePipeline()}>Share link</button>
          <button type="button" className="button button--quiet" disabled={runState === "running"} onClick={() => { const next = emptyDefinition(); setDefinition(next); setFiles([]); setSelectedNodeId(DATA_NODE_ID); setPairingReport([]); setRunLog([]); setShareUrl(undefined); setNotice({ tone: "info", text: "New empty pipeline created." }); }}>New</button>
          <input ref={importInput} className="visually-hidden" type="file" accept=".json,.evo-pipeline.json" onChange={importChanged} />
        </div>
      </section>

      {notice !== undefined && <div className={`notice notice--${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>{notice.text}<button type="button" aria-label="Dismiss message" onClick={() => setNotice(undefined)}>×</button></div>}
      {shareUrl !== undefined && <div className="pipeline-share"><label><span>Shareable settings link</span><input readOnly value={shareUrl} onFocus={(event) => event.target.select()} /></label><small>Alignment and tree files are not embedded.</small></div>}

      <div className="pipeline-builder-grid">
        <div className="pipeline-canvas" onDragOver={(event) => event.preventDefault()} onDrop={canvasDropped}>
          <div className={`pipeline-node pipeline-node--data ${selectedNodeId === DATA_NODE_ID ? "is-selected" : ""}`} role="button" tabIndex={0} onDragOver={(event) => event.preventDefault()} onDrop={dataDropped} onClick={() => setSelectedNodeId(DATA_NODE_ID)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setSelectedNodeId(DATA_NODE_ID); }}>
            <span className="pipeline-node__order">01</span><span className="pipeline-node__glyph">FA</span><div><strong>Data upload</strong><small>{alignmentFiles.length === 0 ? "Required first component" : `${alignmentFiles.length} FASTA · ${treeFiles.length} tree file${treeFiles.length === 1 ? "" : "s"}`}</small></div><span className="pipeline-node__locked">Required</span>
          </div>
          {definition.nodes.map((node, index) => <div key={node.id} className="pipeline-node-wrap"><div className="pipeline-connector" aria-hidden="true"><span>↓</span></div><div className={`pipeline-node ${selectedNodeId === node.id ? "is-selected" : ""}`} draggable={runState !== "running"} onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData(PIPELINE_DRAG_TYPE, JSON.stringify({ kind: "pipeline-node", nodeId: node.id })); }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => reorderNode(event, node.id)} role="button" tabIndex={0} onClick={() => setSelectedNodeId(node.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setSelectedNodeId(node.id); }}><span className="pipeline-node__order">{String(index + 2).padStart(2, "0")}</span><span className="pipeline-node__glyph">{nodeGlyph(node)}</span><div><strong>{nodeTitle(node)}</strong><small>{nodeCategory(node)}</small></div><div className="pipeline-node__controls"><button type="button" aria-label={`Move ${nodeTitle(node)} up`} disabled={index === 0 || runState === "running"} onClick={(event) => { event.stopPropagation(); moveNode(node.id, -1); }}>↑</button><button type="button" aria-label={`Move ${nodeTitle(node)} down`} disabled={index === definition.nodes.length - 1 || runState === "running"} onClick={(event) => { event.stopPropagation(); moveNode(node.id, 1); }}>↓</button><button type="button" aria-label={`Remove ${nodeTitle(node)}`} disabled={runState === "running"} onClick={(event) => { event.stopPropagation(); removeNode(node.id); }}>×</button></div></div></div>)}
          {definition.nodes.length === 0 && <div className="pipeline-canvas__empty"><strong>Drop components here</strong><span>Drag FastTree, User trees, recombination methods, and selection methods from the left panel.</span></div>}
        </div>

        <aside className="pipeline-inspector">
          {selectedNodeId === DATA_NODE_ID ? <><div className="pipeline-inspector__heading"><span>FA</span><div><p className="eyebrow">Required input</p><h2>Data upload</h2></div></div><div className="pipeline-upload" onDragOver={(event) => event.preventDefault()} onDrop={dataDropped}><strong>Drop FASTA files or a directory</strong><span>Tree files in the same selection are retained for User trees matching.</span><div><label className="button button--secondary">Choose files<input type="file" multiple accept={FILE_ACCEPT} onChange={fileInputChanged} /></label><button type="button" className="button button--quiet" onClick={() => directoryInput.current?.click()}>Choose folder</button><input ref={directoryInput} className="visually-hidden" type="file" multiple onChange={fileInputChanged} /></div></div><div className="pipeline-file-summary"><div><span>Alignments</span><strong>{alignmentFiles.length}</strong></div><div><span>Tree files</span><strong>{treeFiles.length}</strong></div><div><span>Ignored</span><strong>{ignoredFiles}</strong></div></div>{files.length > 0 && <><div className="pipeline-file-list">{files.map((file) => <span key={`${pipelineFilePath(file)}-${file.size}`} className={isPipelineAlignmentFile(file) ? "is-alignment" : isPipelineTreeFile(file) ? "is-tree" : "is-ignored"}>{pipelineFilePath(file)}</span>)}</div><button type="button" className="button button--quiet button--full" disabled={runState === "running"} onClick={() => { setFiles([]); setPairingReport([]); setRunLog([]); }}>Clear files</button></>}</> : selectedNode !== undefined ? <><div className="pipeline-inspector__heading"><span>{nodeGlyph(selectedNode)}</span><div><p className="eyebrow">Component settings</p><h2>{nodeTitle(selectedNode)}</h2></div></div>{selectedNode.kind === "fasttree" ? <div className="pipeline-compact-grid"><label className="pipeline-compact-field"><span>Model</span><select value={String(selectedNode.parameters.model ?? "gtr")} onChange={(event) => updateNodeParameter(selectedNode.id, "model", event.target.value)}><option value="gtr">GTR + CAT</option></select></label><label className="pipeline-compact-toggle"><input type="checkbox" checked={Boolean(selectedNode.parameters.fastest ?? false)} onChange={(event) => updateNodeParameter(selectedNode.id, "fastest", event.target.checked)} /><span>Fastest topology search</span></label></div> : selectedNode.kind === "user-trees" ? <div className="pipeline-match-rule"><strong>Exact stem matching</strong><span><code>sample.fasta</code> matches <code>sample.nwk</code>, <code>sample.tree</code>, or another supported tree extension. Zero or multiple matches stop only that dataset.</span></div> : <div className="pipeline-compact-grid">{(modelForNode(selectedNode)?.plugin.manifest.parameters ?? []).map((parameter) => <div key={parameter.id}>{compactParameterControl({ parameter, value: selectedNode.parameters[parameter.id] ?? parameter.default, onChange: (value) => updateNodeParameter(selectedNode.id, parameter.id, value) })}</div>)}</div>}</> : null}
        </aside>
      </div>

      <section className="pipeline-run-panel">
        <div><p className="eyebrow">Validate and run</p><h2>{alignmentFiles.length} dataset{alignmentFiles.length === 1 ? "" : "s"} × {definition.nodes.filter((node) => node.kind === "model").length} method component{definition.nodes.filter((node) => node.kind === "model").length === 1 ? "" : "s"}</h2>{pipelineIssues.length > 0 ? <ul>{pipelineIssues.map((issue) => <li key={issue}>{issue}</li>)}</ul> : <p>Ready. Files run sequentially and every completed method result is saved independently.</p>}</div>
        {runState === "running" ? <div className="pipeline-run-progress"><strong>{progressLabel}</strong><div><span style={{ width: `${Math.round(progress * 100)}%` }} /></div><small>{Math.round(progress * 100)}%</small><button type="button" className="button button--quiet" onClick={cancelPipeline}>Cancel</button></div> : <button type="button" className="button button--run" disabled={pipelineIssues.length > 0} onClick={() => void runPipeline()}><span>Run pipeline</span><small>Show input pairing first · execute locally · save each result</small></button>}
      </section>

      {pairingReport.length > 0 && <section className="pipeline-report" aria-live="polite"><div className="pipeline-report__heading"><div><p className="eyebrow">Reported before computation</p><h2>User-tree input pairing</h2></div><span>{pairingReport.filter((row) => row.status === "matched").length}/{pairingReport.length} matched</span></div><div className="pipeline-pairing-table" role="table" aria-label="Full list of user tree matches"><div className="pipeline-pairing-table__header" role="row"><span role="columnheader">Alignment file</span><span role="columnheader">Matched tree file</span><span role="columnheader">Status</span></div>{pairingReport.map((row) => <div key={row.alignment} role="row"><span role="cell">{row.alignment}</span><span role="cell">{row.tree ?? (row.candidates.length > 0 ? row.candidates.join(", ") : "—")}</span><strong role="cell" className={`is-${row.status}`}>{row.status}</strong></div>)}</div></section>}

      {runLog.length > 0 && <section className="pipeline-report"><div className="pipeline-report__heading"><div><p className="eyebrow">Batch record</p><h2>Run log</h2></div><span>{runLog.filter((entry) => entry.tone === "complete").length} completed steps</span></div><div className="pipeline-log">{runLog.map((entry) => <div key={entry.id}><span>{entry.dataset}</span><strong>{entry.component}</strong><small className={`is-${entry.tone}`}>{entry.tone}</small><p>{entry.detail}</p></div>)}</div></section>}
    </div>
  );
}

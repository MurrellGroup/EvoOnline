import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import {
  createAlignmentArtifact,
  createTreeArtifact,
  type AlignmentArtifact,
  type TreeArtifact,
} from "@phylo-workbench/domain";
import type { ModelParameter, ParameterValues } from "@phylo-workbench/model-sdk";
import type { RecombinationCodonTreeSet } from "@phylo-workbench/model-diffubar/browser-source";
import type { SimulatedDataset, SimulatorAnalysisResult } from "@phylo-workbench/model-simulator/browser-source";
import { WidgetBridge } from "@phylo-workbench/viewer-bridge";
import { WidgetModal } from "./components/WidgetModal.js";
import type { RunProgress } from "./lib/diffubar-client.js";
import { getRegisteredModel, modelRegistry, type BrowserExecutorServices, type BrowserModelExecutor } from "./model-registry.js";
import { deleteSavedAnalysis, listSavedAnalyses, saveAnalysis, type SavedAnalysis } from "./lib/analysis-store.js";
import type { RecombinationCodonMethod } from "./components/RecombinationCodonHandoff.js";
import type { SimulatorBatchMethod } from "./components/simulator/SimulatorResultsView.js";

interface WidgetSnapshot {
  readonly alignment?: string;
  readonly tree?: string;
  readonly tags?: readonly string[];
}

type Notice = { readonly tone: "error" | "info" | "success"; readonly text: string };
type RunFailure = { readonly message: string; readonly stage: string; readonly model: string };

const stageLabels: Readonly<Record<string, string>> = {
  initialization: "Preparing inputs",
  "runtime-initialization": "Compiling the compute runtime",
  "global-fit": "Fitting the global codon model",
  "grid-preparation": "Building the rate grid",
  "conditional-likelihoods": "Evaluating conditional likelihoods",
  "clade-shift-null-runtime-initialization": "Compiling the CladeShift null-model runtime",
  "clade-shift-null-global-fit": "Fitting the CladeShift global codon model",
  "clade-shift-null-grid-preparation": "Constructing the CladeShift null grid",
  "clade-shift-null-conditional-likelihoods": "Evaluating the CladeShift null likelihood surface",
  "clade-shift-null-dirichlet-em": "Fitting the CladeShift null mixture",
  "clade-shift-null-tabulation": "Building null posterior surfaces",
  "clade-shift-compression": "Compressing site-wise null uncertainty",
  "clade-shift-runtime": "Preparing the all-clade message engine",
  "clade-shift-scan": "Scanning persistent descendant-clade shifts",
  "clade-shift-tabulation": "Integrating CladeShift posteriors",
  "triplet-scan": "Scanning informative taxa triplets",
  "breakpoint-hmm": "Marginalizing breakpoint uncertainty",
  "fasttree-runtime": "Compiling the FastTree runtime",
  "tree-family": "Fitting segment, pair, triplet, and global trees",
  "tree-hmm-emissions": "Caching per-site tree likelihoods",
  "tree-hmm": "Searching topology HMM subsets",
  "tree-refinement": "Refining Viterbi runs and trees",
  "tree-refinement-hmm": "Updating the refined topology HMM",
  "mosaicspr-proposals": "Scanning optional triplet region proposals",
  "mosaicspr-tree-family": "Fitting MosaicSPR topology seeds",
  "mosaicspr-search": "Searching the connected multi-SPR topology graph",
  "jemspr-initialization": "Preparing JEMSPR alignment states",
  "jemspr-worker-startup": "Starting the JEMSPR worker",
  "jemspr-seed-trees": "Inferring internal multiscale tree seeds",
  "jemspr-root-search": "Searching inferred root placements",
  "jemspr-tree-space": "Pricing the adaptive rooted-SPR graph",
  "jemspr-network-search": "Compiling and decoding switching networks",
  "jemspr-gtr-model": "Calibrating the fixed global GTR matrix",
  "jemspr-linked-likelihood": "Compiling the linked likelihood structure",
  "jemspr-branch-fit": "Fitting shared network-edge lengths",
  "jemspr-rate-fit": "Profiling custom site-rate variation",
  "jemspr-likelihood-path": "Likelihood-refining the genomic path",
  "jemspr-branch-refit": "Refitting linked lengths on the refined path",
  "branch-mixture-preparation": "Building branch-mixture operators",
  "branch-mixture-likelihoods": "Evaluating branch-mixture likelihoods",
  "approximate-fel": "Optimizing approximate FEL surfaces",
  "gibbs-sampler": "Sampling the posterior",
  "dirichlet-em": "Fitting the Dirichlet mixture",
  "branch-alternative": "Optimizing the joint BS-REL alternative",
  "branch-nulls": "Re-optimizing branch nulls locally",
  "glamma-fit": "Fitting Glamma distributions",
  "glamma-messages": "Passing all-to-all Glamma messages",
  "glamma-capped-sites": "Evaluating all-branches capped sites",
  "glamma-tabulation": "Integrating branch and site evidence",
  "tree-simulation": "Sampling coalescent genealogies",
  "recombination-simulation": "Placing ancestral recombination events",
  "sequence-simulation": "Evolving codon alignments",
  "scuff-diagnostics": "Propagating SCUFF diagnostics",
  tabulation: "Tabulating site posteriors",
  complete: "Complete",
};

function progressMetric(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const magnitude = Math.abs(value);
  if (magnitude >= 100_000) return value.toExponential(4);
  if (magnitude >= 1_000) return value.toFixed(2);
  return value.toFixed(4);
}

function elapsedLabel(milliseconds: number): string {
  if (milliseconds < 10_000) return `${(milliseconds / 1000).toFixed(1)} s`;
  if (milliseconds < 60_000) return `${Math.round(milliseconds / 1000)} s`;
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1000);
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

async function readTextFile(file: File): Promise<string> {
  if (file.size > 50 * 1024 * 1024) throw new Error("Files larger than 50 MiB are not accepted in this browser build.");
  return file.text();
}

function ParameterControl({
  parameter,
  value,
  onChange,
}: {
  readonly parameter: ModelParameter;
  readonly value: string | number | boolean;
  readonly onChange: (value: string | number | boolean) => void;
}) {
  if (parameter.type === "select") {
    return (
      <label className="field">
        <span>{parameter.label}</span>
        <select value={String(value)} onChange={(event) => onChange(event.target.value)}>
          {parameter.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <small>{parameter.description}</small>
      </label>
    );
  }
  if (parameter.type === "boolean") {
    return (
      <label className="toggle field-toggle">
        <input type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} />
        <span>{parameter.label}</span>
        <small>{parameter.description}</small>
      </label>
    );
  }
  return (
    <label className="field">
      <span>{parameter.label}</span>
      <input
        type="number"
        value={Number(value)}
        min={parameter.minimum}
        max={parameter.maximum}
        step={parameter.step}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <small>{parameter.description}</small>
    </label>
  );
}

export function App() {
  const alignmentFrame = useRef<HTMLIFrameElement>(null);
  const treeFrame = useRef<HTMLIFrameElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const [selectedModelId, setSelectedModelId] = useState(modelRegistry[0]?.plugin.manifest.id ?? "");
  const selectedModel = getRegisteredModel(selectedModelId);
  const [bridges, setBridges] = useState<{ alignment: WidgetBridge; tree: WidgetBridge }>();
  const bridgesRef = useRef<typeof bridges>(undefined);
  bridgesRef.current = bridges;
  const executorServices = useRef<BrowserExecutorServices>({ getAlignmentBridge: () => bridgesRef.current?.alignment });
  const executor = useRef<BrowserModelExecutor>(selectedModel.createExecutor(executorServices.current));
  const auxiliaryExecutor = useRef<BrowserModelExecutor | undefined>(undefined);
  const restoredParameters = useRef<ParameterValues | undefined>(undefined);
  const [alignment, setAlignment] = useState<AlignmentArtifact>();
  const [tree, setTree] = useState<TreeArtifact>();
  const [parameters, setParameters] = useState<ParameterValues>(() => selectedModel.plugin.defaultParameters());
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [alignmentOpen, setAlignmentOpen] = useState(false);
  const [treeOpen, setTreeOpen] = useState(false);
  const [applyingWidget, setApplyingWidget] = useState(false);
  const [fastTreeRunning, setFastTreeRunning] = useState(false);
  const [fastTreeFastest, setFastTreeFastest] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  const [runState, setRunState] = useState<"idle" | "running">("idle");
  const [progress, setProgress] = useState<RunProgress>({ stage: "", fraction: 0 });
  const progressRef = useRef<RunProgress>({ stage: "", fraction: 0 });
  const runGeneration = useRef(0);
  const [runFailure, setRunFailure] = useState<RunFailure>();
  const runStartedAt = useRef(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [analyses, setAnalyses] = useState<readonly SavedAnalysis[]>([]);
  const [activeAnalysisId, setActiveAnalysisId] = useState<string>();
  const [recombinationTrees, setRecombinationTrees] = useState<RecombinationCodonTreeSet>();
  const [simulationSource, setSimulationSource] = useState<SavedAnalysis["simulationSource"]>();
  const activeAnalysis = analyses.find((analysis) => analysis.id === activeAnalysisId);

  useEffect(() => {
    let active = true;
    void listSavedAnalyses().then((saved) => { if (active) setAnalyses(saved); }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (runState !== "running") return;
    const update = (): void => setElapsedMs(performance.now() - runStartedAt.current);
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [runState]);

  useEffect(() => {
    const next = {
      alignment: new WidgetBridge("alivibe", () => alignmentFrame.current?.contentWindow ?? null),
      tree: new WidgetBridge("phylotagger", () => treeFrame.current?.contentWindow ?? null),
    };
    setBridges(next);
    return () => {
      next.alignment.destroy();
      next.tree.destroy();
    };
  }, []);

  useEffect(() => {
    runGeneration.current += 1;
    const previous = executor.current;
    previous.dispose();
    const next = selectedModel.createExecutor(executorServices.current);
    executor.current = next;
    setRunState("idle");
    setParameters(restoredParameters.current ?? selectedModel.plugin.defaultParameters());
    restoredParameters.current = undefined;
    setRunFailure(undefined);
    return () => next.dispose();
  }, [selectedModelId]);

  useEffect(() => {
    if (activeAnalysis === undefined) return;
    const frame = requestAnimationFrame(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    return () => cancelAnimationFrame(frame);
  }, [activeAnalysisId]);

  const validation = useMemo(() => selectedModel.plugin.validate({
    ...(alignment === undefined ? {} : { alignment }),
    ...(tree === undefined ? {} : { tree }),
  }), [alignment, selectedModel, tree]);
  const manifest = selectedModel.plugin.manifest;
  const supportsRecombinationTrees = selectedModelId === "fubar" || selectedModelId === "fame" || selectedModelId === "flavor";
  const visibleParameters = manifest.parameters.filter((parameter) => showAdvanced || !parameter.advanced);
  const requiresForeground = manifest.inputSlots.some((slot) => slot.id === "foreground" && slot.required);
  const acceptsTree = manifest.inputSlots.some((slot) => slot.id === "tree");
  const requiresAlignment = manifest.inputSlots.some((slot) => slot.id === "alignment" && slot.required);
  const requiresTree = manifest.inputSlots.some((slot) => slot.id === "tree" && slot.required);
  const tagReady = !requiresForeground || tree?.tags.length === 2;
  const webGpuAvailable = typeof navigator !== "undefined" && "gpu" in navigator;

  const loadAlignment = async (file: File): Promise<void> => {
    try {
      setNotice({ tone: "info", text: "Reading alignment…" });
      const artifact = await createAlignmentArtifact(file.name, await readTextFile(file));
      setAlignment(artifact);
      setRecombinationTrees(undefined);
      setSimulationSource(undefined);
      setNotice({ tone: "success", text: `${artifact.taxa} sequences loaded.` });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    }
  };

  const loadTree = async (file: File): Promise<void> => {
    try {
      const sourceText = await readTextFile(file);
      const preparedText = selectedModel.plugin.prepareTreeInput?.(sourceText) ?? sourceText;
      const artifact = await createTreeArtifact(file.name, preparedText, "upload");
      setTree(artifact);
      setRecombinationTrees(undefined);
      setNotice({ tone: "success", text: "Phylogeny loaded." });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    }
  };

  const alignmentInput = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    if (file !== undefined) void loadAlignment(file);
    event.target.value = "";
  };

  const treeInput = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    if (file !== undefined) void loadTree(file);
    event.target.value = "";
  };

  const dropAlignment = (event: DragEvent<HTMLLabelElement>): void => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file !== undefined) void loadAlignment(file);
  };

  const openAlignmentEditor = (): void => {
    if (alignment === undefined || bridges === undefined) return;
    setAlignmentOpen(true);
    void bridges.alignment.request("set-alignment", { text: alignment.text }).then(async () => {
      if (tree !== undefined) await bridges.alignment.request("set-tree", { text: tree.text });
    }).catch((error: unknown) => setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) }));
  };

  const applyAlignmentEditor = async (): Promise<void> => {
    if (alignment === undefined || bridges === undefined) return;
    setApplyingWidget(true);
    try {
      const snapshot = await bridges.alignment.request<WidgetSnapshot>("get-alignment");
      if (!snapshot.alignment) throw new Error("The alignment editor returned no sequences.");
      const artifact = await createAlignmentArtifact(alignment.name, snapshot.alignment);
      setAlignment(artifact);
      setRecombinationTrees(undefined);
      setSimulationSource(undefined);
      if (tree === undefined && snapshot.tree) setTree(await createTreeArtifact("inferred-tree.nwk", snapshot.tree, "editor"));
      setAlignmentOpen(false);
      setNotice({ tone: "success", text: "Alignment edits applied to the workspace." });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setApplyingWidget(false);
    }
  };

  const runFastTree = async (): Promise<void> => {
    if (alignment === undefined || bridges === undefined) return;
    setFastTreeRunning(true);
    setNotice({ tone: "info", text: "FastTree is loading and inferring the phylogeny…" });
    try {
      const snapshot = await bridges.alignment.request<WidgetSnapshot>("run-fasttree", {
        alignment: alignment.text,
        model: "gtr",
        fastest: fastTreeFastest,
      }, 10 * 60_000);
      if (!snapshot.tree) throw new Error("FastTree returned no tree.");
      setTree(await createTreeArtifact("fasttree.nwk", snapshot.tree, "fasttree"));
      setRecombinationTrees(undefined);
      setNotice({ tone: "success", text: "FastTree phylogeny added to the workspace." });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setFastTreeRunning(false);
    }
  };

  const openTreeTagger = (): void => {
    if (tree === undefined || bridges === undefined) return;
    setTreeOpen(true);
    void bridges.tree.request("set-tree", { text: tree.text })
      .catch((error: unknown) => setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) }));
  };

  const applyTreeTagger = async (): Promise<void> => {
    if (tree === undefined || bridges === undefined) return;
    setApplyingWidget(true);
    try {
      const snapshot = await bridges.tree.request<WidgetSnapshot>("get-tree");
      if (!snapshot.tree) throw new Error("The tree tagger returned no tree.");
      const artifact = await createTreeArtifact(tree.name, snapshot.tree, "editor");
      setTree(artifact);
      setRecombinationTrees(undefined);
      setTreeOpen(false);
      setNotice(requiresForeground
        ? {
            tone: artifact.tags.length === 2 ? "success" : "info",
            text: artifact.tags.length === 2 ? "G1 and G2 branch groups applied." : "Tree applied; DifFUBAR still needs exactly two branch groups.",
          }
        : { tone: "success", text: "Tree changes applied to the workspace." });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setApplyingWidget(false);
    }
  };

  const updateParameter = (id: string, value: string | number | boolean): void => {
    setParameters((current) => ({ ...current, [id]: value }));
  };

  const runAnalysis = async (): Promise<void> => {
    if ((requiresAlignment && alignment === undefined) || (requiresTree && tree === undefined) || !validation.ready) return;
    const generation = ++runGeneration.current;
    const model = selectedModel;
    const activeExecutor = executor.current;
    runStartedAt.current = performance.now();
    setElapsedMs(0);
    setRunState("running");
    const initialProgress: RunProgress = { stage: "initialization", fraction: 0, message: manifest.id === "simulator" ? "Starting deterministic simulation worker" : requiresForeground ? "Parsing alignment and tagged tree" : requiresTree ? "Parsing alignment and phylogeny" : "Parsing nucleotide alignment", indeterminate: true };
    progressRef.current = initialProgress;
    setProgress(initialProgress);
    setRunFailure(undefined);
    setNotice(undefined);
    try {
      const next = await activeExecutor.run(alignment?.text ?? "", tree?.text ?? "", parameters, (nextProgress) => {
        if (runGeneration.current !== generation) return;
        progressRef.current = nextProgress;
        setProgress(nextProgress);
      }, !supportsRecombinationTrees || recombinationTrees === undefined ? undefined : { recombinationTrees });
      if (runGeneration.current !== generation) return;
      const id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `analysis-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const saved: SavedAnalysis = {
        id,
        modelId: model.plugin.manifest.id,
        title: alignment === undefined ? `${model.plugin.manifest.shortTitle} · ${new Date().toLocaleTimeString()}` : `${model.plugin.manifest.shortTitle} · ${alignment.name}`,
        createdAt: Date.now(),
        parameters: { ...parameters },
        ...(alignment === undefined ? {} : { alignment }),
        ...(tree === undefined ? {} : { tree }),
        result: next,
        ...(!supportsRecombinationTrees || recombinationTrees === undefined ? {} : { recombinationTrees }),
        ...(simulationSource === undefined || model.plugin.manifest.id === "simulator" ? {} : { simulationSource }),
      };
      setAnalyses((current) => [saved, ...current.filter((analysis) => analysis.id !== saved.id)]);
      setActiveAnalysisId(saved.id);
      void saveAnalysis(saved).catch((error: unknown) => setNotice({ tone: "info", text: `Analysis completed, but browser persistence failed: ${error instanceof Error ? error.message : String(error)}` }));
      setRunFailure(undefined);
      setNotice({ tone: "success", text: model.completionMessage(next) });
    } catch (error) {
      if (runGeneration.current === generation && !(error instanceof DOMException && error.name === "AbortError")) {
        const message = error instanceof Error ? error.message : String(error);
        setRunFailure({ message, stage: progressRef.current.stage, model: model.plugin.manifest.shortTitle });
        setNotice({ tone: "error", text: `${model.plugin.manifest.shortTitle} stopped: ${message}` });
      }
    } finally {
      if (runGeneration.current === generation) setRunState("idle");
    }
  };

  const cancelAnalysis = (): void => {
    runGeneration.current += 1;
    executor.current.cancel();
    auxiliaryExecutor.current?.cancel();
    auxiliaryExecutor.current = undefined;
    setRunState("idle");
    setRunFailure(undefined);
    setNotice({ tone: "info", text: "Analysis cancelled." });
  };

  const openSavedAnalysis = (saved: SavedAnalysis): void => {
    setActiveAnalysisId(saved.id);
    setAlignment(saved.alignment);
    setTree(saved.tree);
    setRecombinationTrees(saved.recombinationTrees);
    setSimulationSource(saved.simulationSource);
    if (saved.modelId === selectedModelId) setParameters(saved.parameters);
    else {
      restoredParameters.current = saved.parameters;
      setSelectedModelId(saved.modelId);
    }
    setNotice({ tone: "info", text: `Restored ${saved.title}. Inputs and results remain device-local.` });
  };

  const removeSavedAnalysis = (saved: SavedAnalysis): void => {
    if (!window.confirm(`Delete the saved result “${saved.title}”? This cannot be undone.`)) return;
    setAnalyses((current) => current.filter((analysis) => analysis.id !== saved.id));
    if (activeAnalysisId === saved.id) setActiveAnalysisId(undefined);
    void deleteSavedAnalysis(saved.id).catch((error: unknown) => setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) }));
  };

  const loadRecombinationTrees = async (method: RecombinationCodonMethod, treeSet: RecombinationCodonTreeSet): Promise<void> => {
    const source = activeAnalysis;
    if (source?.alignment === undefined) return;
    try {
      const representative = treeSet.segments[0];
      if (representative === undefined) throw new Error("The recombination partition has no regional tree.");
      const treeArtifact = await createTreeArtifact(`${treeSet.sourceMethod}-regional-master.nwk`, representative.tree, "editor");
      setAlignment(source.alignment);
      setTree(treeArtifact);
      setRecombinationTrees(treeSet);
      setSelectedModelId(method);
      setNotice({ tone: "success", text: `${treeSet.segments.length} ${treeSet.sourceMethod} regional trees loaded into ${method.toUpperCase()}. Relative branch-length scales are locked; the global codon model will be estimated jointly.` });
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    }
  };

  const simulatorTreeSet = (dataset: SimulatedDataset): RecombinationCodonTreeSet | undefined => dataset.localTrees.length <= 1 ? undefined : {
    schemaVersion: 1,
    sourceMethod: "simulation-truth",
    branchLengthSource: "method-final-trees",
    branchScalePolicy: "fixed-relative",
    codonAssignment: "middle-nucleotide",
    segments: dataset.localTrees.map((region) => ({ startCodon: region.startCodon, endCodon: region.endCodon, tree: region.tree.newick, label: `Simulated true region ${region.startCodon}–${region.endCodon}` })),
  };

  const loadSimulatedDataset = async (dataset: SimulatedDataset): Promise<void> => {
    if (dataset.fasta === undefined) { setNotice({ tone: "error", text: "This replicate contains a tree only; simulate alignments before loading it into a codon method." }); return; }
    try {
      const nextAlignment = await createAlignmentArtifact(`${dataset.id}.fasta`, dataset.fasta);
      const nextTree = await createTreeArtifact(`${dataset.id}.nwk`, dataset.tree.newick, "editor");
      setAlignment(nextAlignment);
      setTree(nextTree);
      setRecombinationTrees(simulatorTreeSet(dataset));
      if (activeAnalysis?.modelId === "simulator") {
        const simulation = activeAnalysis.result as SimulatorAnalysisResult;
        const datasetIndex = simulation.datasets.findIndex((candidate) => candidate.id === dataset.id);
        if (datasetIndex >= 0) setSimulationSource({ simulationAnalysisId: activeAnalysis.id, datasetId: dataset.id, datasetIndex });
      }
      setSelectedModelId("fubar");
      setNotice({ tone: "success", text: `${dataset.id} loaded into FUBAR${dataset.localTrees.length > 1 ? ` with ${dataset.localTrees.length} known regional trees` : ""}.` });
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) { setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) }); }
  };

  const batchSimulatedDatasets = async (method: SimulatorBatchMethod, datasets: readonly SimulatedDataset[], simulation: SimulatorAnalysisResult): Promise<void> => {
    if (datasets.length === 0) return;
    const simulationAnalysisId = activeAnalysis?.modelId === "simulator" ? activeAnalysis.id : undefined;
    if (simulationAnalysisId === undefined) { setNotice({ tone: "error", text: "Reopen the saved simulator result before starting a linked inference batch." }); return; }
    const generation = ++runGeneration.current;
    const target = getRegisteredModel(method);
    const completed: SavedAnalysis[] = [];
    setRunState("running");
    runStartedAt.current = performance.now();
    setElapsedMs(0);
    setNotice({ tone: "info", text: `Running ${target.plugin.manifest.shortTitle} on ${datasets.length} simulated dataset${datasets.length === 1 ? "" : "s"}…` });
    try {
      for (let index = 0; index < datasets.length; index += 1) {
        if (generation !== runGeneration.current) throw new DOMException("Batch cancelled.", "AbortError");
        const dataset = datasets[index]!;
        if (dataset.fasta === undefined) throw new Error(`${dataset.id} has no simulated alignment.`);
        const batchExecutor = target.createExecutor(executorServices.current);
        auxiliaryExecutor.current = batchExecutor;
        const nextAlignment = await createAlignmentArtifact(`${dataset.id}.fasta`, dataset.fasta);
        const nextTree = await createTreeArtifact(`${dataset.id}.nwk`, dataset.tree.newick, "editor");
        const regionalTrees = simulatorTreeSet(dataset);
        const targetParameters = target.plugin.defaultParameters();
        const output = await batchExecutor.run(nextAlignment.text, nextTree.text, targetParameters, (entry) => {
          if (generation !== runGeneration.current) return;
          const aggregate = (index + Math.max(0, Math.min(1, entry.fraction))) / datasets.length;
          const nextProgress = { ...entry, fraction: aggregate, message: `Dataset ${index + 1}/${datasets.length} · ${entry.message ?? stageLabels[entry.stage] ?? entry.stage}` };
          progressRef.current = nextProgress;
          setProgress(nextProgress);
        }, regionalTrees === undefined ? undefined : { recombinationTrees: regionalTrees });
        batchExecutor.dispose();
        auxiliaryExecutor.current = undefined;
        const id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `analysis-${Date.now()}-${index}`;
        const datasetIndex = simulation.datasets.findIndex((candidate) => candidate.id === dataset.id);
        const saved: SavedAnalysis = { id, modelId: method, title: `${target.plugin.manifest.shortTitle} · simulated dataset ${Math.max(0, datasetIndex) + 1}`, createdAt: Date.now() + index, parameters: targetParameters, alignment: nextAlignment, tree: nextTree, result: output, ...(regionalTrees === undefined ? {} : { recombinationTrees: regionalTrees }), simulationSource: { simulationAnalysisId, datasetId: dataset.id, datasetIndex: Math.max(0, datasetIndex) } };
        completed.push(saved);
        await saveAnalysis(saved);
      }
      if (generation !== runGeneration.current) return;
      setAnalyses((current) => [...completed].reverse().concat(current));
      setActiveAnalysisId(completed.at(-1)?.id);
      setSimulationSource(completed.at(-1)?.simulationSource);
      setNotice({ tone: "success", text: `${target.plugin.manifest.shortTitle} batch completed for ${completed.length} simulated datasets. The results are saved independently.` });
      void simulation;
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) setNotice({ tone: "error", text: `${target.plugin.manifest.shortTitle} batch stopped: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      auxiliaryExecutor.current?.dispose();
      auxiliaryExecutor.current = undefined;
      if (generation === runGeneration.current) setRunState("idle");
    }
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">φ</span>
          <div><strong>EvoOnline</strong><span>Local phylogenetic analysis</span></div>
        </div>
        <div className="runtime-badges">
          <span className={webGpuAvailable ? "status-dot is-online" : "status-dot"} />
          {webGpuAvailable ? "WebGPU available" : "WASM fallback"}
          <span className="runtime-divider" />
          {navigator.hardwareConcurrency || 1} logical cores
        </div>
      </header>

      <aside className="model-sidebar">
        <div className="sidebar-heading">
          <span>Analysis methods</span>
          <strong>{modelRegistry.length}</strong>
        </div>
        {modelRegistry.map((registration) => (
          <button
            key={registration.plugin.manifest.id}
            type="button"
            className={`model-card ${registration.plugin.manifest.id === selectedModelId ? "is-active" : ""}`}
            onClick={() => setSelectedModelId(registration.plugin.manifest.id)}
          >
            <span className="model-card__glyph">{registration.glyph}</span>
            <span><strong>{registration.plugin.manifest.shortTitle}</strong><small>{registration.plugin.manifest.category} analysis</small></span>
            <span className="model-card__runtime">{registration.runtimeLabel}</span>
          </button>
        ))}
        <div className="future-models">
          <span>+</span>
          <p><strong>Model-ready architecture</strong>Additional methods register inputs, parameters, runtimes, and result renderers through the same contract.</p>
        </div>
        <div className="analysis-history">
          <div className="sidebar-heading"><span>Saved analyses</span><strong>{analyses.length}</strong></div>
          {analyses.length === 0 && <p>No completed analyses yet. Results are retained here across method switches and page reloads.</p>}
          {analyses.map((saved) => <div key={saved.id} className={`analysis-history__item ${saved.id === activeAnalysisId ? "is-active" : ""}`}><button type="button" disabled={runState === "running"} onClick={() => openSavedAnalysis(saved)}><strong>{saved.title}</strong><small>{new Date(saved.createdAt).toLocaleString()} · {saved.modelId === "simulator" ? "generated datasets" : saved.recombinationTrees === undefined ? "single tree" : `${saved.recombinationTrees.segments.length} regional trees`}</small></button><button type="button" className="analysis-history__delete" aria-label={`Delete ${saved.title}`} onClick={() => removeSavedAnalysis(saved)}>×</button></div>)}
        </div>
      </aside>

      <main className="workspace">
        <section className="workspace-hero">
          <div>
            <p className="eyebrow">{manifest.category} analysis / {manifest.shortTitle}</p>
            <h1>{manifest.id === "simulator" ? "Design, simulate, inspect, and export evolutionary datasets" : "Build an analysis-ready phylogenetic workspace"}</h1>
            <p>{manifest.id === "simulator"
              ? "Shape a sampled coalescent genealogy, choose a codon process, optionally layer in ancestral recombination and hidden carrier lineages, then generate a reproducible batch entirely in your browser."
            : requiresForeground
              ? "Load a codon alignment, inspect or edit it, attach a phylogeny, tag two foreground groups, then run entirely in this browser."
            : requiresTree
                ? `Load a codon alignment, inspect or edit it, attach a phylogeny, then run ${manifest.shortTitle} entirely in this browser.`
                : manifest.id === "jemspr"
                  ? "Load an aligned nucleotide FASTA, then infer the latent rooted master, local trees, breakpoints, and coherent event network jointly inside this browser."
                  : `Load an aligned nucleotide FASTA, inspect or edit it, then run ${manifest.shortTitle} entirely in this browser; segment trees are inferred only after breakpoint scanning.`}</p>
          </div>
          <div className="privacy-note"><span>Device-local</span>Your sequence data is not uploaded by the browser runner.</div>
        </section>

        {notice !== undefined && (
          <div className={`notice notice--${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>
            {notice.text}<button type="button" aria-label="Dismiss message" onClick={() => setNotice(undefined)}>×</button>
          </div>
        )}

        {(requiresAlignment || acceptsTree || requiresForeground) && <div className="workflow-grid">
          <section className={`workflow-card ${alignment !== undefined ? "is-complete" : ""}`}>
            <div className="step-number">01</div>
            <div className="workflow-card__heading">
              <div><h2>Alignment</h2><p>Aligned nucleotide FASTA</p></div>
              {alignment !== undefined && <span className="ready-chip">Ready</span>}
            </div>
            {alignment === undefined ? (
              <label className="drop-zone" onDragOver={(event) => event.preventDefault()} onDrop={dropAlignment}>
                <input type="file" accept=".fa,.fas,.fasta,.aln,.txt" onChange={alignmentInput} />
                <span className="drop-zone__icon">↑</span>
                <strong>Drop an alignment</strong>
                <small>or choose a FASTA file · up to 50 MiB</small>
              </label>
            ) : (
              <div className="artifact">
                <div className="artifact__name"><span>FA</span><div><strong>{alignment.name}</strong><small>{alignment.sha256.slice(0, 12)}…</small></div></div>
                <dl>
                  <div><dt>Taxa</dt><dd>{alignment.taxa}</dd></div>
                  <div><dt>Sites</dt><dd>{alignment.sites.toLocaleString()}</dd></div>
                  <div><dt>{manifest.category === "recombination" ? "Layout" : "Frame"}</dt><dd>{manifest.category === "recombination" ? "Aligned nucleotides" : alignment.divisibleByThree ? "Codon-ready" : "Needs edit"}</dd></div>
                </dl>
                <div className="artifact__actions">
                  <button type="button" className="button button--secondary" onClick={openAlignmentEditor}>Open alignment editor</button>
                  <label className="button button--quiet">Replace<input type="file" accept=".fa,.fas,.fasta,.aln,.txt" onChange={alignmentInput} /></label>
                </div>
              </div>
            )}
          </section>

          {acceptsTree && <section className={`workflow-card ${tree !== undefined ? "is-complete" : ""}`}>
            <div className="step-number">02</div>
            <div className="workflow-card__heading">
              <div><h2>Phylogeny</h2><p>Upload or infer a tree</p></div>
              {tree !== undefined && <span className="ready-chip">Ready</span>}
            </div>
            {tree === undefined ? (
              <div className="tree-choices">
                <label className="tree-choice">
                  <input type="file" accept=".nwk,.newick,.tree,.tre,.nex,.nexus,.txt" onChange={treeInput} />
                  <span>↑</span><strong>Upload tree</strong><small>Newick or NEXUS</small>
                </label>
                <div className="choice-or">or</div>
                <div className="tree-choice tree-choice--fasttree">
                  <span>FT</span><strong>Infer with FastTree</strong><small>GTR+CAT via bioWASM</small>
                  <label className="compact-toggle"><input type="checkbox" checked={fastTreeFastest} onChange={(event) => setFastTreeFastest(event.target.checked)} /> Fastest mode</label>
                  <button type="button" className="button button--secondary" disabled={alignment === undefined || fastTreeRunning} onClick={() => void runFastTree()}>
                    {fastTreeRunning ? "Running FastTree…" : "Run FastTree"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="artifact">
                <div className="artifact__name"><span>NW</span><div><strong>{tree.name}</strong><small>{tree.source} · {tree.sha256.slice(0, 12)}…</small></div></div>
                <dl>
                  <div><dt>Source</dt><dd>{tree.source}</dd></div>
                  <div><dt>Tags</dt><dd>{tree.tags.length > 0 ? tree.tags.join(", ") : "None"}</dd></div>
                </dl>
                <div className="artifact__actions">
                  <button type="button" className="button button--secondary" onClick={openTreeTagger}>{requiresForeground ? "View and tag tree" : "View tree"}</button>
                  <label className="button button--quiet">Replace<input type="file" accept=".nwk,.newick,.tree,.tre,.nex,.nexus,.txt" onChange={treeInput} /></label>
                </div>
              </div>
            )}
          </section>}

          {requiresForeground && (
            <section className={`workflow-card workflow-card--foreground ${tagReady ? "is-complete" : ""}`}>
              <div className="step-number">03</div>
              <div className="workflow-card__heading">
                <div><h2>Foreground groups</h2><p>Tag the branches DifFUBAR will compare</p></div>
                {tagReady && <span className="ready-chip">2 groups</span>}
              </div>
              <div className="tag-summary">
                <div className={`tag-group tag-group--g1 ${tree?.tags.includes("G1") ? "is-present" : ""}`}><span>G1</span><p>First foreground class</p></div>
                <div className={`tag-group tag-group--g2 ${tree?.tags.includes("G2") ? "is-present" : ""}`}><span>G2</span><p>Second foreground class</p></div>
              </div>
              <p className="card-guidance">Use clade, node-to-root, regex, or box selection in Phylotagger, then apply G1 or G2.</p>
              <button type="button" className="button button--secondary button--full" disabled={tree === undefined} onClick={openTreeTagger}>
                {tree === undefined ? "Add a tree first" : tagReady ? "Review branch tags" : "Open tree tagger"}
              </button>
            </section>
          )}
        </div>}

        <section className="run-panel">
          <div className="run-panel__header">
            <div><p className="eyebrow">{manifest.id === "simulator" ? "Configure and generate" : `${requiresForeground ? "04" : acceptsTree ? "03" : "02"} / Configure and run`}</p><h2>{manifest.title}</h2><p>{manifest.description}</p></div>
            <div className="runtime-choice"><span>Execution</span><strong>{String(parameters.backend ?? selectedModel.runtimeLabel)}</strong><small>{manifest.id === "simulator" ? "Dedicated worker · exact stochastic process · device-local outputs" : manifest.id === "fsart" ? "Parallel informative-triplet workers · local FastTree WASM" : manifest.id === "jemspr" ? "Internal topology/network search · FastTree supplies only a fixed GTR matrix · custom linked ML" : webGpuAvailable ? "Parallel WASM recommended · WebGPU available" : "Parallel WASM available"}</small></div>
          </div>
          {supportsRecombinationTrees && recombinationTrees !== undefined && <div className="recombination-context"><strong>{recombinationTrees.sourceMethod.toUpperCase()} regional-tree mode</strong><span>{recombinationTrees.segments.length} codon regions · {recombinationTrees.branchLengthSource} · fixed relative branch scales · middle-nucleotide codon assignment</span><button type="button" className="button button--quiet" onClick={() => setRecombinationTrees(undefined)}>Use only the displayed tree</button></div>}
          {selectedModel.SetupView === undefined ? <><div className="parameter-grid">
            {visibleParameters.map((parameter) => (
              <ParameterControl key={parameter.id} parameter={parameter} value={parameters[parameter.id] ?? parameter.default} onChange={(value) => updateParameter(parameter.id, value)} />
            ))}
          </div><button type="button" className="advanced-toggle" onClick={() => setShowAdvanced((value) => !value)}>{showAdvanced ? "Hide advanced parameters" : "Show advanced parameters"}</button></> : <selectedModel.SetupView parameters={parameters} onChange={setParameters} disabled={runState === "running"} />}

          <div className="validation-strip">
            {requiresAlignment && <div className={alignment !== undefined ? "is-valid" : ""}><span>{alignment !== undefined ? "✓" : "1"}</span>Alignment</div>}
            {acceptsTree && <div className={tree !== undefined ? "is-valid" : ""}><span>{tree !== undefined ? "✓" : "2"}</span>Tree</div>}
            {requiresForeground && <div className={tagReady ? "is-valid" : ""}><span>{tagReady ? "✓" : "3"}</span>Two groups</div>}
            <div className={validation.ready ? "is-valid" : ""}><span>{validation.ready ? "✓" : requiresForeground ? "4" : acceptsTree ? "3" : requiresAlignment ? "2" : "1"}</span>{manifest.id === "simulator" ? "Configuration ready" : "Validated"}</div>
          </div>

          {!validation.ready && validation.issues.length > 0 && (
            <div className="validation-issues">
              {validation.issues.map((issue) => <p key={`${issue.code}-${issue.artifact ?? "model"}`}>{issue.message}</p>)}
            </div>
          )}

          {runState === "running" ? (
            <div className="run-progress" role="status">
              <div className="run-progress__heading">
                <strong>{stageLabels[progress.stage] ?? progress.stage}</strong>
                <span>{progress.indeterminate ? `${progress.fraction > 0 ? `phase ${Math.round(progress.fraction * 100)}% · ` : ""}active` : `phase ${Math.round(progress.fraction * 100)}%`}</span>
              </div>
              <div className={`run-progress__bar ${progress.indeterminate ? "is-indeterminate" : ""}`} aria-hidden="true">
                <span style={progress.indeterminate ? undefined : { width: `${Math.max(0, Math.min(100, progress.fraction * 100))}%` }} />
              </div>
              <div className="run-progress__detail">
                {progress.message !== undefined && <span>{progress.message}</span>}
                {progress.current !== undefined && progress.total !== undefined && <span>{progress.current.toLocaleString()} / {progress.total.toLocaleString()}</span>}
                {progress.metricValue !== undefined && <span>{progress.metricLabel ?? "value"} {progressMetric(progress.metricValue)}</span>}
                <span>elapsed {elapsedLabel(elapsedMs)}</span>
              </div>
              <button type="button" className="button button--quiet" onClick={cancelAnalysis}>Cancel</button>
            </div>
          ) : (
            <button type="button" className="button button--run" disabled={!validation.ready || (requiresAlignment && alignment === undefined) || (requiresTree && tree === undefined)} onClick={() => void runAnalysis()}>
              <span>{manifest.id === "simulator" ? "Simulate datasets" : `Run ${manifest.shortTitle}`}</span><small>{manifest.id === "simulator" ? "Reproducible worker · tree truth · optional alignment and recombination truth" : manifest.id === "fsart" ? "Pair-covered triplet scan · FastTree-WASM tree-family HMM" : manifest.id === "jemspr" ? "Internal event-network search · coherent shared-length ML · optional likelihood path refinement" : parameters.backend === "webgpu" ? "Experimental WebGPU kernel" : parameters.backend === "wasm" ? "Exact single-worker WASM" : "Exact parallel WASM (recommended)"}</small>
            </button>
          )}
          {runFailure !== undefined && runFailure.model === manifest.shortTitle && (
            <div className="run-failure" role="alert">
              <div><strong>{runFailure.model} stopped during {(stageLabels[runFailure.stage] ?? runFailure.stage) || "startup"}.</strong><span>{runFailure.message}</span></div>
              <button type="button" aria-label="Dismiss run error" onClick={() => setRunFailure(undefined)}>×</button>
            </div>
          )}
        </section>

        {activeAnalysis !== undefined && (() => { const resultModel = getRegisteredModel(activeAnalysis.modelId); const ResultView = resultModel.ResultView; const simulationInferenceAnalyses = activeAnalysis.modelId === "simulator" ? analyses.filter((analysis) => analysis.simulationSource?.simulationAnalysisId === activeAnalysis.id) : undefined; return <div ref={resultsRef} className="results-anchor"><div className="saved-result-banner"><span>Viewing saved result</span><strong>{activeAnalysis.title}</strong><small>{new Date(activeAnalysis.createdAt).toLocaleString()}</small></div><ResultView result={activeAnalysis.result} parameters={activeAnalysis.parameters} alignment={activeAnalysis.alignment?.text ?? ""} onLoadRecombinationTrees={(method, treeSet) => void loadRecombinationTrees(method, treeSet)} onLoadSimulatedDataset={(dataset) => loadSimulatedDataset(dataset)} onBatchSimulatedDatasets={(method, datasets, result) => batchSimulatedDatasets(method, datasets, result)} {...(simulationInferenceAnalyses === undefined ? {} : { simulationInferenceAnalyses })} /></div>; })()}
      </main>

      {bridges !== undefined && alignment !== undefined && (
        <WidgetModal
          open={alignmentOpen}
          title="Alignment viewer and editor"
          description="Inspect, realign, clean reading frames, edit cells, or infer a phylogeny. Changes stay draft until applied."
          source={`${import.meta.env.BASE_URL}widgets/alivibe.html`}
          frameRef={alignmentFrame}
          applyLabel="Apply alignment"
          applying={applyingWidget}
          onCancel={() => setAlignmentOpen(false)}
          onApply={() => void applyAlignmentEditor()}
        />
      )}
      {bridges !== undefined && tree !== undefined && (
        <WidgetModal
          open={treeOpen}
          title={requiresForeground ? "Phylogeny viewer and branch tagger" : "Phylogeny viewer"}
          description={requiresForeground ? "Select branches or clades and assign G1 and G2. DifFUBAR compares those two foreground classes." : `Inspect the phylogeny and branch lengths. ${manifest.shortTitle} uses an untagged tree, so tags are not required.`}
          source={`${import.meta.env.BASE_URL}widgets/phylotagger.html`}
          frameRef={treeFrame}
          applyLabel={requiresForeground ? "Apply tagged tree" : "Apply tree"}
          applying={applyingWidget}
          onCancel={() => setTreeOpen(false)}
          onApply={() => void applyTreeTagger()}
        />
      )}
    </div>
  );
}

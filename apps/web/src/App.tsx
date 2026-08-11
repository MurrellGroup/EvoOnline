import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import {
  createAlignmentArtifact,
  createTreeArtifact,
  type AlignmentArtifact,
  type TreeArtifact,
} from "@phylo-workbench/domain";
import type { ModelParameter, ParameterValues } from "@phylo-workbench/model-sdk";
import { WidgetBridge } from "@phylo-workbench/viewer-bridge";
import { WidgetModal } from "./components/WidgetModal.js";
import type { RunProgress } from "./lib/diffubar-client.js";
import { getRegisteredModel, modelRegistry, type BrowserModelExecutor } from "./model-registry.js";

interface WidgetSnapshot {
  readonly alignment?: string;
  readonly tree?: string;
  readonly tags?: readonly string[];
}

type Notice = { readonly tone: "error" | "info" | "success"; readonly text: string };

const stageLabels: Readonly<Record<string, string>> = {
  initialization: "Preparing inputs",
  "runtime-initialization": "Compiling the compute runtime",
  "global-fit": "Fitting the global codon model",
  "grid-preparation": "Building the rate grid",
  "conditional-likelihoods": "Evaluating conditional likelihoods",
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
  const executor = useRef<BrowserModelExecutor>(selectedModel.createExecutor());
  const [bridges, setBridges] = useState<{ alignment: WidgetBridge; tree: WidgetBridge }>();
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
  const runStartedAt = useRef(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [result, setResult] = useState<unknown>();

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
    executor.current.dispose();
    executor.current = selectedModel.createExecutor();
    setParameters(selectedModel.plugin.defaultParameters());
    setResult(undefined);
    return () => executor.current.dispose();
  }, [selectedModelId]);

  useEffect(() => {
    setResult(undefined);
  }, [alignment?.id, tree?.id]);

  useEffect(() => {
    if (result === undefined) return;
    const frame = requestAnimationFrame(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    return () => cancelAnimationFrame(frame);
  }, [result]);

  const validation = useMemo(() => selectedModel.plugin.validate({
    ...(alignment === undefined ? {} : { alignment }),
    ...(tree === undefined ? {} : { tree }),
  }), [alignment, selectedModel, tree]);
  const manifest = selectedModel.plugin.manifest;
  const visibleParameters = manifest.parameters.filter((parameter) => showAdvanced || !parameter.advanced);
  const requiresForeground = manifest.inputSlots.some((slot) => slot.id === "foreground" && slot.required);
  const tagReady = !requiresForeground || tree?.tags.length === 2;
  const webGpuAvailable = typeof navigator !== "undefined" && "gpu" in navigator;

  const loadAlignment = async (file: File): Promise<void> => {
    try {
      setNotice({ tone: "info", text: "Reading alignment…" });
      const artifact = await createAlignmentArtifact(file.name, await readTextFile(file));
      setAlignment(artifact);
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
    if (alignment === undefined || tree === undefined || !validation.ready) return;
    runStartedAt.current = performance.now();
    setElapsedMs(0);
    setRunState("running");
    setResult(undefined);
    setProgress({ stage: "initialization", fraction: 0, message: requiresForeground ? "Parsing alignment and tagged tree" : "Parsing alignment and phylogeny", indeterminate: true });
    setNotice(undefined);
    try {
      const next = await executor.current.run(alignment.text, tree.text, parameters, setProgress);
      setResult(next);
      setNotice({ tone: "success", text: selectedModel.completionMessage(next) });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      setRunState("idle");
    }
  };

  const cancelAnalysis = (): void => {
    executor.current.cancel();
    setRunState("idle");
    setNotice({ tone: "info", text: "Analysis cancelled." });
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
      </aside>

      <main className="workspace">
        <section className="workspace-hero">
          <div>
            <p className="eyebrow">Selection analysis / {manifest.shortTitle}</p>
            <h1>Build an analysis-ready phylogenetic workspace</h1>
            <p>{requiresForeground
              ? "Load a codon alignment, inspect or edit it, attach a phylogeny, tag two foreground groups, then run entirely in this browser."
              : `Load a codon alignment, inspect or edit it, attach a phylogeny, then run ${manifest.shortTitle} entirely in this browser.`}</p>
          </div>
          <div className="privacy-note"><span>Device-local</span>Your sequence data is not uploaded by the browser runner.</div>
        </section>

        {notice !== undefined && (
          <div className={`notice notice--${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>
            {notice.text}<button type="button" aria-label="Dismiss message" onClick={() => setNotice(undefined)}>×</button>
          </div>
        )}

        <div className="workflow-grid">
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
                  <div><dt>Frame</dt><dd>{alignment.divisibleByThree ? "Codon-ready" : "Needs edit"}</dd></div>
                </dl>
                <div className="artifact__actions">
                  <button type="button" className="button button--secondary" onClick={openAlignmentEditor}>Open alignment editor</button>
                  <label className="button button--quiet">Replace<input type="file" accept=".fa,.fas,.fasta,.aln,.txt" onChange={alignmentInput} /></label>
                </div>
              </div>
            )}
          </section>

          <section className={`workflow-card ${tree !== undefined ? "is-complete" : ""}`}>
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
          </section>

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
        </div>

        <section className="run-panel">
          <div className="run-panel__header">
            <div><p className="eyebrow">{requiresForeground ? "04" : "03"} / Configure and run</p><h2>{manifest.title}</h2><p>{manifest.description}</p></div>
            <div className="runtime-choice"><span>Execution</span><strong>{String(parameters.backend ?? "wasm-parallel")}</strong><small>{webGpuAvailable ? "Parallel WASM recommended · WebGPU available" : "Parallel WASM available"}</small></div>
          </div>
          <div className="parameter-grid">
            {visibleParameters.map((parameter) => (
              <ParameterControl
                key={parameter.id}
                parameter={parameter}
                value={parameters[parameter.id] ?? parameter.default}
                onChange={(value) => updateParameter(parameter.id, value)}
              />
            ))}
          </div>
          <button type="button" className="advanced-toggle" onClick={() => setShowAdvanced((value) => !value)}>
            {showAdvanced ? "Hide advanced parameters" : "Show advanced parameters"}
          </button>

          <div className="validation-strip">
            <div className={alignment !== undefined ? "is-valid" : ""}><span>{alignment !== undefined ? "✓" : "1"}</span>Alignment</div>
            <div className={tree !== undefined ? "is-valid" : ""}><span>{tree !== undefined ? "✓" : "2"}</span>Tree</div>
            {requiresForeground && <div className={tagReady ? "is-valid" : ""}><span>{tagReady ? "✓" : "3"}</span>Two groups</div>}
            <div className={validation.ready ? "is-valid" : ""}><span>{validation.ready ? "✓" : requiresForeground ? "4" : "3"}</span>Validated</div>
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
            <button type="button" className="button button--run" disabled={!validation.ready} onClick={() => void runAnalysis()}>
              <span>Run {manifest.shortTitle}</span><small>{parameters.backend === "webgpu" ? "Experimental WebGPU kernel" : parameters.backend === "wasm" ? "Exact single-worker WASM" : "Exact parallel WASM (recommended)"}</small>
            </button>
          )}
        </section>

        {result !== undefined && <div ref={resultsRef} className="results-anchor"><selectedModel.ResultView result={result} parameters={parameters} alignment={alignment?.text ?? ""} /></div>}
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

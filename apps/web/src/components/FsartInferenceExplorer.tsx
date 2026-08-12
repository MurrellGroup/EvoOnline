import { useEffect, useRef, useState } from "react";
import type {
  FsartAnalysisResult,
  TreeHmmExplorationMode,
  TreeHmmExplorationResult,
  TreeHmmResult,
} from "@phylo-workbench/model-fsart/browser-source";
import type { FsartWorkerRequest, FsartWorkerResponse } from "../workers/fsart.worker.js";
import { CommittedNumberInput } from "./CommittedNumberInput.js";
import { FsartTreeComparisonFigure } from "./FsartTreeComparisonFigure.js";
import { FsartTreeHmmFigure } from "./FsartTreeHmmFigure.js";

type DisplayMode = "conservative" | TreeHmmExplorationMode;
type Inference = TreeHmmResult | TreeHmmExplorationResult;

function downloadText(text: string, filename: string, type = "text/plain;charset=utf-8"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function inferenceCsv(inference: Inference): string {
  if (inference.status !== "complete") return `${inference.message ?? "Topology HMM unavailable."}\n`;
  const header = ["Site", "Marginal MAP tree", "Viterbi tree", "Switch after site posterior", ...inference.states.map((state) => `${state.id} posterior`)];
  const rows = Array.from({ length: inference.sites }, (_value, site) => [
    site + 1,
    inference.states[inference.mapState[site] ?? 0]?.id ?? "",
    inference.states[inference.viterbi?.statePath[site] ?? inference.mapState[site] ?? 0]?.id ?? "",
    site + 1 < inference.sites ? inference.switchPosterior[site] ?? 0 : "",
    ...inference.states.map((_state, state) => inference.statePosterior[state * inference.sites + site] ?? 0),
  ].join(","));
  return `${header.join(",")}\n${rows.join("\n")}\n`;
}

export function FsartInferenceExplorer({ result }: { readonly result: FsartAnalysisResult }) {
  const [mode, setMode] = useState<DisplayMode>("conservative");
  const [expectedResets, setExpectedResets] = useState(2);
  const [dirichletConcentration, setDirichletConcentration] = useState(0.05);
  const [minimumRunLength, setMinimumRunLength] = useState(Math.max(1, Math.min(60, result.diagnostics.minimumTreeSpan)));
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [exploration, setExploration] = useState<TreeHmmExplorationResult>();
  const [error, setError] = useState<string>();
  const workerRef = useRef<Worker | undefined>(undefined);
  const activeRequest = useRef<string | undefined>(undefined);

  useEffect(() => {
    workerRef.current?.terminate();
    setReady(false);
    setExploration(undefined);
    setError(undefined);
    if (result.treeHmmProfiles.length === 0) return;
    const worker = new Worker(new URL("../workers/fsart.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    const initId = crypto.randomUUID();
    worker.onmessage = (event: MessageEvent<FsartWorkerResponse>) => {
      const message = event.data;
      if (message.type === "tree-hmm-explore-ready" && message.id === initId) {
        setReady(true);
        return;
      }
      if (message.id !== activeRequest.current) return;
      if (message.type === "tree-hmm-explore-result") {
        setExploration(message.result);
        setPending(false);
        setError(undefined);
      } else if (message.type === "error") {
        setPending(false);
        setError(message.error);
      }
    };
    worker.onerror = (event) => {
      setPending(false);
      setError(event.message || "Interactive topology-HMM worker failed.");
    };
    const request: FsartWorkerRequest = { type: "tree-hmm-explore-init", id: initId, profiles: result.treeHmmProfiles };
    worker.postMessage(request);
    return () => { worker.terminate(); if (workerRef.current === worker) workerRef.current = undefined; };
  }, [result.treeHmmProfiles]);

  useEffect(() => {
    if (mode === "conservative" || !ready || workerRef.current === undefined) {
      activeRequest.current = undefined;
      setPending(false);
      return;
    }
    const id = crypto.randomUUID();
    // Invalidate an older worker response immediately, including during the debounce window.
    activeRequest.current = id;
    setPending(true);
    const timer = window.setTimeout(() => {
      const request: FsartWorkerRequest = {
        type: "tree-hmm-explore",
        id,
        options: {
          mode,
          expectedResets,
          minimumRunLength,
          ...(mode === "sparse-dirichlet" ? { dirichletConcentration, maximumIterations: 40, pruningWeight: 1e-4 } : {}),
        },
      };
      workerRef.current!.postMessage(request);
    }, 120);
    return () => window.clearTimeout(timer);
  }, [mode, ready, expectedResets, minimumRunLength, dirichletConcentration]);

  const active: Inference | undefined = mode === "conservative"
    ? result.treeHmm
    : exploration?.mode === mode ? exploration : undefined;
  const priorSpacing = expectedResets > 0 ? Math.max(1, (result.diagnostics.sites - 1) / expectedResets) : Number.POSITIVE_INFINITY;
  const profileCount = result.treeHmmProfiles.length;
  const setExpectedFromLog = (value: number): void => setExpectedResets(Number((10 ** value).toPrecision(6)));
  const modeTitle = mode === "conservative" ? "Conservative IC search"
    : mode === "fixed-low-switch" ? "Fixed low-switch prior"
      : "Sparse Dirichlet variational EM";

  return <>
    <div className="fsart-inference-mode" role="radiogroup" aria-label="Topology HMM inference mode">
      <button type="button" role="radio" aria-checked={mode === "conservative"} className={mode === "conservative" ? "is-active" : undefined} onClick={() => setMode("conservative")}><strong>Conservative IC search</strong><small>Existing beam + add/drop/swap + AICc/BIC result</small></button>
      <button type="button" role="radio" aria-checked={mode === "fixed-low-switch"} disabled={profileCount === 0} className={mode === "fixed-low-switch" ? "is-active" : undefined} onClick={() => setMode("fixed-low-switch")}><strong>Low-switch Viterbi retention</strong><small>Full draft family; retain only trees on the stabilized path</small></button>
      <button type="button" role="radio" aria-checked={mode === "sparse-dirichlet"} disabled={profileCount === 0} className={mode === "sparse-dirichlet" ? "is-active" : undefined} onClick={() => setMode("sparse-dirichlet")}><strong>Sparse Dirichlet-EM</strong><small>Full draft family; variational tree weights collapse toward zero</small></button>
    </div>
    {mode !== "conservative" && <div className="fsart-exploration-controls">
      <label className="fsart-switch-slider"><span>Prior expected reset opportunities: <strong>{expectedResets.toPrecision(3)}</strong></span><input type="range" min="-2" max={Math.log10(256)} step="0.02" value={Math.log10(Math.max(0.01, expectedResets))} onChange={(event) => setExpectedFromLog(Number(event.target.value))} /><small>{`per-site q ${(1 - Math.exp(-expectedResets / Math.max(1, result.diagnostics.sites - 1))).toExponential(3)} · prior reset spacing ≈ ${Number.isFinite(priorSpacing) ? `${Math.round(priorSpacing).toLocaleString()} nt` : "∞"}`}</small></label>
      <label><span>Exact reset count</span><CommittedNumberInput value={expectedResets} onCommit={setExpectedResets} min={0.001} max={256} step={0.1} integer={false} /></label>
      <label><span>Minimum Viterbi run</span><CommittedNumberInput value={minimumRunLength} onCommit={(value) => setMinimumRunLength(Math.round(value))} min={1} max={Math.max(1, Math.floor(result.diagnostics.sites / 2))} /></label>
      {mode === "sparse-dirichlet" && <label><span>Dirichlet α per tree</span><CommittedNumberInput value={dirichletConcentration} onCommit={setDirichletConcentration} min={0.0001} max={10} step={0.01} integer={false} /><small>α ≪ 1 strongly favors a few post-reset destinations</small></label>}
    </div>}
    {mode === "conservative" && <p className="figure-note"><strong>Original reconstruction retained unchanged.</strong> This is the information-criterion subset search followed by exact rate marginalization and bounded Viterbi/tree refitting.</p>}
    {mode === "fixed-low-switch" && <p className="figure-note"><strong>No subset search:</strong> equal post-reset frequencies are applied to all {profileCount} cached draft trees, forward/backward and Viterbi are run, trees absent from the path are removed, and this is repeated to stability. Moving the switching slider reruns only this O(L × K) calculation.</p>}
    {mode === "sparse-dirichlet" && <p className="figure-note"><strong>Variational sparse weights:</strong> starting from equal frequencies, reset-destination counts update a symmetric Dirichlet posterior and the HMM uses <em>exp(E log w)</em>. Unsupported trees acquire tiny weights and are pruned. This avoids the unbounded boundary MAP objective produced by a literal α&lt;1 Dirichlet mode.</p>}
    {pending && <div className="fsart-live-status" role="status"><i /><span>Updating {modeTitle} over {profileCount} cached site-likelihood profiles…</span></div>}
    {error !== undefined && <div className="figure-empty"><strong>Interactive reconstruction failed.</strong><span>{error}</span></div>}
    {active?.status === "complete" && <>
      <div className="result-stats fsart-live-stats">
        <div><span>Inference mode</span><strong>{modeTitle}</strong></div>
        <div><span>Retained trees</span><strong>{active.states.length}</strong><small>{mode === "conservative" ? `${profileCount || active.states.length} draft profiles` : `${profileCount - active.states.length} removed from ${profileCount}`}</small></div>
        <div><span>Expected state changes</span><strong>{active.expectedSwitches.toFixed(3)}</strong></div>
        <div><span>Viterbi switches</span><strong>{active.viterbi?.breakpoints.length ?? 0}</strong></div>
        <div><span>HMM log L</span><strong>{active.logLikelihood?.toFixed(2)}</strong></div>
        {"elapsedMs" in active && <div><span>Interactive update</span><strong>{active.elapsedMs.toFixed(1)} ms</strong><small>{active.iterations} update{active.iterations === 1 ? "" : "s"}</small></div>}
      </div>
      <div className="result-toolbar"><span>{modeTitle} · posterior curves and Viterbi path update together</span><button type="button" className="button button--secondary" onClick={() => downloadText(inferenceCsv(active), `fsart-${mode}-tree-hmm.csv`, "text/csv;charset=utf-8")}>Download active CSV</button></div>
      <FsartTreeHmmFigure key={mode} result={active} defaultStyle={mode === "conservative" ? "bands" : "curves"} defaultTitle={`${modeTitle}: topology posterior and switching path`} />
      <div className="result-table-wrap"><table className="result-table"><thead><tr><th>Tree</th><th>Training ranges</th><th>Posterior occupancy</th><th>Expected sites</th><th>Post-reset weight</th></tr></thead><tbody>{active.states.map((state) => <tr key={state.id}><td><span className="fsart-tree-swatch" style={{ background: state.color }} /> <strong>{state.id}</strong></td><td>{state.sourceRanges?.map((range) => `${range[0]}–${range[1]}`).join(", ") ?? `${state.sourceStart}–${state.sourceEnd}`}</td><td>{(100 * state.occupancy).toFixed(2)}%</td><td>{state.expectedSites.toFixed(1)}</td><td>{state.weight.toPrecision(4)}</td></tr>)}</tbody></table></div>
      {"switchIntervals" in active && active.switchIntervals.length > 0 && <div className="result-table-wrap"><table className="result-table"><thead><tr><th>Rank</th><th>Posterior mode</th><th>Credible interval</th><th>Peak P(switch)</th><th>Mode switch mass</th></tr></thead><tbody>{active.switchIntervals.map((interval) => <tr key={interval.rank}><td>{interval.rank}</td><td>after site {interval.breakpoint}</td><td>{interval.intervalLow}–{interval.intervalHigh}</td><td>{interval.peakProbability.toFixed(4)}</td><td>{interval.expectedSwitchMass.toFixed(3)}</td></tr>)}</tbody></table></div>}
      <FsartTreeComparisonFigure key={`${mode}-${active.states.map((state) => state.id).join("-")}`} inference={active} titlePrefix={modeTitle} />
    </>}
    {mode !== "conservative" && active === undefined && !pending && error === undefined && <div className="figure-empty"><strong>Preparing cached topology family.</strong><span>The site-likelihood bank is copied to a dedicated interactive worker once; subsequent slider updates do not rerun FastTree.</span></div>}
  </>;
}

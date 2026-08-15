import { useMemo, useState } from "react";
import type { FsartAnalysisResult, TripletState } from "@phylo-workbench/model-fsart/browser-source";
import { CommittedNumberInput } from "./CommittedNumberInput.js";
import { FsartBreakpointFigure } from "./FsartBreakpointFigure.js";
import { FsartInferenceExplorer } from "./FsartInferenceExplorer.js";
import { FsartPartitionFigure } from "./FsartPartitionFigure.js";
import { FsartTripletFigure } from "./FsartTripletFigure.js";
import { RecombinationCodonHandoff, type RecombinationCodonMethod } from "./RecombinationCodonHandoff.js";
import { createFsartCodonTreeSet } from "../lib/recombination-handoff.js";
import type { RecombinationCodonTreeSet } from "@phylo-workbench/model-diffubar/browser-source";
import { createFsartRecombinationBundle, type EvoOnlineRecombinationTreeBundle } from "../lib/recombination-bundle.js";

function downloadCsv(csv: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function probability(value: number): string {
  if (value === 0) return "< machine range";
  return value < 1e-4 ? value.toExponential(3) : value.toPrecision(4);
}

function pairLabel(state: TripletState, names: readonly string[]): string {
  return state === 0 ? `${names[0]}=${names[1]}` : state === 1 ? `${names[0]}=${names[2]}` : `${names[1]}=${names[2]}`;
}

export function FsartResultsView({ result, onLoadRecombinationTrees }: { readonly result: FsartAnalysisResult; readonly onLoadRecombinationTrees?: ((method: RecombinationCodonMethod, treeSet: RecombinationCodonTreeSet, bundle: EvoOnlineRecombinationTreeBundle) => void) | undefined }) {
  const [selectedRank, setSelectedRank] = useState(result.breakpoints[0]?.rank ?? 1);
  const [minimumEvidence, setMinimumEvidence] = useState(0);
  const [showOnlyStrongTriplets, setShowOnlyStrongTriplets] = useState(false);
  const visibleBreakpoints = useMemo(() => result.breakpoints.filter((breakpoint) => breakpoint.evidence >= minimumEvidence), [minimumEvidence, result.breakpoints]);
  const visibleSignals = useMemo(() => result.tripletSignals.filter((signal) => !showOnlyStrongTriplets || signal.evidence >= minimumEvidence), [minimumEvidence, result.tripletSignals, showOnlyStrongTriplets]);
  const selected = result.breakpoints.find((breakpoint) => breakpoint.rank === selectedRank) ?? result.breakpoints[0];
  const isViterbiMatched = (breakpoint: FsartAnalysisResult["breakpoints"][number]): boolean => result.partition.acceptedBreakpoints
    .some((value) => value >= breakpoint.supportLow && value <= breakpoint.supportHigh);
  const commitRank = (raw: number): void => setSelectedRank(Math.max(1, Math.min(Math.max(1, result.breakpoints.length), Math.round(raw))));
  let codonTreeSet: RecombinationCodonTreeSet | undefined;
  let recombinationBundle: EvoOnlineRecombinationTreeBundle | undefined;
  let codonTreeError: string | undefined;
  try { codonTreeSet = createFsartCodonTreeSet(result, result.diagnostics.sites); recombinationBundle = createFsartRecombinationBundle(result, codonTreeSet); }
  catch (error) { codonTreeError = error instanceof Error ? error.message : String(error); }

  return <section className="results" aria-labelledby="fsart-results-heading">
    <div className="section-heading section-heading--results"><div><p className="eyebrow">Analysis complete · exploratory recombination analysis</p><h2 id="fsart-results-heading">FSART</h2><p>Fast Stepwise Approximate Recombination Test</p></div><div className="result-downloads"><button type="button" className="button button--primary" onClick={() => downloadCsv(result.breakpointCsv, "fsart-consensus-proposals.csv")}>Proposal CSV</button><button type="button" className="button button--secondary" onClick={() => downloadCsv(result.partitionCsv, "fsart-viterbi-runs.csv")}>Viterbi runs CSV</button><button type="button" className="button button--secondary" disabled={result.treeHmm.status !== "complete"} onClick={() => downloadCsv(result.treeHmmCsv, "fsart-tree-hmm.csv")}>Tree-HMM CSV</button></div></div>
    <p className="method-note"><strong>What FSART asks:</strong> does phylogenetic support change along the nucleotide alignment? A pair-covered informative-triplet scan generates an uncorrected evidence distribution without a multiple-comparisons admission gate. Independent triplet count and compressed evidence are aggregated into hard-spaced consensus boundaries; those boundaries only generate trees. EvoOnline fits every atomic segment, adjacent pair, adjacent triplet, and the whole alignment, caches every unique resolved topology's likelihood at every site, then performs a rapid beam plus add/drop/swap search in that cached likelihood space.</p>
    <p className="method-note method-note--warning"><strong>Approximate GARD competitor:</strong> AIC/AICc/BIC—not triplet p-values—selects the final topology set. A minimum-length Viterbi reconstruction is alternated with tree refits for a bounded number of rounds, and convergence is reported rather than required. This remains an exploratory FastTree-based method, not exact GARD, RDP, or proprietary BURT software.</p>
    <RecombinationCodonHandoff treeSet={codonTreeSet} bundle={recombinationBundle} error={codonTreeError} onLoad={onLoadRecombinationTrees} />
    <div className="result-stats">
      <div><span>Consensus proposals</span><strong>{result.breakpoints.length.toLocaleString()}</strong></div>
      <div><span>Refined Viterbi switches</span><strong>{result.partition.acceptedBreakpoints.length.toLocaleString()}</strong><small>{result.partition.status === "complete" ? result.partition.criterion.toUpperCase() : result.partition.status}</small></div>
      <div><span>Taxa triplets</span><strong>{result.diagnostics.scannedTriplets.toLocaleString()}</strong><small>{result.diagnostics.tripletSampling === "exhaustive" ? "exhaustive" : `all ${result.diagnostics.totalTaxonPairs.toLocaleString()} taxon pairs covered`} · {result.diagnostics.informativeTriplets.toLocaleString()} informative</small></div>
      <div><span>Informative boundaries</span><strong>{result.diagnostics.testedBoundaries.toLocaleString()}</strong></div>
      <div><span>Variable sites</span><strong>{result.diagnostics.variableSites.toLocaleString()}</strong><small>of {result.diagnostics.sites.toLocaleString()}</small></div>
      <div><span>Minimum tree span</span><strong>{result.diagnostics.minimumTreeSpan.toLocaleString()} nt</strong><small>≈ {result.diagnostics.expectedVariableSitesPerMinimumSpan.toFixed(1)} variable sites</small></div>
      <div><span>Scan window</span><strong>{result.diagnostics.scanWindow} + {result.diagnostics.scanWindow}</strong><small>informative events</small></div>
      <div><span>Scanner</span><strong>{result.diagnostics.parallelWorkers} worker{result.diagnostics.parallelWorkers === 1 ? "" : "s"}</strong><small>32-site bitsets · {result.diagnostics.pairEqualityCache ? "pair cache" : "bounded-memory path"}</small></div>
      <div><span>FastTree</span><strong>{result.partition.fastTreeVersion ?? result.partition.status}</strong></div>
      <div><span>Tree family</span><strong>{result.partition.candidateTrees.length.toLocaleString()}</strong><small>global + segment spans 1–3</small></div>
      <div><span>Tree HMM</span><strong>{result.treeHmm.status === "complete" ? `${result.treeHmm.states.length} states` : result.treeHmm.status}</strong><small>{result.treeHmm.deltaCriterion === null ? "" : `Δ${result.treeHmm.criterion.toUpperCase()} ${result.treeHmm.deltaCriterion.toFixed(2)}`}</small></div>
      <div><span>Total time</span><strong>{((result.timings.totalMs ?? 0) / 1000).toFixed(2)} s</strong></div>
    </div>

    <details className="result-panel" open><summary><span>Breakpoint proposal landscape</span><small>Triplet peaks, consensus support, and refined Viterbi switches · editable · SVG</small></summary><div className="result-panel__body"><FsartBreakpointFigure result={result} selectedRank={selectedRank} onSelectRank={commitRank} /></div></details>

    <details className="result-panel" open><summary><span>Topology-mixture HMM and linked segment trees</span><small>{result.treeHmm.status === "complete" ? `${result.treeHmm.states.length} conservative states · ${result.treeHmmProfiles.length} cached draft trees · two additional interactive inference modes` : result.treeHmm.message}</small></summary><div className="result-panel__body">
      {result.treeHmm.status === "complete" ? <FsartInferenceExplorer result={result} /> : <div className="figure-empty"><strong>Tree-HMM result unavailable.</strong><span>{result.treeHmm.message}</span></div>}
    </div></details>

    {result.treeHmm.refinement !== undefined && <details className="result-panel" open><summary><span>Viterbi / tree-refit convergence audit</span><small>{result.treeHmm.refinement.message}</small></summary><div className="result-panel__body"><div className="result-table-wrap"><table className="result-table"><thead><tr><th>Iteration</th><th>States</th><th>Viterbi breakpoints</th><th>Maximum shift</th><th>Topology set changed</th><th>{result.treeHmm.criterion.toUpperCase()}</th><th>Elapsed</th></tr></thead><tbody>{result.treeHmm.refinement.iterations.map((iteration) => <tr key={iteration.iteration}><td>{iteration.iteration === 0 ? "Initial" : iteration.iteration}</td><td>{iteration.stateCount}</td><td>{iteration.breakpoints.join(", ") || "none"}</td><td>{iteration.maximumBoundaryShift === null ? "—" : `${iteration.maximumBoundaryShift} nt`}</td><td>{iteration.topologyChanged ? "Yes" : "No"}</td><td>{iteration.criterionValue?.toFixed(3) ?? "—"}</td><td>{(iteration.elapsedMs / 1000).toFixed(2)} s</td></tr>)}</tbody></table></div></div></details>}

    {selected !== undefined && <details className="result-panel" open><summary><span>Selected breakpoint uncertainty</span><small>{`${selected.id} · break after site ${selected.breakpoint} · candidate-local interval ${selected.intervalLow}–${selected.intervalHigh}`}</small></summary><div className="result-panel__body">
      <div className="selection-visibility bsrel-table-controls"><label><span>Breakpoint rank</span><CommittedNumberInput value={selectedRank} onCommit={commitRank} min={1} max={result.breakpoints.length} /></label><label><span>Minimum −log₁₀ raw p</span><CommittedNumberInput value={minimumEvidence} onCommit={setMinimumEvidence} min={0} max={1000} step={0.25} integer={false} /></label></div>
      <div className="result-stats"><div><span>Consensus break</span><strong>{selected.breakpoint}</strong></div><div><span>Candidate-local interval</span><strong>{selected.intervalLow}–{selected.intervalHigh}</strong><small>representative triplet HMM</small></div><div><span>Consensus envelope</span><strong>{selected.supportLow}–{selected.supportHigh}</strong></div><div><span>Consensus score</span><strong>{(selected.consensusScore ?? selected.evidence).toFixed(3)}</strong></div><div><span>Supporting triplets</span><strong>{selected.supportTriplets}</strong></div><div><span>Strongest raw evidence</span><strong>{selected.evidence.toFixed(3)}</strong></div></div>
      <FsartTripletFigure breakpoint={selected} alignmentSites={result.diagnostics.sites} />
      <div className="fsart-rate-grid">{selected.representative.switchingRates.map((rate) => <div key={rate.expectedSwitches}><span>{rate.expectedSwitches.toPrecision(3)} expected switches</span><i><b style={{ width: `${Math.max(0.4, rate.posterior * 100)}%` }} /></i><strong>{rate.posterior.toFixed(4)}</strong></div>)}</div>
    </div></details>}

    <details className="result-panel" open><summary><span>Ranked consensus breakpoint proposals</span><small>{visibleBreakpoints.length.toLocaleString()} shown · no multiple-testing admission gate</small></summary><div className="result-panel__body">
      <div className="selection-visibility bsrel-table-controls"><label><span>Minimum −log₁₀ raw p</span><CommittedNumberInput value={minimumEvidence} onCommit={setMinimumEvidence} min={0} max={1000} step={0.25} integer={false} /></label></div>
      <div className="result-table-wrap"><table className="result-table bsrel-table"><thead><tr><th>Rank</th><th>Breakpoint</th><th>Candidate-local interval</th><th>Consensus envelope</th><th>Consensus score</th><th>Strongest evidence</th><th>Support</th><th>Topology switch</th><th>Final Viterbi</th></tr></thead><tbody>{visibleBreakpoints.map((breakpoint) => <tr key={breakpoint.id} className={breakpoint.rank === selectedRank ? "is-selected" : undefined} onClick={() => setSelectedRank(breakpoint.rank)}><td><strong>{breakpoint.id}</strong><small>{breakpoint.representative.taxaNames.join(" / ")}</small></td><td>{breakpoint.breakpoint}</td><td>{breakpoint.intervalLow}–{breakpoint.intervalHigh}</td><td>{breakpoint.supportLow}–{breakpoint.supportHigh}</td><td>{(breakpoint.consensusScore ?? breakpoint.evidence).toFixed(3)}<small>strength {(breakpoint.strengthScore ?? breakpoint.evidence).toFixed(3)}</small></td><td>{breakpoint.evidence.toFixed(3)}</td><td>{breakpoint.supportTriplets} triplets<small>{breakpoint.supportTaxa} taxa</small></td><td>{pairLabel(breakpoint.representative.leftState, breakpoint.representative.taxaNames)} → {pairLabel(breakpoint.representative.rightState, breakpoint.representative.taxaNames)}</td><td className={isViterbiMatched(breakpoint) ? "positive-text" : undefined}>{isViterbiMatched(breakpoint) ? "Nearby switch" : "Proposal only"}</td></tr>)}</tbody></table></div>
    </div></details>

    <details className="result-panel" open><summary><span>Refined Viterbi tree reconstruction</span><small>{result.partition.status === "complete" ? `${result.partition.segments.length} runs · ${result.partition.candidateTrees.length} fitted family trees · ${result.partition.criterion.toUpperCase()} ${result.partition.criterionValue?.toFixed(2) ?? "—"}` : result.partition.message}</small></summary><div className="result-panel__body"><FsartPartitionFigure result={result} /></div></details>

    {result.discordantClades.length > 0 && <details className="result-panel" open><summary><span>Exploratory participating-subtree candidates</span><small>Adjacent-segment split differences; not a minimum-SPR reconstruction</small></summary><div className="result-panel__body"><p className="figure-note">These are the smallest non-trivial bipartitions present in one adjacent segment tree and absent from the other. They efficiently flag taxa/clades worth inspecting, but FSART does not claim to have reconstructed a unique subtree-prune-regraft event or locally optimized only its incident edges.</p><div className="result-table-wrap"><table className="result-table"><thead><tr><th>Segments</th><th>Change</th><th>Clade size</th><th>Taxa</th></tr></thead><tbody>{result.discordantClades.map((clade, index) => <tr key={`${clade.betweenSegments.join("-")}-${clade.direction}-${index}`}><td>{clade.betweenSegments.join(" → ")}</td><td>{clade.direction}</td><td>{clade.size}</td><td>{clade.taxa.join(", ")}</td></tr>)}</tbody></table></div></div></details>}

    <details className="result-panel"><summary><span>Triplet signal audit</span><small>{visibleSignals.length.toLocaleString()} retained top signals</small></summary><div className="result-panel__body"><div className="selection-visibility bsrel-table-controls"><label className="toggle"><input type="checkbox" checked={showOnlyStrongTriplets} onChange={(event) => setShowOnlyStrongTriplets(event.target.checked)} /><span>Apply live evidence display filter</span></label></div><div className="result-table-wrap"><table className="result-table"><thead><tr><th>Triplet</th><th>Breakpoint</th><th>Candidate-local interval</th><th>G²</th><th>Raw p</th><th>Bonferroni audit p</th><th>P(switch)</th><th>Emission fidelity</th></tr></thead><tbody>{visibleSignals.map((signal, index) => <tr key={`${signal.taxa.join("-")}-${signal.breakpoint}-${index}`}><td>{signal.taxaNames.join(" / ")}</td><td>{signal.breakpoint}</td><td>{signal.intervalLow}–{signal.intervalHigh}</td><td>{signal.g2.toFixed(3)}</td><td>{probability(signal.rawP)}</td><td>{probability(signal.adjustedP)}<small>not used for admission</small></td><td>{signal.switchPosterior.toFixed(4)}</td><td>{signal.emissionAccuracy.toFixed(4)}</td></tr>)}</tbody></table></div></div></details>
  </section>;
}

import type { MosaicSprAnalysisResult } from "@phylo-workbench/model-mosaicspr/browser-source";
import { MosaicSprReconstructionFigure } from "./MosaicSprReconstructionFigure.js";
import { MosaicSprTreeComparisonFigure } from "./MosaicSprTreeComparisonFigure.js";
import { RecombinationCodonHandoff, type RecombinationCodonMethod } from "./RecombinationCodonHandoff.js";
import { createMosaicSprCodonTreeSet } from "../lib/recombination-handoff.js";
import type { RecombinationCodonTreeSet } from "@phylo-workbench/model-diffubar/browser-source";

function downloadText(text: string, filename: string, type = "text/plain;charset=utf-8"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function MosaicSprResultsView({ result, onLoadRecombinationTrees }: { readonly result: MosaicSprAnalysisResult; readonly onLoadRecombinationTrees?: ((method: RecombinationCodonMethod, treeSet: RecombinationCodonTreeSet) => void) | undefined }) {
  const reconstruction = result.reconstruction;
  const master = reconstruction.states.find((state) => state.id === reconstruction.masterStateId);
  const editCount = reconstruction.events.reduce((total, event) => total + event.sprDistance, 0);
  let codonTreeSet: RecombinationCodonTreeSet | undefined;
  let codonTreeError: string | undefined;
  try { codonTreeSet = createMosaicSprCodonTreeSet(result, result.sites); }
  catch (error) { codonTreeError = error instanceof Error ? error.message : String(error); }
  return <section className="results" aria-labelledby="mosaicspr-results-heading">
    <div className="section-heading section-heading--results"><div><p className="eyebrow">Analysis complete · explicit recombination history</p><h2 id="mosaicspr-results-heading">MosaicSPR</h2><p>Unknown-master mosaic reconstruction with executable subtree-prune-regraft events</p></div><div className="result-downloads"><button type="button" className="button button--primary" onClick={() => downloadText(result.eventCsv, "mosaicspr-events.csv", "text/csv;charset=utf-8")}>Event CSV</button><button type="button" className="button button--secondary" onClick={() => downloadText(JSON.stringify(result, null, 2), "mosaicspr-result.json", "application/json;charset=utf-8")}>Result JSON</button><button type="button" className="button button--secondary" disabled={master === undefined} onClick={() => master !== undefined && downloadText(master.tree, "mosaicspr-master.nwk")}>Master Newick</button></div></div>
    <p className="method-note"><strong>What MosaicSPR asks:</strong> can the alignment be represented by a jointly inferred master topology plus a compact sequence of explicit SPR edits whose implied tree changes along the genome? Neither the master nor the local trees are fixed. A breakpoint may carry multiple composed edits, and more than one derived event can be active in the same region.</p>
    <p className="method-note method-note--warning"><strong>Search scope:</strong> the path is exact inside the explicitly explored connected SPR graph, but the outer graph expansion is budgeted. Optional FSART triplet peaks and overlapping local FastTree windows seed the search only; they do not constrain the final breakpoints, master, edit count, or implied regional topologies.</p>
    <RecombinationCodonHandoff treeSet={codonTreeSet} error={codonTreeError} onLoad={onLoadRecombinationTrees} />
    <div className="result-stats">
      <div><span>Jointly inferred master</span><strong>{reconstruction.masterStateId ?? "—"}</strong><small>{reconstruction.masterChangedFromSeed ? `revised from ${reconstruction.initialSeedStateId}` : "winning seed topology retained"}</small></div>
      <div><span>Genomic regions</span><strong>{reconstruction.runs.length}</strong><small>{new Set(reconstruction.runs.map((run) => run.stateId)).size} implied local trees</small></div>
      <div><span>Breakpoint events</span><strong>{reconstruction.events.length}</strong><small>{editCount} explicit SPR edits</small></div>
      <div><span>Proposal seeds</span><strong>{result.proposals.length}</strong><small>{result.proposalDiagnostics.source === "overlap-only" ? "overlap windows only" : `${result.proposalDiagnostics.scannedTriplets.toLocaleString()} triplets scanned`}</small></div>
      <div><span>Topology graph</span><strong>{reconstruction.certificate.topologyStates}</strong><small>{reconstruction.certificate.graphEdges} executable edges</small></div>
      <div><span>Total time</span><strong>{((result.timings.totalMs ?? 0) / 1000).toFixed(2)} s</strong><small>{result.fastTreeVersion ?? "FastTree WASM"}</small></div>
    </div>

    <details className="result-panel" open><summary><span>Regions and implied phylogenies</span><small>Select two for a tanglegram or all for linked trees · matching taxa connected · SVG</small></summary><div className="result-panel__body"><MosaicSprTreeComparisonFigure result={reconstruction} /></div></details>

    <details className="result-panel" open><summary><span>Master tree and executable SPR history</span><small>{`${reconstruction.events.length} boundaries · ${editCount} edits · master ${reconstruction.masterStateId ?? "unavailable"}`}</small></summary><div className="result-panel__body"><MosaicSprReconstructionFigure result={reconstruction} /></div></details>

    <details className="result-panel"><summary><span>Non-binding proposal audit</span><small>{`${result.proposals.length} triplet-consensus boundaries · ${result.draftTrees.length} FastTree seeds`}</small></summary><div className="result-panel__body">
      <p className="figure-note">These regions generated starting topologies only. MosaicSPR's reported region boundaries are the edit-tape boundaries above, not this table.</p>
      <div className="result-table-wrap"><table className="result-table"><thead><tr><th>Proposal</th><th>Breakpoint</th><th>Candidate-local interval</th><th>Support envelope</th><th>Triplets</th><th>Taxa</th><th>Score</th></tr></thead><tbody>{result.proposals.map((proposal) => <tr key={proposal.id}><td>{proposal.id}</td><td>{proposal.breakpoint}</td><td>{proposal.intervalLow}–{proposal.intervalHigh}</td><td>{proposal.supportLow}–{proposal.supportHigh}</td><td>{proposal.supportTriplets}</td><td>{proposal.supportTaxa}</td><td>{proposal.consensusScore.toFixed(3)}</td></tr>)}</tbody></table></div>
      <h3>FastTree seed family</h3>
      <div className="result-table-wrap"><table className="result-table"><thead><tr><th>Seed</th><th>Kind</th><th>Training region</th><th>Log likelihood</th><th>Fit time</th><th>Topology</th></tr></thead><tbody>{result.draftTrees.map((tree) => <tr key={`${tree.id}-${tree.start}-${tree.end}`}><td>{tree.id}</td><td>{tree.kind}</td><td>{tree.start}–{tree.end}</td><td>{tree.logLikelihood.toFixed(3)}</td><td>{(tree.elapsedMs / 1000).toFixed(2)} s</td><td><code>{tree.topologySignature ?? "—"}</code></td></tr>)}</tbody></table></div>
    </div></details>
  </section>;
}

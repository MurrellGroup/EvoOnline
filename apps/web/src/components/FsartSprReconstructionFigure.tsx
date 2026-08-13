import { useMemo, useRef, useState } from "react";
import type { SprEdit, SprReconstructionResult } from "@phylo-workbench/model-fsart/browser-source";
import { downloadSvg } from "../lib/svg-export.js";
import { PhylogramFigure } from "./PhylogramFigure.js";

const INK = "#172321";
const MUTED = "#687571";
const FONT = "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";

function downloadText(text: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function FsartSprReconstructionFigure({ result }: { readonly result: SprReconstructionResult }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [title, setTitle] = useState("Unrestricted SPR reconstruction along the alignment");
  const [selectedStateId, setSelectedStateId] = useState(result.masterStateId ?? result.states[0]?.id ?? "");
  const selectedState = result.states.find((state) => state.id === selectedStateId) ?? result.states[0];
  const derivationByState = useMemo(() => new Map(result.derivations.map((derivation) => [derivation.stateId, derivation])), [result.derivations]);
  const sites = result.runs[result.runs.length - 1]?.end ?? 1;
  const width = 1_160;
  const left = 78;
  const right = 24;
  const plotWidth = width - left - right;
  const x = (site: number): number => left + (site - 1) / Math.max(1, sites - 1) * plotWidth;
  const ticks = useMemo(() => Array.from({ length: 6 }, (_, index) => Math.max(1, Math.round(1 + index * (sites - 1) / 5))), [sites]);

  if (result.status !== "complete") return <div className="figure-empty"><strong>Explicit SPR reconstruction unavailable.</strong><span>{result.message}</span></div>;
  return <div className="fsart-spr-reconstruction">
    <p className="figure-note"><strong>This is the unrestricted event representation.</strong> The master is selected during search, not supplied or held fixed. Each local topology is a node in a connected graph of valid unrooted SPR edits, and a boundary may apply several edits at once. The exact run path is solved on the explored graph; the certificate below is candid about the outer topology-space search.</p>
    <div className="result-stats">
      <div><span>Jointly selected master</span><strong>{result.masterStateId}</strong><small>{result.masterChangedFromSeed ? `revised from ${result.initialSeedStateId}` : "same topology as winning seed"}</small></div>
      <div><span>Local topology runs</span><strong>{result.runs.length}</strong><small>{new Set(result.runs.map((run) => run.stateId)).size} occupied states</small></div>
      <div><span>Breakpoint events</span><strong>{result.events.length}</strong><small>{result.events.reduce((total, event) => total + event.sprDistance, 0)} total SPR edits</small></div>
      <div><span>Largest boundary script</span><strong>{Math.max(0, ...result.events.map((event) => event.sprDistance))} SPR</strong><small>not restricted to one</small></div>
      <div><span>Fitch score</span><strong>{result.parsimony?.toFixed(2) ?? "—"}</strong><small>one-tree null {result.nullParsimony?.toFixed(2) ?? "—"}</small></div>
      <div><span>Explored graph</span><strong>{result.certificate.topologyStates} states</strong><small>{result.certificate.graphEdges} explicit SPR edges</small></div>
    </div>

    <article className="figure-card">
      <div className="figure-card__heading"><div><strong>{title}</strong><span>Viterbi-like exact minimum-run path in the connected SPR graph; diamonds mark edit-tape boundaries.</span></div><button type="button" className="button button--secondary button--svg" onClick={() => svgRef.current !== null && downloadSvg(svgRef.current, title)}>Export SVG</button></div>
      <div className="tree-figure-controls"><label><span>Figure title</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label></div>
      <div className="figure-scroll">
        <svg ref={svgRef} viewBox={`0 0 ${width} 174`} width={width} height="174" role="img" style={{ minWidth: "760px", width: "100%", height: "auto", display: "block", background: "#fff", fontFamily: FONT }}>
          <title>{title}</title>
          <text x={left} y="27" fill={INK} fontSize="18" fontWeight="650">{title}</text>
          <line x1={left} x2={width - right} y1="116" y2="116" stroke="#81908b" strokeWidth="1" />
          {result.runs.map((run) => {
            const state = result.states[run.stateIndex]!;
            const start = x(run.start);
            const end = x(run.end);
            return <g key={run.id} onClick={() => setSelectedStateId(run.stateId)} style={{ cursor: "pointer" }}>
              <rect x={start} y="61" width={Math.max(2, end - start)} height="38" rx="4" fill={state.color} fillOpacity={run.stateId === selectedStateId ? 1 : 0.78} stroke={run.stateId === result.masterStateId ? INK : "#fff"} strokeWidth={run.stateId === result.masterStateId ? 2 : 1} />
              {end - start > 44 && <text x={(start + end) / 2} y="85" textAnchor="middle" fill="#fff" fontSize="11" fontWeight="700">{run.stateId}</text>}
            </g>;
          })}
          {result.events.map((event) => <g key={`${event.breakpoint}-${event.fromStateId}-${event.toStateId}`}>
            <path d={`M ${x(event.breakpoint)} 51 l 6 -8 l 6 8 l -6 8 z`} fill="#f2a900" stroke="#684c00" strokeWidth="0.8" />
            <text x={x(event.breakpoint) + 7} y="39" textAnchor="middle" fill={INK} fontSize="9" fontWeight="700">{event.sprDistance}×</text>
          </g>)}
          {ticks.map((tick) => <g key={tick}><line x1={x(tick)} x2={x(tick)} y1="116" y2="122" stroke="#81908b" /><text x={x(tick)} y="139" textAnchor="middle" fill={MUTED} fontSize="10">{tick.toLocaleString()}</text></g>)}
          <text x={(left + width - right) / 2} y="160" textAnchor="middle" fill={INK} fontSize="12">Aligned nucleotide site</text>
          <rect x={left} y="45" width="13" height="13" fill="none" stroke={INK} strokeWidth="2" /><text x={left + 19} y="56" fill={MUTED} fontSize="9">master topology when occupied</text>
        </svg>
      </div>
    </article>

    <details className="result-panel" open><summary><span>Master and local topology viewer</span><small>Master is not fixed · choose any explored state · Newick download</small></summary><div className="result-panel__body">
      <div className="selection-visibility bsrel-table-controls"><label><span>Topology state</span><select value={selectedStateId} onChange={(event) => setSelectedStateId(event.target.value)}>{result.states.map((state) => <option key={state.id} value={state.id}>{`${state.id}${state.id === result.masterStateId ? " · master" : ""} · ${state.occupiedSites} sites · ${derivationByState.get(state.id)?.sprDistanceFromMaster ?? "—"} SPR from master`}</option>)}</select></label>{selectedState !== undefined && <button type="button" className="button button--secondary" onClick={() => downloadText(selectedState.tree, `fsart-spr-${selectedState.id.toLowerCase()}.nwk`)}>Download Newick</button>}<button type="button" className="button button--secondary" onClick={() => downloadText(JSON.stringify(result, null, 2), "fsart-unrestricted-spr-reconstruction.json")}>Event JSON</button></div>
      {selectedState !== undefined && <PhylogramFigure newick={selectedState.tree} tagged={false} />}
    </div></details>

    <details className="result-panel" open><summary><span>Breakpoint-indexed SPR edit tape</span><small>Every row is executable; multiple rows at one breakpoint are composed in order</small></summary><div className="result-panel__body">
      {result.events.length === 0 ? <div className="figure-empty"><strong>No topology-changing event selected.</strong><span>The best penalized reconstruction uses one topology across the alignment.</span></div> : <div className="result-table-wrap"><table className="result-table"><thead><tr><th>Breakpoint</th><th>Transition</th><th>Edit</th><th>Pruned subtree</th><th>Cut split</th><th>Source attachment</th><th>Regraft destination</th><th>Shortest-script ambiguity</th></tr></thead><tbody>{result.events.flatMap((event) => event.edits.map((edit: SprEdit, index) => <tr key={`${event.breakpoint}-${edit.step}-${edit.fromStateId}`}><td>{index === 0 ? event.breakpoint : ""}</td><td>{edit.fromStateId} → {edit.toStateId}</td><td>{edit.step}/{event.sprDistance}</td><td>{edit.prunedTaxa.join(", ")}</td><td>{edit.sourceSplit.join(" · ")}</td><td>{edit.sourceAttachmentSplit.join(" · ")}</td><td>{edit.destinationSplit.join(" · ")}</td><td>{index === 0 ? `${event.alternativeShortestScripts}${event.alternativesCapped ? "+" : ""} discovered shortest script${event.alternativeShortestScripts === 1 ? "" : "s"}` : ""}</td></tr>))}</tbody></table></div>}
      <h3>Master-to-local derivations</h3>
      <p className="figure-note">These scripts make the master representation explicit. A local tree is not a one-SPR category: its complete row-wise script is composed from top to bottom.</p>
      <div className="result-table-wrap"><table className="result-table"><thead><tr><th>Local state</th><th>Occupied sites</th><th>Distance from master</th><th>Composed edit script</th><th>Shortest-script ambiguity</th></tr></thead><tbody>{result.derivations.map((derivation) => <tr key={derivation.stateId}><td><strong>{derivation.stateId}</strong>{derivation.stateId === result.masterStateId && <small>master</small>}</td><td>{derivation.occupiedSites}</td><td>{derivation.sprDistanceFromMaster}</td><td>{derivation.edits.length === 0 ? "Identity" : derivation.edits.map((edit) => `${edit.step}. prune {${edit.prunedTaxa.join(", ")}} → {${edit.destinationSplit.join(" · ")}}`).join("; ")}</td><td>{`${derivation.alternativeShortestScripts}${derivation.alternativesCapped ? "+" : ""}`}</td></tr>)}</tbody></table></div>
    </div></details>

    <details className="result-panel" open><summary><span>Search audit and optimality certificate</span><small>{result.certificate.scope === "exhaustive-one-spr-local" ? "complete final one-SPR neighbourhood" : "budgeted topology-space column generation"}</small></summary><div className="result-panel__body">
      <p className={`method-note${result.certificate.completeOneSprNeighborhood ? "" : " method-note--warning"}`}>{result.certificate.message}</p>
      <div className="result-table-wrap"><table className="result-table"><thead><tr><th>Start</th><th>Round</th><th>Graph states</th><th>Occupied</th><th>Neighbours generated</th><th>Fitch scored</th><th>Added</th><th>Objective</th><th>Improvement</th><th>Master</th><th>Time</th></tr></thead><tbody>{result.iterations.map((iteration) => <tr key={`${iteration.start}-${iteration.iteration}`}><td>{iteration.start}</td><td>{iteration.iteration}</td><td>{iteration.topologyStates}</td><td>{iteration.occupiedStates}</td><td>{iteration.candidatesEnumerated}</td><td>{iteration.candidatesScored}</td><td>{iteration.candidatesAdded}</td><td>{iteration.objective.toFixed(3)}</td><td>{iteration.improvement.toFixed(3)}</td><td>{iteration.masterStateId}</td><td>{(iteration.elapsedMs / 1000).toFixed(2)} s</td></tr>)}</tbody></table></div>
    </div></details>
  </div>;
}

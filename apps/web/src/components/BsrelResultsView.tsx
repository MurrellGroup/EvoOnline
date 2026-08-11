import { useMemo, useState } from "react";
import type { BsrelRunResult } from "../types.js";
import { BsrelPhylogramFigure } from "./BsrelPhylogramFigure.js";
import { CommittedNumberInput } from "./CommittedNumberInput.js";

function downloadCsv(csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "bsrel-branch-tests.csv";
  anchor.click();
  URL.revokeObjectURL(url);
}

function probability(value: number | null): string {
  if (value === null) return "—";
  if (value < 1e-4) return value.toExponential(2);
  return value.toFixed(4);
}

export function BsrelResultsView({ result, threshold }: { readonly result: BsrelRunResult; readonly threshold: number }) {
  const [significanceThreshold, setSignificanceThreshold] = useState(Math.max(0.001, Math.min(0.25, threshold)));
  const [significantOnly, setSignificantOnly] = useState(false);
  const [branchKind, setBranchKind] = useState<"all" | "internal" | "terminal">("all");
  const [selectedBranch, setSelectedBranch] = useState<number | null>(null);
  const significant = useMemo(() => result.branches.filter((branch) => branch.pValueHolm !== null && branch.pValueHolm <= significanceThreshold), [result.branches, significanceThreshold]);
  const visible = useMemo(() => result.branches.filter((branch) => {
    if (significantOnly && !(branch.pValueHolm !== null && branch.pValueHolm <= significanceThreshold)) return false;
    if (branchKind === "internal" && branch.terminal) return false;
    if (branchKind === "terminal" && !branch.terminal) return false;
    return true;
  }), [branchKind, result.branches, significanceThreshold, significantOnly]);

  return <section className="results" aria-labelledby="bsrel-results-heading">
    <div className="section-heading section-heading--results">
      <div><p className="eyebrow">Analysis complete</p><h2 id="bsrel-results-heading">Fixed three-rate BS-REL</h2><p>Branch-wise episodic diversifying-selection tests from one jointly optimized alternative; no AIC complexity selection.</p></div>
      <button type="button" className="button button--primary" onClick={() => downloadCsv(result.csv)}>Download CSV</button>
    </div>
    <div className="result-stats">
      <div><span>Branches</span><strong>{result.diagnostics.branches.toLocaleString()}</strong></div>
      <div><span>Tested</span><strong>{result.diagnostics.testedBranches.toLocaleString()}</strong></div>
      <div><span>Holm ≤ {significanceThreshold.toPrecision(2)}</span><strong className="positive-text">{significant.length.toLocaleString()}</strong></div>
      <div><span>Alternative fit</span><strong>{result.diagnostics.alternativeConverged ? "Converged" : `${result.diagnostics.alternativeIterations} steps`}</strong></div>
      <div><span>Total time</span><strong>{((result.timings.totalMs ?? 0) / 1000).toFixed(2)} s</strong></div>
    </div>
    <p className="method-note"><strong>Test calibration:</strong> 0.50χ²₀ + 0.05χ²₁ + 0.45χ²₂, followed by Holm–Bonferroni. Each null sets that branch’s ω+ to 1 and re-optimizes only against its cached two-sided local blanket.</p>
    <details className="result-panel" open>
      <summary><span>Annotated fitted phylogeny</span><small>Branch colors, labels, dimensions, and SVG export are interactive.</small></summary>
      <div className="result-panel__body">
        <BsrelPhylogramFigure newick={result.tree} branches={result.branches} threshold={significanceThreshold} selectedBranch={selectedBranch} onSelectBranch={setSelectedBranch} />
      </div>
    </details>
    <details className="result-panel" open>
      <summary><span>Branch test table</span><small>{visible.length.toLocaleString()} visible branches</small></summary>
      <div className="result-panel__body">
        <div className="selection-visibility bsrel-table-controls">
          <label><span>Holm threshold</span><CommittedNumberInput value={significanceThreshold} onCommit={setSignificanceThreshold} integer={false} min={0.001} max={0.25} step={0.005} /></label>
          <label><span>Branch type</span><select value={branchKind} onChange={(event) => setBranchKind(event.target.value as typeof branchKind)}><option value="all">All</option><option value="internal">Internal</option><option value="terminal">Terminal</option></select></label>
          <label className="toggle"><input type="checkbox" checked={significantOnly} onChange={(event) => setSignificantOnly(event.target.checked)} /><span>Significant only</span></label>
        </div>
        <div className="result-table-wrap">
          <table className="result-table bsrel-table">
            <thead><tr><th>Branch</th><th>Type</th><th>Length</th><th>ω− · q−</th><th>ωN · qN</th><th>ω+ · q+</th><th>Mean ω</th><th>LRT</th><th>Raw p</th><th>Holm p</th></tr></thead>
            <tbody>{visible.map((branch) => <tr key={branch.branch} className={`${branch.pValueHolm !== null && branch.pValueHolm <= significanceThreshold ? "is-detected" : ""} ${selectedBranch === branch.branch ? "is-selected" : ""}`} onClick={() => setSelectedBranch(branch.branch)}>
              <td><strong>{branch.name}</strong><small>#{branch.branch} · parent {branch.parentName}</small></td><td>{branch.terminal ? "Terminal" : "Internal"}</td><td>{branch.fittedLength.toPrecision(4)}</td>
              <td>{branch.omegaMinus.toPrecision(3)} · {branch.weightMinus.toFixed(3)}</td><td>{branch.omegaNeutral.toPrecision(3)} · {branch.weightNeutral.toFixed(3)}</td><td className="positive-text">{branch.omegaPositive.toPrecision(3)} · {branch.weightPositive.toFixed(3)}</td>
              <td>{branch.meanOmega.toPrecision(4)}</td><td>{branch.likelihoodRatio?.toFixed(3) ?? "—"}</td><td>{probability(branch.pValue)}</td><td><strong>{probability(branch.pValueHolm)}</strong></td>
            </tr>)}</tbody>
          </table>
        </div>
      </div>
    </details>
  </section>;
}

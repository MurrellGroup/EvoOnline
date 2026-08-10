import { useMemo, useState } from "react";
import type { FubarRunResult } from "../types.js";
import { FubarVisualizations } from "./FubarVisualizations.js";

function probability(value: number): string {
  return value.toFixed(value >= 0.995 ? 4 : 3);
}

function downloadCsv(csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "fubar-posterior.csv";
  anchor.click();
  URL.revokeObjectURL(url);
}

export function FubarResultsView({ result, threshold }: { readonly result: FubarRunResult; readonly threshold: number }) {
  const [detectedOnly, setDetectedOnly] = useState(false);
  const [posteriorThreshold, setPosteriorThreshold] = useState(Math.max(0.5, Math.min(0.999, threshold)));
  const positive = useMemo(() => new Set(result.sites.filter((site) => site.pPositive > posteriorThreshold).map((site) => site.site)), [posteriorThreshold, result.sites]);
  const purifying = useMemo(() => new Set(result.sites.filter((site) => site.pPurifying > posteriorThreshold).map((site) => site.site)), [posteriorThreshold, result.sites]);
  const visible = useMemo(() => (detectedOnly ? result.sites.filter((site) => positive.has(site.site) || purifying.has(site.site)) : result.sites).slice(0, 500), [detectedOnly, positive, purifying, result.sites]);

  return (
    <section className="results" aria-labelledby="fubar-results-heading">
      <div className="section-heading section-heading--results">
        <div><p className="eyebrow">Analysis complete</p><h2 id="fubar-results-heading">FUBAR posterior</h2><p>Site-wise evidence for pervasive positive and purifying selection.</p></div>
        <button type="button" className="button button--primary" onClick={() => downloadCsv(result.csv)}>Download CSV</button>
      </div>
      <div className="result-stats">
        <div><span>Codon sites</span><strong>{result.diagnostics.codonSites.toLocaleString()}</strong></div>
        <div><span>Positive at {posteriorThreshold.toFixed(3)}</span><strong className="positive-text">{positive.size.toLocaleString()}</strong></div>
        <div><span>Purifying at {posteriorThreshold.toFixed(3)}</span><strong className="purifying-text">{purifying.size.toLocaleString()}</strong></div>
        <div><span>Posterior inference</span><strong>{result.diagnostics.inferenceMethod === "gibbs" ? "Gibbs" : "Dirichlet-EM"}</strong></div>
        <div><span>Total time</span><strong>{((result.timings.totalMs ?? 0) / 1000).toFixed(2)} s</strong></div>
      </div>
      <FubarVisualizations result={result} threshold={posteriorThreshold} onThresholdChange={setPosteriorThreshold} />
      <div className="result-toolbar">
        <label className="toggle"><input type="checkbox" checked={detectedOnly} onChange={(event) => setDetectedOnly(event.target.checked)} /><span>Selected sites only</span></label>
        <span>{visible.length.toLocaleString()} rows shown{(detectedOnly ? positive.size + purifying.size : result.sites.length) > 500 ? " (first 500)" : ""}</span>
      </div>
      <div className="result-table-wrap">
        <table className="result-table">
          <thead><tr><th>Codon</th><th>P(β &gt; α)</th><th>P(α &gt; β)</th><th>mean α</th><th>mean β</th><th>Selection</th></tr></thead>
          <tbody>{visible.map((site) => {
            const direction = positive.has(site.site) ? "positive" : purifying.has(site.site) ? "purifying" : "none";
            return (
              <tr key={site.site} className={direction === "positive" ? "is-positive" : direction === "purifying" ? "is-purifying" : undefined}>
                <td><strong>{site.site}</strong>{direction !== "none" && <span className={`site-mark site-mark--${direction}`}>{direction === "positive" ? "+" : "−"}</span>}</td>
                <td>{probability(site.pPositive)}</td><td>{probability(site.pPurifying)}</td><td>{site.meanAlpha.toFixed(3)}</td><td>{site.meanBeta.toFixed(3)}</td><td>{direction}</td>
              </tr>
            );
          })}</tbody>
        </table>
      </div>
    </section>
  );
}

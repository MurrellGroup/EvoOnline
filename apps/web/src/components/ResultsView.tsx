import { useMemo, useState } from "react";
import type { DifFubarRunResult } from "../types.js";
import { DifFubarVisualizations } from "./DifFubarVisualizations.js";

interface ResultsViewProps {
  readonly result: DifFubarRunResult;
  readonly threshold: number;
}

function probability(value: number): string {
  return value.toFixed(value >= 0.995 ? 4 : 3);
}

function downloadCsv(csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "diffubar-posterior.csv";
  anchor.click();
  URL.revokeObjectURL(url);
}

export function ResultsView({ result, threshold }: ResultsViewProps) {
  const [detectedOnly, setDetectedOnly] = useState(false);
  const [posteriorThreshold, setPosteriorThreshold] = useState(Math.max(0.5, Math.min(0.999, threshold)));
  const detectedSites = useMemo(
    () => result.sites
      .filter((site) => Math.max(site.pOmega1Greater, site.pOmega2Greater, site.pOmega1Positive, site.pOmega2Positive) > posteriorThreshold)
      .map((site) => site.site),
    [posteriorThreshold, result.sites],
  );
  const detected = useMemo(() => new Set(detectedSites), [detectedSites]);
  const visibleSites = useMemo(
    () => (detectedOnly ? result.sites.filter((site) => detected.has(site.site)) : result.sites).slice(0, 500),
    [detected, detectedOnly, result.sites],
  );

  return (
    <section className="results" aria-labelledby="results-heading">
      <div className="section-heading section-heading--results">
        <div>
          <p className="eyebrow">Analysis complete</p>
          <h2 id="results-heading">DifFUBAR posterior</h2>
          <p>Site-wise evidence for differential and positive selection across G1 and G2.</p>
        </div>
        <button type="button" className="button button--primary" onClick={() => downloadCsv(result.csv)}>
          Download CSV
        </button>
      </div>

      <div className="result-stats">
        <div><span>Codon sites</span><strong>{result.diagnostics.codonSites.toLocaleString()}</strong></div>
        <div><span>Detected at {posteriorThreshold.toFixed(3)}</span><strong>{detectedSites.length.toLocaleString()}</strong></div>
        <div><span>Backend</span><strong>{result.backend.replace("wasm-parallel", "parallel WASM")}</strong></div>
        <div><span>Total time</span><strong>{((result.timings.totalMs ?? 0) / 1000).toFixed(2)} s</strong></div>
      </div>

      <DifFubarVisualizations result={result} threshold={posteriorThreshold} onThresholdChange={setPosteriorThreshold} />

      <div className="result-toolbar">
        <label className="toggle">
          <input type="checkbox" checked={detectedOnly} onChange={(event) => setDetectedOnly(event.target.checked)} />
          <span>Detected sites only</span>
        </label>
        <span>{visibleSites.length.toLocaleString()} rows shown{(detectedOnly ? detectedSites.length : result.sites.length) > 500 ? " (first 500)" : ""}</span>
      </div>

      <div className="result-table-wrap">
        <table className="result-table">
          <thead>
            <tr>
              <th>Codon</th>
              <th>P(ω1 &gt; ω2)</th>
              <th>P(ω2 &gt; ω1)</th>
              <th>P(ω1 &gt; 1)</th>
              <th>P(ω2 &gt; 1)</th>
              <th>mean α</th>
              <th>mean ω1</th>
              <th>mean ω2</th>
            </tr>
          </thead>
          <tbody>
            {visibleSites.map((site) => (
              <tr key={site.site} className={detected.has(site.site) ? "is-detected" : undefined}>
                <td><strong>{site.site}</strong>{detected.has(site.site) && <span className="site-mark">hit</span>}</td>
                <td>{probability(site.pOmega1Greater)}</td>
                <td>{probability(site.pOmega2Greater)}</td>
                <td>{probability(site.pOmega1Positive)}</td>
                <td>{probability(site.pOmega2Positive)}</td>
                <td>{site.meanAlpha.toFixed(3)}</td>
                <td>{site.meanOmega1.toFixed(3)}</td>
                <td>{site.meanOmega2.toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

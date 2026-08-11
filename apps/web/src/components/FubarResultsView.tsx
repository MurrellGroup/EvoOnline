import { useMemo, useState } from "react";
import type { FubarRunResult } from "../types.js";
import { FubarVisualizations } from "./FubarVisualizations.js";
import { StructureMappingPanel } from "../features/structure-mapping/StructureMappingPanel.js";
import { buildFubarStructureSites, fubarStructureColorModes } from "../features/structure-mapping/result-colors.js";
import { ReferenceResultMap } from "../features/reference-map/ReferenceResultMap.js";
import { buildFubarReferenceEvidence, FUBAR_REFERENCE_HYPOTHESES } from "../features/reference-map/reference-hypotheses.js";
import { ApproximateFelResults } from "./ApproximateFelResults.js";

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

export function filterFubarSites(
  sites: FubarRunResult["sites"],
  positive: ReadonlySet<number>,
  purifying: ReadonlySet<number>,
  detectedOnly: boolean,
  showPositive: boolean,
  showPurifying: boolean,
): FubarRunResult["sites"] {
  if (showPositive && showPurifying && !detectedOnly) return sites;
  return sites.filter((site) => (showPositive && positive.has(site.site)) || (showPurifying && purifying.has(site.site)));
}

export function FubarResultsView({ result, threshold, alignment }: { readonly result: FubarRunResult; readonly threshold: number; readonly alignment: string }) {
  const [detectedOnly, setDetectedOnly] = useState(false);
  const [showPositive, setShowPositive] = useState(true);
  const [showPurifying, setShowPurifying] = useState(true);
  const [posteriorThreshold, setPosteriorThreshold] = useState(Math.max(0.5, Math.min(0.999, threshold)));
  const positive = useMemo(() => new Set(result.sites.filter((site) => site.pPositive > posteriorThreshold).map((site) => site.site)), [posteriorThreshold, result.sites]);
  const purifying = useMemo(() => new Set(result.sites.filter((site) => site.pPurifying > posteriorThreshold).map((site) => site.site)), [posteriorThreshold, result.sites]);
  const filtered = useMemo(() => filterFubarSites(result.sites, positive, purifying, detectedOnly, showPositive, showPurifying), [detectedOnly, positive, purifying, result.sites, showPositive, showPurifying]);
  const visible = useMemo(() => filtered.slice(0, 500), [filtered]);
  const structureSites = useMemo(() => buildFubarStructureSites(result, posteriorThreshold, showPositive, showPurifying), [posteriorThreshold, result, showPositive, showPurifying]);
  const structureColorModes = useMemo(() => fubarStructureColorModes(structureSites), [structureSites]);
  const referenceEvidence = useMemo(() => buildFubarReferenceEvidence(result), [result]);

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
      <div className="selection-visibility" role="group" aria-label="FUBAR selection directions shown in figures and table">
        <div><strong>Show selection directions</strong><span>Applies to figures, the table, and structure calls.</span></div>
        <label className="toggle toggle--positive"><input type="checkbox" checked={showPositive} onChange={(event) => setShowPositive(event.target.checked)} /><span>Positive selection</span></label>
        <label className="toggle toggle--purifying"><input type="checkbox" checked={showPurifying} onChange={(event) => setShowPurifying(event.target.checked)} /><span>Purifying selection</span></label>
      </div>
      <FubarVisualizations result={result} threshold={posteriorThreshold} onThresholdChange={setPosteriorThreshold} showPositive={showPositive} showPurifying={showPurifying} />
      <div className="result-toolbar">
        <label className="toggle"><input type="checkbox" checked={detectedOnly} onChange={(event) => setDetectedOnly(event.target.checked)} /><span>Selected sites only</span></label>
        <span>{visible.length.toLocaleString()} rows shown{filtered.length > 500 ? " (first 500)" : ""}</span>
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
      {result.approximateFel !== undefined && <ApproximateFelResults result={result.approximateFel} {...(result.timings.approximateFelMs === undefined ? {} : { elapsedMs: result.timings.approximateFelMs })} />}
      <ReferenceResultMap modelName="FUBAR" alignmentText={alignment} evidenceSites={referenceEvidence} hypotheses={FUBAR_REFERENCE_HYPOTHESES} initialThreshold={posteriorThreshold} />
      <StructureMappingPanel alignmentText={alignment} sites={structureSites} colorModes={structureColorModes} />
    </section>
  );
}

import { useMemo, useState } from "react";
import type { BameRunResult } from "../types.js";
import { BameVisualizations } from "./BameVisualizations.js";
import { StructureMappingPanel } from "../features/structure-mapping/StructureMappingPanel.js";
import { bameStructureColorModes, buildBameStructureSites } from "../features/structure-mapping/result-colors.js";
import { ReferenceResultMap } from "../features/reference-map/ReferenceResultMap.js";
import { BAME_REFERENCE_HYPOTHESES, buildBameReferenceEvidence } from "../features/reference-map/reference-hypotheses.js";

function probability(value: number): string { return value.toFixed(value >= 0.995 ? 4 : 3); }
function numeric(value: number): string { return Number.isFinite(value) ? value >= 1000 ? value.toExponential(3) : value.toFixed(3) : "∞"; }

function downloadCsv(result: BameRunResult): void {
  const url = URL.createObjectURL(new Blob([result.csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${result.method}-posterior.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function BameResultsView({ result, threshold, alignment }: { readonly result: BameRunResult; readonly threshold: number; readonly alignment: string }) {
  const [posteriorThreshold, setPosteriorThreshold] = useState(Math.max(0.5, Math.min(0.999, threshold)));
  const [detectedOnly, setDetectedOnly] = useState(false);
  const detected = useMemo(() => new Set(result.sites.filter((site) => site.pPositive > posteriorThreshold).map((site) => site.site)), [posteriorThreshold, result.sites]);
  const filtered = useMemo(() => detectedOnly ? result.sites.filter((site) => detected.has(site.site)) : result.sites, [detected, detectedOnly, result.sites]);
  const visible = filtered.slice(0, 500);
  const structureSites = useMemo(() => buildBameStructureSites(result, posteriorThreshold), [posteriorThreshold, result]);
  const structureModes = useMemo(() => bameStructureColorModes(structureSites), [structureSites]);
  const referenceEvidence = useMemo(() => buildBameReferenceEvidence(result), [result]);
  const method = result.method.toUpperCase();
  return <section className="results" aria-labelledby="bame-results-heading">
    <div className="section-heading section-heading--results"><div><p className="eyebrow">Analysis complete · experimental model</p><h2 id="bame-results-heading">{method} posterior</h2><p>Site-wise evidence for episodic positive selection from branch-wise ω mixtures.</p></div><button type="button" className="button button--primary" onClick={() => downloadCsv(result)}>Download CSV</button></div>
    <p className="method-note"><strong>Development provenance:</strong> ported from CodonMolecularEvolution.jl <code>MixtureModels@{result.diagnostics.modelDraftCommit.slice(0, 8)}</code>. This run uses the <strong>{result.diagnostics.gridPreset === "fast" ? "fast interactive" : "full Julia-draft"}</strong> grid. {result.method === "fame" ? result.diagnostics.weightIntegration === "julia-draft-log-average" ? "It reproduces the draft’s mean-of-log-likelihood operation; that is not likelihood marginalization." : `It uses statistically valid ${result.diagnostics.weightPoints}-point likelihood-domain quadrature instead of the draft’s mean of log likelihoods.` : `It retains the draft’s capped-grid multiplicity with a ${result.diagnostics.gammaSlices}-mid-quantile Gamma approximation and ${result.diagnostics.transitionEngine === "julia-interpolated" ? "Julia-style 50-node transition interpolation" : "direct uniformization"}.`} Bayes factors are empirical-Bayes evidence ratios because their prior mass is learned from these sites.</p>
    {(result.diagnostics.regionalTrees ?? 1) > 1 && <p className="method-note"><strong>Recombination-aware likelihood:</strong> {result.diagnostics.regionalTrees} regional {result.diagnostics.branchLengthSource} trees were evaluated at their assigned codons. One global codon model and one common synonymous-rate multiplier are shared; relative tree scales are locked.</p>}
    <div className="result-stats">
      <div><span>Codon sites</span><strong>{result.diagnostics.codonSites.toLocaleString()}</strong></div>
      <div><span>Genetic code</span><strong>NCBI {result.diagnostics.geneticCodeId}</strong><small>{result.diagnostics.geneticCodeName}</small></div>
      <div><span>Positive at {posteriorThreshold.toFixed(3)}</span><strong className="positive-text">{detected.size.toLocaleString()}</strong></div>
      <div><span>Grid categories</span><strong>{result.diagnostics.categories.toLocaleString()}</strong></div>
      <div><span>Posterior inference</span><strong>{result.diagnostics.inferenceMethod === "gibbs" ? "Gibbs" : "Dirichlet-EM"}</strong></div>
      <div><span>Regional trees</span><strong>{result.diagnostics.regionalTrees ?? 1}</strong><small>{result.diagnostics.branchScalePolicy ?? "single-tree"}</small></div>
      <div><span>Total time</span><strong>{((result.timings.totalMs ?? 0) / 1000).toFixed(2)} s</strong></div>
    </div>
    <BameVisualizations result={result} threshold={posteriorThreshold} onThresholdChange={setPosteriorThreshold} />
    <div className="result-toolbar"><label className="toggle"><input type="checkbox" checked={detectedOnly} onChange={(event) => setDetectedOnly(event.target.checked)} /><span>Detected sites only</span></label><span>{visible.length.toLocaleString()} rows shown{filtered.length > 500 ? " (first 500)" : ""}</span></div>
    <div className="result-table-wrap"><table className="result-table"><thead><tr>
      <th>Codon</th><th>Positive posterior</th><th>Empirical BF</th><th>mean α</th>
      {result.method === "fame" ? <><th>mean ω₁</th><th>mean ω₂</th></> : <><th>P(uncapped)</th><th>mean ω</th><th>Gamma shape</th><th>mean ω SD</th><th>positive branch fraction</th></>}
      <th>Call</th>
    </tr></thead><tbody>{visible.map((site) => {
      const selected = detected.has(site.site);
      return <tr key={site.site} className={selected ? "is-positive" : undefined}><td><strong>{site.site}</strong>{selected && <span className="site-mark site-mark--positive">+</span>}</td><td>{probability(site.pPositive)}</td><td>{numeric(site.bayesFactor)}</td><td>{site.meanAlpha.toFixed(3)}</td>
        {result.method === "fame" && "meanOmega1" in site ? <><td>{site.meanOmega1.toFixed(3)}</td><td>{site.meanOmega2.toFixed(3)}</td></> : "meanOmega" in site ? <><td>{probability(site.pUncapped)}</td><td>{site.meanOmega.toFixed(3)}</td><td>{site.meanShape.toFixed(3)}</td><td>{site.meanOmegaStandardDeviation.toFixed(3)}</td><td>{site.meanPositiveBranchFraction.toFixed(3)}</td></> : null}
        <td>{selected ? "episodic positive" : "none"}</td></tr>;
    })}</tbody></table></div>
    <ReferenceResultMap modelName={method} alignmentText={alignment} geneticCodeId={result.diagnostics.geneticCodeId} evidenceSites={referenceEvidence} hypotheses={BAME_REFERENCE_HYPOTHESES} initialThreshold={posteriorThreshold} />
    <StructureMappingPanel alignmentText={alignment} geneticCodeId={result.diagnostics.geneticCodeId} sites={structureSites} colorModes={structureModes} selectionThreshold={posteriorThreshold} />
  </section>;
}

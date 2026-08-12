import { useMemo, useState } from "react";
import type { CladeShiftRunResult } from "../types.js";
import { CladeShiftSiteFigure } from "./CladeShiftSiteFigure.js";
import { CladeShiftTreeFigure } from "./CladeShiftTreeFigure.js";
import { CommittedNumberInput } from "./CommittedNumberInput.js";
import { ReferenceResultMap } from "../features/reference-map/ReferenceResultMap.js";
import { CLADE_SHIFT_REFERENCE_HYPOTHESES, buildCladeShiftReferenceEvidence } from "../features/reference-map/reference-hypotheses.js";
import { StructureMappingPanel } from "../features/structure-mapping/StructureMappingPanel.js";
import { buildCladeShiftStructureSites, cladeShiftStructureColorModes } from "../features/structure-mapping/result-colors.js";

function downloadCsv(csv: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function probability(value: number): string {
  return value > 0 && value < 1e-4 ? value.toExponential(2) : value.toFixed(value > 0.995 ? 4 : 3);
}

function number(value: number): string {
  if (!Number.isFinite(value)) return value > 0 ? "∞" : "−∞";
  return Math.abs(value) >= 1_000 ? value.toExponential(2) : value.toFixed(3);
}

export function CladeShiftResultsView({ result, threshold, alignment }: { readonly result: CladeShiftRunResult; readonly threshold: number; readonly alignment: string }) {
  const initialSite = result.detectedSites[0] ?? result.sites.reduce((best, site) => site.pShift > best.pShift ? site : best, result.sites[0]!).site;
  const [posteriorThreshold, setPosteriorThreshold] = useState(Math.max(0.501, Math.min(0.999, threshold)));
  const [selectedSite, setSelectedSite] = useState(initialSite);
  const [selectedBranch, setSelectedBranch] = useState(result.sites[initialSite - 1]?.mapBranch ?? 1);
  const [siteFilter, setSiteFilter] = useState<"all" | "detected" | "relaxation" | "intensification">("all");
  const [branchFilter, setBranchFilter] = useState<"eligible" | "all">("eligible");
  const visibleSites = useMemo(() => result.sites.filter((site) => {
    if (siteFilter === "detected") return site.pShift >= posteriorThreshold;
    if (siteFilter === "relaxation") return site.pShift >= posteriorThreshold && site.pRelaxation >= site.pIntensification;
    if (siteFilter === "intensification") return site.pShift >= posteriorThreshold && site.pIntensification > site.pRelaxation;
    return true;
  }).slice(0, 500), [posteriorThreshold, result.sites, siteFilter]);
  const visibleBranches = useMemo(() => result.branches.filter((branch) => branchFilter === "all" || branch.eligible), [branchFilter, result.branches]);
  const detected = result.sites.filter((site) => site.pShift >= posteriorThreshold);
  const relaxed = detected.filter((site) => site.pRelaxation >= site.pIntensification).length;
  const intensified = detected.length - relaxed;
  const selected = result.sites[selectedSite - 1]!;
  const selectedBranchName = result.branches[selectedBranch - 1]?.name;
  const referenceEvidence = useMemo(() => buildCladeShiftReferenceEvidence(result), [result]);
  const structureSites = useMemo(
    () => buildCladeShiftStructureSites(result, posteriorThreshold, selectedBranch),
    [posteriorThreshold, result, selectedBranch],
  );
  const structureModes = useMemo(
    () => cladeShiftStructureColorModes(structureSites, selectedBranchName),
    [selectedBranchName, structureSites],
  );
  const commitSite = (raw: number): void => {
    const site = Math.max(1, Math.min(result.posterior.siteCount, Math.round(raw)));
    setSelectedSite(site);
    setSelectedBranch(result.sites[site - 1]?.mapBranch ?? selectedBranch);
  };
  const commitBranch = (raw: number): void => setSelectedBranch(Math.max(1, Math.min(result.posterior.branchCount, Math.round(raw))));

  return <section className="results" aria-labelledby="clade-shift-results-heading">
    <div className="section-heading section-heading--results"><div><p className="eyebrow">Analysis complete · exploratory model</p><h2 id="clade-shift-results-heading">CladeShift</h2><p>Unsupervised codon-wise discovery of persistent selection-intensity changes in descendant clades.</p></div><div className="result-downloads"><button type="button" className="button button--primary" onClick={() => downloadCsv(result.siteCsv, "cladeshift-sites.csv")}>Site CSV</button><button type="button" className="button button--secondary" onClick={() => downloadCsv(result.branchCsv, "cladeshift-branches.csv")}>Branch CSV</button></div></div>
    <p className="method-note"><strong>Question:</strong> did one branch initiate a change in selective stringency at this codon that persisted throughout its descendant clade, and where? The null uses the ordinary FUBAR α–β process on every edge. Under a candidate shift, that edge and every edge below it use <strong>ω′ = ω<sup>K</sup></strong>: K&lt;1 relaxes both purifying and positive selection toward neutrality; K&gt;1 intensifies them away from neutrality. Fixed K states, direction, and every eligible initiating branch are integrated with explicit priors—none is selected by an unpenalized maximum.</p>
    <p className="method-note method-note--warning"><strong>Exploratory and not simulation-validated:</strong> these are empirical-Bayes posteriors, not calibrated p-values. Baseline α–β uncertainty is integrated using <span className="formula">BF = E<sub>q<sub>null</sub>(α,β)</sub>[L<sub>shift</sub>/L<sub>null</sub>]</span>; highest-mass null components are retained adaptively until the requested mass target or hard cap is reached, and the actual coverage is reported. CladeShift detects a change in ω stringency, not a causal phenotype association or a directional amino-acid preference shift.</p>
    <div className="result-stats">
      <div><span>Detected shifts</span><strong>{detected.length.toLocaleString()}</strong></div>
      <div><span>Relaxed</span><strong style={{ color: "#4267d5" }}>{relaxed.toLocaleString()}</strong></div>
      <div><span>Intensified</span><strong className="positive-text">{intensified.toLocaleString()}</strong></div>
      <div><span>Candidate clades</span><strong>{result.diagnostics.candidateClades.toLocaleString()}</strong></div>
      <div><span>Prior P(shift)</span><strong>{probability(result.shiftPrior)}</strong></div>
      <div><span>Null compression</span><strong>{result.diagnostics.meanPosteriorComponents.toFixed(1)} mean / {result.diagnostics.posteriorComponents} max</strong><small>{(result.diagnostics.minimumCapturedPosteriorMass * 100).toFixed(1)}% min · {(result.diagnostics.meanCapturedPosteriorMass * 100).toFixed(1)}% mean mass</small></div>
      <div><span>Total time</span><strong>{((result.timings.totalMs ?? 0) / 1000).toFixed(2)} s</strong></div>
    </div>

    <details className="result-panel" open><summary><span>Codon shift landscape</span><small>Relaxation, intensification, evidence, and approximation audit · editable · SVG</small></summary><div className="result-panel__body"><CladeShiftSiteFigure result={result} selectedSite={selectedSite} onSelectSite={commitSite} posteriorThreshold={posteriorThreshold} /></div></details>
    <details className="result-panel" open><summary><span>Initiating-branch posterior tree</span><small>Selected-codon location and gene-wide burden · editable · SVG</small></summary><div className="result-panel__body"><CladeShiftTreeFigure result={result} selectedSite={selectedSite} onSelectSite={commitSite} selectedBranch={selectedBranch} onSelectBranch={commitBranch} /></div></details>

    <details className="result-panel" open><summary><span>Selected-codon posterior</span><small>Codon {selectedSite} · MAP branch {selected.mapBranchName}</small></summary><div className="result-panel__body">
      <div className="selection-visibility bsrel-table-controls"><label><span>Selected codon</span><CommittedNumberInput value={selectedSite} onCommit={commitSite} min={1} max={result.posterior.siteCount} /></label><label><span>Selected branch</span><CommittedNumberInput value={selectedBranch} onCommit={commitBranch} min={1} max={result.posterior.branchCount} /></label><label><span>Live posterior threshold</span><CommittedNumberInput value={posteriorThreshold} onCommit={setPosteriorThreshold} min={0.501} max={0.999} step={0.01} integer={false} /></label></div>
      <div className="result-stats"><div><span>P(any shift)</span><strong>{probability(selected.pShift)}</strong></div><div><span>P(relaxation)</span><strong style={{ color: "#4267d5" }}>{probability(selected.pRelaxation)}</strong></div><div><span>P(intensification)</span><strong className="positive-text">{probability(selected.pIntensification)}</strong></div><div><span>Shift log BF</span><strong>{number(selected.logBayesFactor)}</strong></div><div><span>MAP initiating branch</span><strong>{selected.mapBranchName}</strong></div><div><span>P(MAP branch)</span><strong>{probability(selected.mapBranchPosterior)}</strong></div></div>
      <div className="clade-shift-k-grid" aria-label="Selection intensity posterior">{[...result.intensities].map((intensity, index) => { const mass = result.posterior.intensityPosterior[(selectedSite - 1) * result.intensities.length + index] ?? 0; return <div key={intensity}><span>K={intensity.toPrecision(3)}</span><div><i style={{ width: `${Math.max(1, mass * 100)}%`, background: intensity < 1 ? "#4267d5" : "#df4652" }} /></div><strong>{probability(mass)}</strong></div>; })}</div>
    </div></details>

    <details className="result-panel" open><summary><span>Site results</span><small>{visibleSites.length.toLocaleString()} rows shown</small></summary><div className="result-panel__body">
      <div className="selection-visibility bsrel-table-controls"><label><span>Site filter</span><select value={siteFilter} onChange={(event) => setSiteFilter(event.target.value as typeof siteFilter)}><option value="all">All sites</option><option value="detected">Detected at live threshold</option><option value="relaxation">Detected relaxation</option><option value="intensification">Detected intensification</option></select></label><label><span>Live threshold</span><CommittedNumberInput value={posteriorThreshold} onCommit={setPosteriorThreshold} min={0.501} max={0.999} step={0.01} integer={false} /></label></div>
      <div className="result-table-wrap"><table className="result-table"><thead><tr><th>Codon</th><th>P(shift)</th><th>P(relax)</th><th>P(intensify)</th><th>log BF</th><th>MAP branch</th><th>P(branch)</th><th>Mean K | shift</th><th>Null mass retained</th></tr></thead><tbody>{visibleSites.map((site) => <tr key={site.site} className={site.site === selectedSite ? "is-selected" : undefined} onClick={() => commitSite(site.site)}><td><strong>{site.site}</strong></td><td className={site.pShift >= posteriorThreshold ? "positive-text" : undefined}>{probability(site.pShift)}</td><td>{probability(site.pRelaxation)}</td><td>{probability(site.pIntensification)}</td><td>{number(site.logBayesFactor)}</td><td><strong>{site.mapBranchName}</strong><small>#{site.mapBranch}</small></td><td>{probability(site.mapBranchPosterior)}</td><td>{site.meanIntensityGivenShift.toPrecision(4)}</td><td>{(site.capturedNullPosteriorMass * 100).toFixed(1)}%</td></tr>)}</tbody></table></div>
    </div></details>

    <details className="result-panel" open><summary><span>Branch summaries</span><small>{visibleBranches.length.toLocaleString()} branches shown</small></summary><div className="result-panel__body">
      <div className="selection-visibility bsrel-table-controls"><label><span>Branch filter</span><select value={branchFilter} onChange={(event) => setBranchFilter(event.target.value as typeof branchFilter)}><option value="eligible">Eligible change points</option><option value="all">All branches</option></select></label></div>
      <div className="result-table-wrap"><table className="result-table"><thead><tr><th>Branch</th><th>Clade size</th><th>Eligible</th><th>E[shifted sites]</th><th>E[relaxed]</th><th>E[intensified]</th><th>Max site posterior</th><th>MAP site</th></tr></thead><tbody>{visibleBranches.map((branch) => <tr key={branch.branch} className={branch.branch === selectedBranch ? "is-selected" : undefined} onClick={() => commitBranch(branch.branch)}><td><strong>{branch.name}</strong><small>#{branch.branch} · parent {branch.parentName}</small></td><td>{branch.descendantTips.toLocaleString()} tips</td><td>{branch.eligible ? "Yes" : "No"}</td><td>{number(branch.expectedShiftedSites)}</td><td>{number(branch.expectedRelaxedSites)}</td><td>{number(branch.expectedIntensifiedSites)}</td><td>{probability(branch.maximumSitePosterior)}</td><td>{branch.mapSite}</td></tr>)}</tbody></table></div>
    </div></details>

    <ReferenceResultMap modelName="CladeShift" alignmentText={alignment} evidenceSites={referenceEvidence} hypotheses={CLADE_SHIFT_REFERENCE_HYPOTHESES} initialThreshold={posteriorThreshold} />
    <StructureMappingPanel alignmentText={alignment} sites={structureSites} colorModes={structureModes} selectionThreshold={posteriorThreshold} />
  </section>;
}

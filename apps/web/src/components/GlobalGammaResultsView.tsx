import { useMemo, useState } from "react";
import type { GlobalGammaRunResult } from "../types.js";
import { GlobalGammaTreeFigure } from "./GlobalGammaTreeFigure.js";
import { GlobalGammaSiteFigure } from "./GlobalGammaSiteFigure.js";
import { CommittedNumberInput } from "./CommittedNumberInput.js";
import { ReferenceResultMap } from "../features/reference-map/ReferenceResultMap.js";
import { GLOBAL_GAMMA_REFERENCE_HYPOTHESES, buildGlobalGammaReferenceEvidence } from "../features/reference-map/reference-hypotheses.js";
import { StructureMappingPanel } from "../features/structure-mapping/StructureMappingPanel.js";
import { buildGlammaStructureSites, glammaStructureColorModes } from "../features/structure-mapping/result-colors.js";

function downloadCsv(csv: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function number(value: number, digits = 3): string {
  if (!Number.isFinite(value)) return value > 0 ? "∞" : "−∞";
  return Math.abs(value) >= 1_000 ? value.toExponential(2) : value.toFixed(digits);
}

function probability(value: number): string {
  return value < 1e-4 && value > 0 ? value.toExponential(2) : value.toFixed(value >= 0.995 ? 4 : 3);
}

export function GlobalGammaResultsView({ result, threshold, alignment }: { readonly result: GlobalGammaRunResult; readonly threshold: number; readonly alignment: string }) {
  const [posteriorThreshold, setPosteriorThreshold] = useState(Math.max(0.5, Math.min(0.999, threshold)));
  const [selectedSite, setSelectedSite] = useState(1);
  const [selectedBranch, setSelectedBranch] = useState<number | null>(null);
  const [siteFilter, setSiteFilter] = useState<"all" | "supported" | "tail">("all");
  const [branchFilter, setBranchFilter] = useState<"all" | "activation" | "capped">("all");
  const evidenceCutoff = Math.log(10);
  const visibleSites = useMemo(() => result.sites.filter((site) => {
    if (siteFilter === "supported") return site.cappedLogEvidence >= evidenceCutoff;
    if (siteFilter === "tail") return site.maximumBranchPosterior >= posteriorThreshold;
    return true;
  }).slice(0, 500), [posteriorThreshold, result.sites, siteFilter]);
  const visibleBranches = useMemo(() => result.branches.filter((branch) => {
    if (branchFilter === "activation") return branch.activationLogBayesFactor >= evidenceCutoff;
    if (branchFilter === "capped") return branch.cappedLogEvidence >= evidenceCutoff;
    return true;
  }), [branchFilter, result.branches]);
  const activationSupported = result.branches.filter((branch) => branch.activationLogBayesFactor >= evidenceCutoff).length;
  const cappedSupported = result.branches.filter((branch) => branch.cappedLogEvidence >= evidenceCutoff).length;
  const referenceEvidence = useMemo(() => buildGlobalGammaReferenceEvidence(result), [result]);
  const selectedBranchName = selectedBranch === null ? undefined : result.branches[selectedBranch - 1]?.name;
  const structureSites = useMemo(
    () => buildGlammaStructureSites(result, posteriorThreshold, selectedBranch),
    [posteriorThreshold, result, selectedBranch],
  );
  const structureColorModes = useMemo(
    () => glammaStructureColorModes(structureSites, selectedBranchName),
    [selectedBranchName, structureSites],
  );

  const commitSite = (site: number): void => setSelectedSite(Math.max(1, Math.min(result.posterior.siteCount, Math.round(site))));
  const commitBranch = (branch: number): void => setSelectedBranch(Math.max(1, Math.min(result.posterior.branchCount, Math.round(branch))));

  return <section className="results" aria-labelledby="global-gamma-results-heading">
    <div className="section-heading section-heading--results"><div><p className="eyebrow">Analysis complete · exploratory model</p><h2 id="global-gamma-results-heading">Glamma</h2><p>Globally fitted Gamma(ω) random effects across branch–site cells, with a mean-one Gamma(α) mixture across sites.</p></div><div className="result-downloads"><button type="button" className="button button--primary" onClick={() => downloadCsv(result.branchCsv, "glamma-branches.csv")}>Branch CSV</button><button type="button" className="button button--secondary" onClick={() => downloadCsv(result.siteCsv, "glamma-sites.csv")}>Site CSV</button></div></div>
    <p className="method-note"><strong>Likelihood hierarchy:</strong> for each α category, the same site-wise α is used on every edge while each edge independently integrates the fitted Gamma(ω) categories; complete-tree site likelihoods are then averaged over α. The selection log evidence ratio is <strong>log L(full Gamma) − log L(ω&gt;1→1 null)</strong>: the site null applies that replacement to every edge at one site, while the branch null applies it to one edge across every site. Weights and global parameters are not re-optimized. The activation empirical BF integrates <em>λ</em> under Beta({result.diagnostics.activationPriorAlpha.toPrecision(3)}, {result.diagnostics.activationPriorBeta.toPrecision(3)}). These are plug-in conditional/empirical-Bayes quantities, not calibrated LRT p-values.</p>
    <div className="result-stats">
      <div><span>Gamma ω mean</span><strong>{result.fit.omegaMean.toPrecision(4)}</strong></div>
      <div><span>Genetic code</span><strong>NCBI {result.diagnostics.geneticCodeId}</strong><small>{result.diagnostics.geneticCodeName}</small></div>
      <div><span>Gamma ω shape</span><strong>{result.fit.omegaShape.toPrecision(4)}</strong></div>
      <div><span>Gamma α shape</span><strong>{result.fit.alphaShape.toPrecision(4)}</strong></div>
      <div><span>Prior P(ω &gt; 1)</span><strong>{probability(result.positivePrior)}</strong></div>
      <div><span>Activation BF ≥ 10</span><strong className="positive-text">{activationSupported.toLocaleString()}</strong></div>
      <div><span>Branch-null ER ≥ 10</span><strong className="positive-text">{cappedSupported.toLocaleString()}</strong></div>
      <div><span>Total time</span><strong>{((result.timings.totalMs ?? 0) / 1000).toFixed(2)} s</strong></div>
    </div>

    <details className="result-panel" open><summary><span>Interactive branch evidence tree</span><small>Global summaries and selected-site posterior intensity · editable · SVG</small></summary><div className="result-panel__body"><GlobalGammaTreeFigure result={result} selectedSite={selectedSite} onSelectSite={commitSite} selectedBranch={selectedBranch} onSelectBranch={commitBranch} /></div></details>
    <details className="result-panel" open><summary><span>Codon alignment evidence track</span><small>Site truncation, branch burden, and the selected branch’s local signal · SVG</small></summary><div className="result-panel__body"><GlobalGammaSiteFigure result={result} selectedSite={selectedSite} onSelectSite={commitSite} selectedBranch={selectedBranch} posteriorThreshold={posteriorThreshold} /></div></details>

    <details className="result-panel" open><summary><span>Branch evidence table</span><small>{visibleBranches.length.toLocaleString()} branches shown</small></summary><div className="result-panel__body">
      <div className="selection-visibility bsrel-table-controls"><label><span>Branch filter</span><select value={branchFilter} onChange={(event) => setBranchFilter(event.target.value as typeof branchFilter)}><option value="all">All branches</option><option value="activation">Activation BF ≥ 10</option><option value="capped">Full / branch-null ER ≥ 10</option></select></label><label><span>Selected branch</span><CommittedNumberInput value={selectedBranch ?? 1} onCommit={commitBranch} min={1} max={result.posterior.branchCount} /></label></div>
      <div className="result-table-wrap"><table className="result-table global-gamma-table"><thead><tr><th>Branch</th><th>Type</th><th>Length</th><th>Full / branch-null log ER</th><th>Activation log BF</th><th>Posterior mean λ</th><th>E[positive sites]</th><th>P(any site)</th><th>Any-site log BF</th><th>Max site posterior</th></tr></thead><tbody>{visibleBranches.map((branch) => <tr key={branch.branch} className={selectedBranch === branch.branch ? "is-selected" : undefined} onClick={() => setSelectedBranch(branch.branch)}><td><strong>{branch.name}</strong><small>#{branch.branch} · parent {branch.parentName}</small></td><td>{branch.terminal ? "Terminal" : "Internal"}</td><td>{branch.branchLength.toPrecision(4)}</td><td className={branch.cappedLogEvidence >= evidenceCutoff ? "positive-text" : undefined}>{number(branch.cappedLogEvidence)}</td><td className={branch.activationLogBayesFactor >= evidenceCutoff ? "positive-text" : undefined}>{number(branch.activationLogBayesFactor)}</td><td>{probability(branch.activationPosteriorMean)}</td><td>{number(branch.expectedPositiveSites)}</td><td>{probability(branch.anySitePositivePosterior)}</td><td>{number(branch.anySitePositiveLogBayesFactor)}</td><td>{probability(branch.maximumSitePosterior)}</td></tr>)}</tbody></table></div>
    </div></details>

    <details className="result-panel" open><summary><span>Site evidence table</span><small>{visibleSites.length.toLocaleString()} rows shown{result.sites.length > 500 && siteFilter === "all" ? " · first 500" : ""}</small></summary><div className="result-panel__body">
      <div className="selection-visibility bsrel-table-controls"><label><span>Site filter</span><select value={siteFilter} onChange={(event) => setSiteFilter(event.target.value as typeof siteFilter)}><option value="all">All sites</option><option value="supported">Full / all-branches-null ER ≥ 10</option><option value="tail">Max branch posterior ≥ threshold</option></select></label><label><span>Tail threshold</span><CommittedNumberInput value={posteriorThreshold} onCommit={setPosteriorThreshold} min={0.5} max={0.999} step={0.01} integer={false} /></label><label><span>Selected codon</span><CommittedNumberInput value={selectedSite} onCommit={commitSite} min={1} max={result.posterior.siteCount} /></label></div>
      <div className="result-table-wrap"><table className="result-table"><thead><tr><th>Codon</th><th>Full / all-branches-null log ER</th><th>Evidence ratio</th><th>Conditional support</th><th>E[positive branches]</th><th>Max branch posterior</th></tr></thead><tbody>{visibleSites.map((site) => <tr key={site.site} className={selectedSite === site.site ? "is-selected" : undefined} onClick={() => setSelectedSite(site.site)}><td><strong>{site.site}</strong></td><td className={site.cappedLogEvidence >= evidenceCutoff ? "positive-text" : undefined}>{number(site.cappedLogEvidence)}</td><td>{number(site.cappedEvidenceRatio)}</td><td>{probability(site.conditionalSupport)}</td><td>{number(site.expectedPositiveBranches)}</td><td className={site.maximumBranchPosterior >= posteriorThreshold ? "positive-text" : undefined}>{probability(site.maximumBranchPosterior)}</td></tr>)}</tbody></table></div>
    </div></details>

    <ReferenceResultMap modelName="Glamma" alignmentText={alignment} geneticCodeId={result.diagnostics.geneticCodeId} evidenceSites={referenceEvidence} hypotheses={GLOBAL_GAMMA_REFERENCE_HYPOTHESES} initialThreshold={posteriorThreshold} />
    <StructureMappingPanel alignmentText={alignment} geneticCodeId={result.diagnostics.geneticCodeId} sites={structureSites} colorModes={structureColorModes} selectionThreshold={posteriorThreshold} />
  </section>;
}

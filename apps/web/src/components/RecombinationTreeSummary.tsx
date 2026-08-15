import { useMemo, useState, type ChangeEvent } from "react";
import { downloadText } from "../lib/file-download.js";
import {
  recombinationBundleFilename,
  serializeRecombinationTreeBundle,
  type EvoOnlineRecombinationTreeBundle,
} from "../lib/recombination-bundle.js";

export interface RecombinationModeInfo {
  readonly eyebrow: string;
  readonly title: string;
  readonly shortTitle: string;
  readonly description: string;
  readonly provenance: string;
}

export function recombinationModeInfo(bundle: EvoOnlineRecombinationTreeBundle): RecombinationModeInfo {
  if (bundle.representation === "independent-regional-trees") {
    const truth = bundle.sourceMethod === "simulation-truth";
    return {
      eyebrow: truth ? "Recombination truth" : "FSART-style recombination input",
      title: truth ? "Known independent regional phylogenies" : "Independent regional phylogenies",
      shortTitle: truth ? "Known regional trees" : "Independent regional trees",
      description: truth
        ? "Each genomic region uses its simulated true tree; no master/SPR relationship is imposed."
        : "Each genomic region has its own independently fitted tree. No master tree or SPR relationship is assumed between regions.",
      provenance: bundle.downstreamLikelihood.branchLengthSource === "segment-ml" ? "independently fitted regional branch lengths" : "method-supplied regional branch lengths",
    };
  }
  const model = bundle.history.kind === "spr-history" ? bundle.history.sprModel : "flattened-regional-projection";
  if (model === "rooted-switching-network") {
    return {
      eyebrow: "SPR-linked recombination input",
      title: "JEMSPR master tree + linked SPR history",
      shortTitle: "SPR-linked JEMSPR trees",
      description: "Regional trees are displays of one inferred master plus persistent SPR events. Their polished branch lengths share one linked network-edge parameterization.",
      provenance: "JEMSPR linked-ML polished branch lengths",
    };
  }
  if (model === "unrooted-edit-tape") {
    return {
      eyebrow: "SPR-derived recombination input",
      title: "Master tree + executable SPR edit history",
      shortTitle: "SPR-derived regional trees",
      description: "Regional trees are implied by a jointly inferred master and the ordered SPR edits active in each genomic interval.",
      provenance: "SPR-derived method-final regional branch lengths",
    };
  }
  return {
    eyebrow: "SPR-derived recombination input",
    title: "Regional projection of an SPR analysis",
    shortTitle: "SPR-derived regional projection",
    description: "All regional trees are retained, but this legacy saved analysis did not retain the original master/event history.",
    provenance: "saved regional-tree projection",
  };
}

function xCoordinate(site: number, sites: number): number {
  return 12 + (336 * Math.max(0, Math.min(sites, site))) / Math.max(1, sites);
}

/** Compact, dependency-free schematic. It is explanatory rather than a phylogram. */
export function RecombinationTreeMiniature({ bundle, className = "" }: {
  readonly bundle: EvoOnlineRecombinationTreeBundle;
  readonly className?: string;
}) {
  const sites = bundle.alignment.nucleotideSites;
  const regions = bundle.regionalTrees;
  const spr = bundle.representation === "spr-history";
  const shownLabels = regions.length <= 8;
  return <svg className={`recombination-miniature ${className}`} viewBox="0 0 360 64" role="img" aria-label={`${regions.length} recombination regions separated by ${bundle.breakpoints.length} breakpoints`}>
    <title>{spr ? "Master tree with SPR-derived regional displays" : "Independent regional tree partition"}</title>
    <desc>Genomic regions are shown to scale, with vertical ticks at inferred breakpoints.</desc>
    {spr && <g className="recombination-miniature__master"><path d="M14 11 H346" /><path d="M22 11 v-6 m0 3 h8 m-8 0 l-5 -3 m5 3 l-5 3" /><text x="36" y="9">master + SPR events</text></g>}
    {regions.map((region, index) => {
      const x1 = xCoordinate(region.startNucleotide - 1, sites);
      const x2 = xCoordinate(region.endNucleotide, sites);
      const center = (x1 + x2) / 2;
      const colorClass = `is-color-${index % 5}`;
      return <g key={region.id} className={`recombination-miniature__region ${colorClass}`}>
        {spr
          ? <path className="recombination-miniature__link" d={`M${Math.max(16, Math.min(344, center))} 12 Q${center + (index % 2 === 0 ? -7 : 7)} 22 ${center} 31`} />
          : <g className="recombination-miniature__tree" transform={`translate(${center} 4)`}><path d="M0 22 V11 M0 15 h-6 V8 M0 18 h6 V11 M-6 8 l-4 -4 M-6 8 l4 -4 M6 11 l-4 -4 M6 11 l4 -4" /></g>}
        <rect x={x1} y="34" width={Math.max(1.4, x2 - x1)} height="13" rx="1.5" />
        {shownLabels && x2 - x1 > 19 && <text x={center} y="43.5" textAnchor="middle">R{index + 1}</text>}
      </g>;
    })}
    {bundle.breakpoints.map((breakpoint, index) => {
      const x = xCoordinate(breakpoint.afterNucleotide, sites);
      return <g key={`${breakpoint.afterNucleotide}-${index}`} className="recombination-miniature__breakpoint"><path d={`M${x} 30 V51`} />{bundle.breakpoints.length <= 5 && <text x={x} y="60" textAnchor="middle">{breakpoint.afterNucleotide}</text>}</g>;
    })}
    <text className="recombination-miniature__axis" x="12" y="60">1</text>
    <text className="recombination-miniature__axis" x="348" y="60" textAnchor="end">{sites.toLocaleString()} nt</text>
  </svg>;
}

export function RecombinationTreeSummary({
  bundle,
  variant = "artifact",
  onPreviewRegion,
  onImportFile,
  onUseSingleTree,
}: {
  readonly bundle: EvoOnlineRecombinationTreeBundle;
  readonly variant?: "artifact" | "context";
  readonly onPreviewRegion?: (index: number) => void;
  readonly onImportFile?: (file: File) => void;
  readonly onUseSingleTree?: () => void;
}) {
  const info = recombinationModeInfo(bundle);
  const [regionIndex, setRegionIndex] = useState(0);
  const uniqueTrees = useMemo(() => new Set(bundle.regionalTrees.map((region) => region.tree)).size, [bundle.regionalTrees]);
  const download = (): void => downloadText(serializeRecombinationTreeBundle(bundle), recombinationBundleFilename(bundle), "application/json;charset=utf-8");
  const importFile = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    if (file !== undefined) onImportFile?.(file);
    event.target.value = "";
  };
  if (variant === "context") return <div className="recombination-context recombination-context--rich">
    <div className="recombination-context__copy"><span>{info.eyebrow}</span><strong>{info.title}</strong><small>{bundle.regionalTrees.length} regions · {bundle.breakpoints.length} breakpoints · {info.provenance}</small></div>
    <RecombinationTreeMiniature bundle={bundle} className="recombination-miniature--context" />
    <div className="recombination-context__actions"><button type="button" className="button button--secondary" onClick={download}>Download tree set</button>{onUseSingleTree !== undefined && <button type="button" className="button button--quiet" onClick={onUseSingleTree}>Use a single tree instead</button>}</div>
  </div>;
  return <div className="recombination-tree-summary">
    <div className="recombination-tree-summary__heading"><div><span>{info.eyebrow}</span><strong>{info.title}</strong><small>{info.description}</small></div><b>Active</b></div>
    <RecombinationTreeMiniature bundle={bundle} />
    <dl>
      <div><dt>Regions</dt><dd>{bundle.regionalTrees.length}</dd></div>
      <div><dt>Breakpoints</dt><dd>{bundle.breakpoints.length}</dd></div>
      <div><dt>Unique trees</dt><dd>{uniqueTrees}</dd></div>
    </dl>
    <div className="recombination-tree-summary__region">
      <label><span>Tree preview</span><select value={regionIndex} onChange={(event) => setRegionIndex(Number(event.target.value))}>{bundle.regionalTrees.map((region, index) => <option key={region.id} value={index}>{region.id}: nt {region.startNucleotide}–{region.endNucleotide}</option>)}</select></label>
      <button type="button" className="button button--secondary" disabled={onPreviewRegion === undefined} onClick={() => onPreviewRegion?.(regionIndex)}>View region</button>
    </div>
    <p>Codon likelihoods select a regional tree by the codon’s middle nucleotide. Global codon parameters are fitted jointly; relative regional-tree scales remain fixed.</p>
    <div className="artifact__actions">
      <button type="button" className="button button--primary" onClick={download}>Download tree set</button>
      {onImportFile !== undefined && <label className="button button--quiet">Replace tree set<input type="file" accept=".json,.evo-recomb.json" onChange={importFile} /></label>}
      {onUseSingleTree !== undefined && <button type="button" className="button button--quiet" onClick={onUseSingleTree}>Use a single tree</button>}
    </div>
  </div>;
}

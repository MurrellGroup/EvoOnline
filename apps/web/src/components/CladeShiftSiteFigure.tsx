import { useId, useMemo, useRef, useState } from "react";
import type { CladeShiftRunResult } from "../types.js";
import { downloadSvg } from "../lib/svg-export.js";
import { CommittedNumberInput } from "./CommittedNumberInput.js";

const FONT = "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
const RELAX = "#4267d5";
const INTENSIFY = "#df4652";
type Metric = "direction" | "shift" | "evidence" | "branch" | "capture";

export function CladeShiftSiteFigure({
  result,
  selectedSite,
  onSelectSite,
  posteriorThreshold,
}: {
  readonly result: CladeShiftRunResult;
  readonly selectedSite: number;
  readonly onSelectSite: (site: number) => void;
  readonly posteriorThreshold: number;
}) {
  const titleId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const [title, setTitle] = useState("Persistent selection shifts across codons");
  const [metric, setMetric] = useState<Metric>("direction");
  const [columnWidth, setColumnWidth] = useState(5);
  const [height, setHeight] = useState(430);
  const [showGuides, setShowGuides] = useState(true);
  const scalarValues = useMemo(() => result.sites.map((site) => {
    if (metric === "shift") return site.pShift;
    if (metric === "evidence") return site.logBayesFactor;
    if (metric === "branch") return site.mapBranchPosterior;
    if (metric === "capture") return site.capturedNullPosteriorMass;
    return site.pIntensification - site.pRelaxation;
  }), [metric, result.sites]);
  const range = useMemo(() => {
    if (metric === "direction") return { minimum: -1, maximum: 1 };
    if (metric === "shift" || metric === "branch" || metric === "capture") return { minimum: 0, maximum: 1 };
    const bound = Math.max(1e-6, ...scalarValues.filter(Number.isFinite).map(Math.abs));
    return { minimum: -bound, maximum: bound };
  }, [metric, scalarValues]);
  const left = 76;
  const right = 24;
  const top = 58;
  const bottom = 58;
  const plotHeight = height - top - bottom;
  const width = Math.max(920, left + right + result.sites.length * columnWidth);
  const x = (site: number): number => left + (site - 0.5) * columnWidth;
  const y = (value: number): number => top + (range.maximum - Math.max(range.minimum, Math.min(range.maximum, value))) / (range.maximum - range.minimum) * plotHeight;
  const zeroY = y(0);
  const tickStep = result.sites.length <= 100 ? 10 : result.sites.length <= 500 ? 50 : result.sites.length <= 2_000 ? 100 : 500;
  const metricLabel = {
    direction: "Posterior mass · relaxation below / intensification above",
    shift: "P(any persistent clade shift)",
    evidence: "log Bayes factor · shift versus no shift",
    branch: "Posterior of MAP initiating branch",
    capture: "Captured FUBAR null-posterior mass",
  }[metric];

  return <article className="figure-card clade-shift-site-card">
    <div className="figure-card__heading"><div><strong>{title}</strong><span>Blue is relaxation toward ω=1; red is intensification away from ω=1. Click a codon to update the tree.</span></div><button type="button" className="button button--secondary button--svg" onClick={() => svgRef.current !== null && downloadSvg(svgRef.current, title)}>Export SVG</button></div>
    <div className="tree-figure-controls global-gamma-site-controls">
      <label><span>Figure title</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label><span>Site metric</span><select value={metric} onChange={(event) => setMetric(event.target.value as Metric)}><option value="direction">Relaxation / intensification posterior</option><option value="shift">Any-shift posterior</option><option value="evidence">Shift log Bayes factor</option><option value="branch">MAP-branch posterior</option><option value="capture">Null posterior captured</option></select></label>
      <label><span>Selected codon</span><CommittedNumberInput value={selectedSite} onCommit={onSelectSite} min={1} max={result.posterior.siteCount} /></label>
      <label><span>Horizontal scale {columnWidth}px/site</span><input type="range" min="2" max="18" step="1" value={columnWidth} onChange={(event) => setColumnWidth(Number(event.target.value))} /></label>
      <label><span>Height {height}px</span><input type="range" min="300" max="760" step="20" value={height} onChange={(event) => setHeight(Number(event.target.value))} /></label>
      <label className="toggle"><input type="checkbox" checked={showGuides} onChange={(event) => setShowGuides(event.target.checked)} /><span>Axis guides</span></label>
    </div>
    <div className="figure-scroll" tabIndex={0}><svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-labelledby={titleId} style={{ display: "block", minWidth: `${width}px`, background: "#fff", fontFamily: FONT }}>
      <title id={titleId}>{title}</title>
      <text x={left} y="28" fill="#172321" fontSize="18" fontWeight="650">{title}</text>
      {showGuides && [0, 0.25, 0.5, 0.75, 1].map((fraction) => {
        const value = range.minimum + fraction * (range.maximum - range.minimum);
        const yy = y(value);
        return <g key={fraction}><line x1={left} x2={width - right} y1={yy} y2={yy} stroke={Math.abs(value) < 1e-12 ? "#7d8985" : "#e4e8e6"} strokeDasharray={Math.abs(value) < 1e-12 ? undefined : "3 4"} /><text x={left - 8} y={yy + 3} textAnchor="end" fill="#64716d" fontSize="9">{value.toPrecision(3)}</text></g>;
      })}
      {metric === "shift" && <line x1={left} x2={width - right} y1={y(posteriorThreshold)} y2={y(posteriorThreshold)} stroke="#d88916" strokeDasharray="5 4"><title>Detection threshold</title></line>}
      {result.sites.map((site) => {
        const halfWidth = Math.max(1, columnWidth * 0.38);
        const selected = site.site === selectedSite;
        if (metric === "direction") {
          const topY = y(site.pIntensification);
          const bottomY = y(-site.pRelaxation);
          return <g key={site.site} onClick={() => onSelectSite(site.site)} style={{ cursor: "pointer" }}><title>{`Codon ${site.site} · P(relax) ${site.pRelaxation.toFixed(4)} · P(intensify) ${site.pIntensification.toFixed(4)} · MAP ${site.mapBranchName}`}</title><rect x={x(site.site) - halfWidth} y={topY} width={halfWidth * 2} height={Math.max(1, zeroY - topY)} fill={INTENSIFY} opacity={selected ? 1 : 0.75} /><rect x={x(site.site) - halfWidth} y={zeroY} width={halfWidth * 2} height={Math.max(1, bottomY - zeroY)} fill={RELAX} opacity={selected ? 1 : 0.75} />{site.pShift >= posteriorThreshold && <circle cx={x(site.site)} cy={top + 5} r={Math.max(1.5, columnWidth * 0.22)} fill="#d88916" />}</g>;
        }
        const value = scalarValues[site.site - 1]!;
        const yy = y(value);
        const baseline = metric === "evidence" ? zeroY : y(0);
        const fill = metric === "evidence" ? value >= 0 ? "#d88916" : "#9ba6a2" : metric === "capture" ? "#16867a" : site.pIntensification >= site.pRelaxation ? INTENSIFY : RELAX;
        return <g key={site.site} onClick={() => onSelectSite(site.site)} style={{ cursor: "pointer" }}><title>{`Codon ${site.site} · ${metricLabel}: ${value.toPrecision(5)}`}</title><rect x={x(site.site) - halfWidth} y={Math.min(yy, baseline)} width={halfWidth * 2} height={Math.max(1, Math.abs(yy - baseline))} fill={fill} opacity={selected ? 1 : 0.75} /></g>;
      })}
      <line x1={x(selectedSite)} x2={x(selectedSite)} y1={top} y2={top + plotHeight} stroke="#162825" strokeWidth="1.5" data-transient="true" />
      {Array.from({ length: Math.floor(result.sites.length / tickStep) + 1 }, (_, index) => Math.max(1, index * tickStep)).filter((site, index, all) => index === 0 || site !== all[index - 1]).map((site) => <g key={site}><line x1={x(site)} x2={x(site)} y1={top + plotHeight} y2={top + plotHeight + 5} stroke="#52615d" /><text x={x(site)} y={top + plotHeight + 18} textAnchor="middle" fill="#52615d" fontSize="9">{site}</text></g>)}
      <line x1={left} x2={width - right} y1={top + plotHeight} y2={top + plotHeight} stroke="#23322f" />
      <text x={(left + width - right) / 2} y={height - 12} textAnchor="middle" fill="#273633" fontSize="12">Codon site</text>
      <text transform={`translate(18 ${(top + top + plotHeight) / 2}) rotate(-90)`} textAnchor="middle" fill="#273633" fontSize="12">{metricLabel}</text>
    </svg></div>
  </article>;
}

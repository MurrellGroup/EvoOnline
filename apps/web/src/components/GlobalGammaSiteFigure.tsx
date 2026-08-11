import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { GlobalGammaRunResult } from "../types.js";
import { downloadSvg } from "../lib/svg-export.js";
import { CommittedNumberInput } from "./CommittedNumberInput.js";

const FONT = "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
type Metric = "capped" | "support" | "expected" | "maximum" | "branch-tail" | "branch-local";

function metricName(metric: Metric, branchName: string | undefined): string {
  return {
    capped: "log₁₀ full / all-branches ω>1→1 null evidence ratio",
    support: "Equal-prior conditional support",
    expected: "Expected positive branches",
    maximum: "Maximum branch P(ω > 1)",
    "branch-tail": `${branchName ?? "Selected branch"}: P(ω > 1)`,
    "branch-local": `${branchName ?? "Selected branch"}: full / branch-null log evidence`,
  }[metric];
}

export function GlobalGammaSiteFigure({
  result,
  selectedSite,
  onSelectSite,
  selectedBranch,
  posteriorThreshold,
}: {
  readonly result: GlobalGammaRunResult;
  readonly selectedSite: number;
  readonly onSelectSite: (site: number) => void;
  readonly selectedBranch: number | null;
  readonly posteriorThreshold: number;
}) {
  const titleId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const [title, setTitle] = useState("Glamma evidence across codon sites");
  const [metric, setMetric] = useState<Metric>("capped");
  const [columnWidth, setColumnWidth] = useState(4);
  const [height, setHeight] = useState(420);
  const [showGuides, setShowGuides] = useState(true);
  const [rangeMode, setRangeMode] = useState<"full" | "robust">("full");
  const previousBranch = useRef(selectedBranch);
  useEffect(() => {
    if (selectedBranch !== null && previousBranch.current !== selectedBranch) setMetric("branch-tail");
    previousBranch.current = selectedBranch;
  }, [selectedBranch]);
  const branch = selectedBranch === null ? undefined : result.branches[selectedBranch - 1];
  const effectiveMetric = branch === undefined && (metric === "branch-tail" || metric === "branch-local") ? "capped" : metric;
  const values = useMemo(() => result.sites.map((site, index) => {
    if (effectiveMetric === "capped") return site.cappedLogEvidence / Math.LN10;
    if (effectiveMetric === "support") return site.conditionalSupport;
    if (effectiveMetric === "expected") return site.expectedPositiveBranches;
    if (effectiveMetric === "maximum") return site.maximumBranchPosterior;
    const matrixIndex = ((selectedBranch ?? 1) - 1) * result.posterior.siteCount + index;
    return effectiveMetric === "branch-tail" ? result.posterior.tailPosterior[matrixIndex]! : result.posterior.localLogEvidence[matrixIndex]!;
  }), [effectiveMetric, result, selectedBranch]);
  const diverging = effectiveMetric === "capped" || effectiveMetric === "branch-local";
  const range = useMemo(() => {
    const finite = values.filter(Number.isFinite);
    if (diverging) {
      const absolute = finite.map(Math.abs).sort((a, b) => a - b);
      const selected = rangeMode === "robust"
        ? absolute[Math.min(absolute.length - 1, Math.max(0, Math.ceil(absolute.length * 0.98) - 1))]
        : absolute.at(-1);
      const bound = Math.max(1e-6, selected ?? 1);
      return { minimum: -bound, maximum: bound };
    }
    const sorted = finite.slice().sort((a, b) => a - b);
    const maximum = effectiveMetric === "support" || effectiveMetric === "maximum" || effectiveMetric === "branch-tail"
      ? 1
      : Math.max(1e-6, (rangeMode === "robust"
        ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.98) - 1))]
        : sorted.at(-1)) ?? 1);
    return { minimum: 0, maximum };
  }, [diverging, effectiveMetric, rangeMode, values]);
  const left = 74;
  const right = 24;
  const top = 54;
  const bottom = 58;
  const plotHeight = height - top - bottom;
  const width = Math.max(900, left + right + result.sites.length * columnWidth);
  const x = (site: number): number => left + (site - 0.5) * columnWidth;
  const y = (value: number): number => top + (range.maximum - Math.max(range.minimum, Math.min(range.maximum, value))) / (range.maximum - range.minimum) * plotHeight;
  const zeroY = y(0);
  const tickStep = result.sites.length <= 100 ? 10 : result.sites.length <= 500 ? 50 : result.sites.length <= 2_000 ? 100 : 500;
  const probabilityMetric = effectiveMetric === "support" || effectiveMetric === "maximum" || effectiveMetric === "branch-tail";
  const label = metricName(effectiveMetric, branch?.name);
  const clippedCount = values.reduce((count, value) => count + (value < range.minimum || value > range.maximum ? 1 : 0), 0);

  return <article className="figure-card global-gamma-site-card">
    <div className="figure-card__heading"><div><strong>{title}</strong><span>Click a codon to recolor the phylogeny; select a branch on the tree to expose its local track.</span></div><button type="button" className="button button--secondary button--svg" onClick={() => svgRef.current !== null && downloadSvg(svgRef.current, title)}>Export SVG</button></div>
    <div className="tree-figure-controls global-gamma-site-controls">
      <label><span>Figure title</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label><span>Site metric</span><select value={metric} onChange={(event) => setMetric(event.target.value as Metric)}>
        <option value="capped">Full vs all-branches-null evidence</option><option value="support">Equal-prior conditional support</option>
        <option value="expected">Expected positive branches</option><option value="maximum">Maximum branch tail posterior</option>
        <option value="branch-tail" disabled={branch === undefined}>Selected-branch tail posterior</option><option value="branch-local" disabled={branch === undefined}>Selected-branch local evidence</option>
      </select></label>
      <label><span>Selected codon</span><CommittedNumberInput value={selectedSite} onCommit={onSelectSite} min={1} max={result.posterior.siteCount} /></label>
      <label><span>Horizontal scale {columnWidth}px/site</span><input type="range" min="2" max="18" step="1" value={columnWidth} onChange={(event) => setColumnWidth(Number(event.target.value))} /></label>
      <label><span>Height {height}px</span><input type="range" min="280" max="720" step="20" value={height} onChange={(event) => setHeight(Number(event.target.value))} /></label>
      <label><span>Y-axis range</span><select value={rangeMode} disabled={probabilityMetric} onChange={(event) => setRangeMode(event.target.value as "full" | "robust")}><option value="full">Full data range</option><option value="robust">Robust 98% · mark clips</option></select></label>
      <label className="toggle"><input type="checkbox" checked={showGuides} onChange={(event) => setShowGuides(event.target.checked)} /><span>Axis guides</span></label>
    </div>
    <div className="figure-scroll" tabIndex={0}><svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-labelledby={titleId} style={{ display: "block", minWidth: `${width}px`, background: "#fff", fontFamily: FONT }}>
      <title id={titleId}>{title}</title>
      <text x={left} y="27" fill="#172321" fontSize="18" fontWeight="650">{title}</text>
      {showGuides && [0, 0.25, 0.5, 0.75, 1].map((fraction) => {
        const value = range.minimum + fraction * (range.maximum - range.minimum);
        const yy = y(value);
        return <g key={fraction}><line x1={left} x2={width - right} y1={yy} y2={yy} stroke={Math.abs(value) < 1e-12 ? "#7e8b87" : "#e4e8e6"} strokeDasharray={Math.abs(value) < 1e-12 ? undefined : "3 4"} /><text x={left - 8} y={yy + 3} textAnchor="end" fill="#64716d" fontSize="9">{value.toPrecision(3)}</text></g>;
      })}
      {probabilityMetric && <line x1={left} x2={width - right} y1={y(posteriorThreshold)} y2={y(posteriorThreshold)} stroke="#d88916" strokeWidth="1" strokeDasharray="5 4" />}
      {values.map((value, index) => {
        const site = index + 1;
        const yy = y(value);
        const positive = diverging ? value >= 0 : probabilityMetric ? value >= posteriorThreshold : true;
        const fill = positive ? "#e64b50" : diverging ? "#4a63d8" : "#8a9793";
        const barY = diverging ? Math.min(yy, zeroY) : yy;
        const barHeight = diverging ? Math.max(1, Math.abs(yy - zeroY)) : Math.max(1, top + plotHeight - yy);
        const clippedHigh = value > range.maximum;
        const clippedLow = value < range.minimum;
        const halfMarker = Math.max(2, columnWidth * 0.48);
        return <g key={site} onClick={() => onSelectSite(site)} style={{ cursor: "pointer" }}>
          <title>{`Codon ${site} · ${label}: ${value.toPrecision(5)}${clippedHigh || clippedLow ? " · outside robust display range" : ""}`}</title>
          <rect x={x(site) - Math.max(1, columnWidth * 0.38)} y={barY} width={Math.max(1, columnWidth * 0.76)} height={barHeight} fill={fill} opacity={site === selectedSite ? 1 : 0.72} />
          {clippedHigh && <path d={`M ${x(site) - halfMarker} ${top + 5} L ${x(site)} ${top} L ${x(site) + halfMarker} ${top + 5} Z`} fill="#7b1720" />}
          {clippedLow && <path d={`M ${x(site) - halfMarker} ${top + plotHeight - 5} L ${x(site)} ${top + plotHeight} L ${x(site) + halfMarker} ${top + plotHeight - 5} Z`} fill="#183c91" />}
        </g>;
      })}
      <line x1={x(selectedSite)} x2={x(selectedSite)} y1={top} y2={top + plotHeight} stroke="#162825" strokeWidth="1.5" data-transient="true" />
      {Array.from({ length: Math.floor(result.sites.length / tickStep) + 1 }, (_, index) => Math.max(1, index * tickStep)).filter((site, index, all) => index === 0 || site !== all[index - 1]).map((site) => <g key={site}><line x1={x(site)} x2={x(site)} y1={top + plotHeight} y2={top + plotHeight + 5} stroke="#52615d" /><text x={x(site)} y={top + plotHeight + 18} textAnchor="middle" fill="#52615d" fontSize="9">{site}</text></g>)}
      <line x1={left} x2={width - right} y1={top + plotHeight} y2={top + plotHeight} stroke="#23322f" />
      <text x={(left + width - right) / 2} y={height - 12} textAnchor="middle" fill="#273633" fontSize="12">Codon site</text>
      <text transform={`translate(18 ${(top + top + plotHeight) / 2}) rotate(-90)`} textAnchor="middle" fill="#273633" fontSize="12">{label}</text>
      {rangeMode === "robust" && clippedCount > 0 && <text x={width - right} y="27" textAnchor="end" fill="#7b1720" fontSize="9">{clippedCount} value{clippedCount === 1 ? "" : "s"} outside robust range · triangles retain direction</text>}
    </svg></div>
  </article>;
}

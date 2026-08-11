import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { regularizedGammaP } from "@phylo-workbench/model-bame/browser-source";
import type { BameRunResult, FameRunResult, FlavorRunResult } from "../types.js";
import { downloadSvg } from "../lib/svg-export.js";
import { CommittedNumberInput } from "./CommittedNumberInput.js";

const RED = "#ed5158";
const BLUE = "#5148e5";
const GREEN = "#56aa61";
const PURPLE = "#8b48ca";
const GOLD = "#d9991d";
const INK = "#172321";
const FONT = "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";

type FigureKey = "overview" | "marginals" | "surface" | "omega-cdf";
type BameSite = BameRunResult["sites"][number];

interface BameLabels {
  readonly overviewTitle: string;
  readonly overviewXAxis: string;
  readonly overviewYAxis: string;
  readonly marginalsTitle: string;
  readonly marginalsXAxis: string;
  readonly marginalsYAxis: string;
  readonly surfaceTitle: string;
  readonly surfaceXAxis: string;
  readonly surfaceYAxis: string;
  readonly cdfTitle: string;
}

const DEFAULT_LABELS: BameLabels = {
  overviewTitle: "Episodic-selection posterior by codon",
  overviewXAxis: "Codon sites",
  overviewYAxis: "Posterior probability",
  marginalsTitle: "Parameter posteriors at detected sites",
  marginalsXAxis: "Parameter value",
  marginalsYAxis: "Codon sites",
  surfaceTitle: "Site posterior projection",
  surfaceXAxis: "ω₁",
  surfaceYAxis: "ω₂",
  cdfTitle: "Posterior branch-ω distribution",
};

function svgStyle(): CSSProperties {
  return { display: "block", width: "100%", height: "auto", background: "#fff", fontFamily: FONT };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function gridLabel(value: number): string {
  if (value < 0.001 || value >= 100) return value.toExponential(2);
  return Number(value.toPrecision(3)).toString();
}

function FigureShell({ title, description, svgRef, tall = false, children }: {
  readonly title: string;
  readonly description: string;
  readonly svgRef: RefObject<SVGSVGElement | null>;
  readonly tall?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <article className="figure-card">
      <div className="figure-card__heading">
        <div><strong>{title}</strong><span>{description}</span></div>
        <button type="button" className="button button--secondary button--svg" onClick={() => svgRef.current !== null && downloadSvg(svgRef.current, title)}>Export SVG</button>
      </div>
      <div className={`figure-scroll ${tall ? "figure-scroll--tall" : ""}`}>{children}</div>
    </article>
  );
}

function EvidenceOverview({ sites, threshold, selectedSite, onSelectSite, labels, svgRef }: {
  readonly sites: readonly BameSite[];
  readonly threshold: number;
  readonly selectedSite: number;
  readonly onSelectSite: (site: number) => void;
  readonly labels: BameLabels;
  readonly svgRef: RefObject<SVGSVGElement | null>;
}) {
  const titleId = useId();
  const width = 1_180;
  const height = 420;
  const left = 76;
  const top = 64;
  const bottom = 60;
  const plotWidth = width - left - 26;
  const plotHeight = height - top - bottom;
  const x = (site: number): number => left + (site - 1) / Math.max(1, sites.length - 1) * plotWidth;
  const y = (probability: number): number => top + (1 - probability) * plotHeight;
  const tickStep = Math.max(1, Math.ceil(sites.length / 10));
  return (
    <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={titleId} style={svgStyle()} data-figure="bame-evidence-overview">
      <title id={titleId}>{labels.overviewTitle}</title>
      <text x={left} y="28" fill={INK} fontSize="22" fontWeight="650">{labels.overviewTitle}</text>
      {[0, 0.25, 0.5, 0.75, 1].map((tick) => <g key={tick}><line x1={left} x2={left + plotWidth} y1={y(tick)} y2={y(tick)} stroke="#e4e9e7" /><text x={left - 10} y={y(tick) + 4} textAnchor="end" fill={INK} fontSize="11">{tick.toFixed(2)}</text></g>)}
      <line x1={left} x2={left + plotWidth} y1={y(threshold)} y2={y(threshold)} stroke={RED} strokeDasharray="7 5" strokeWidth="1.5" />
      <text x={left + plotWidth - 4} y={y(threshold) - 7} textAnchor="end" fill={RED} fontSize="11">threshold {threshold.toFixed(3)}</text>
      {sites.filter((_site, index) => index % tickStep === 0 || index === sites.length - 1).map((site) => <text key={site.site} x={x(site.site)} y={top + plotHeight + 21} textAnchor="middle" fill={INK} fontSize="10">{site.site}</text>)}
      {sites.map((site) => {
        const detected = site.pPositive > threshold;
        return <circle key={site.site} cx={x(site.site)} cy={y(site.pPositive)} r={site.site === selectedSite ? 5.5 : detected ? 4 : 2.7} fill={detected ? RED : "#9aa5a2"} opacity={detected ? 0.9 : 0.35} stroke={site.site === selectedSite ? INK : "none"} strokeWidth="1.5" onClick={() => onSelectSite(site.site)} style={{ cursor: "pointer" }}><title>{`Codon ${site.site}: posterior ${site.pPositive.toFixed(5)}, empirical BF ${Number.isFinite(site.bayesFactor) ? site.bayesFactor.toPrecision(4) : "∞"}`}</title></circle>;
      })}
      <line x1={left} x2={left} y1={top} y2={top + plotHeight} stroke={INK} />
      <line x1={left} x2={left + plotWidth} y1={top + plotHeight} y2={top + plotHeight} stroke={INK} />
      <text x={left + plotWidth / 2} y={height - 13} textAnchor="middle" fill={INK} fontSize="17">{labels.overviewXAxis}</text>
      <text x="22" y={top + plotHeight / 2} textAnchor="middle" fill={INK} fontSize="18" transform={`rotate(-90 22 ${top + plotHeight / 2})`}>{labels.overviewYAxis}</text>
    </svg>
  );
}

interface MarginalSeries {
  readonly label: string;
  readonly color: string;
  readonly values: Float64Array;
  readonly masses: Float32Array;
}

function marginalSeries(result: BameRunResult): readonly MarginalSeries[] {
  return result.method === "fame" ? [
    { label: "α", color: GREEN, values: result.posterior.alphaValues, masses: result.posterior.alpha },
    { label: "ω₁", color: BLUE, values: result.posterior.omega1Values, masses: result.posterior.omega1 },
    { label: "ω₂", color: RED, values: result.posterior.omega2Values, masses: result.posterior.omega2 },
  ] : [
    { label: "α", color: GREEN, values: result.posterior.alphaValues, masses: result.posterior.alpha },
    { label: "mean(ω)", color: RED, values: result.posterior.muValues, masses: result.posterior.mu },
    { label: "shape", color: PURPLE, values: result.posterior.shapeValues, masses: result.posterior.shape },
  ];
}

function ParameterMarginals({ result, sites, selectedSite, onSelectSite, labels, svgRef }: {
  readonly result: BameRunResult;
  readonly sites: readonly BameSite[];
  readonly selectedSite: number;
  readonly onSelectSite: (site: number) => void;
  readonly labels: BameLabels;
  readonly svgRef: RefObject<SVGSVGElement | null>;
}) {
  const titleId = useId();
  const series = marginalSeries(result);
  const width = 620;
  const left = 105;
  const top = 84;
  const bottom = 86;
  const rowGap = 48;
  const plotWidth = width - left - 28;
  const plotHeight = Math.max(rowGap, sites.length * rowGap);
  const height = top + plotHeight + bottom;
  const allValues = series.flatMap((item) => Array.from(item.values));
  const minimumCoordinate = Math.min(...allValues.map((value) => Math.log10(value + 0.05)));
  const maximumCoordinate = Math.max(...allValues.map((value) => Math.log10(value + 0.05)));
  const x = (value: number): number => left + (Math.log10(value + 0.05) - minimumCoordinate) / Math.max(1e-12, maximumCoordinate - minimumCoordinate) * plotWidth;
  const y = (row: number): number => top + row * rowGap + rowGap / 2;
  const laneGap = 13;
  return (
    <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={titleId} style={{ ...svgStyle(), width: `${width}px`, minWidth: `${width}px`, margin: "0 auto" }} data-figure="bame-parameter-marginals">
      <title id={titleId}>{labels.marginalsTitle}</title>
      <text x={left} y="25" fill={INK} fontSize="18" fontWeight="650">{labels.marginalsTitle}</text>
      <g transform={`translate(${left + 100} 52)`} fill={INK} fontSize="11">{series.map((item, index) => <g key={item.label} transform={`translate(${index * 108} 0)`}><rect x="0" y="-9" width="20" height="9" fill={item.color} opacity="0.82" /><text x="27" y="0">{item.label}</text></g>)}</g>
      {sites.map((site, row) => <g key={site.site} onClick={() => onSelectSite(site.site)} style={{ cursor: "pointer" }}>
        {site.site === selectedSite && <rect x={left - 55} y={top + row * rowGap} width={plotWidth + 60} height={rowGap} fill="#eaf4f0" />}
        <text x={left - 14} y={y(row) + 4} textAnchor="end" fill={site.site === selectedSite ? "#0d5e57" : INK} fontSize="13" fontWeight="700">{site.site}</text>
        {series.map((item, lane) => Array.from(item.values).map((value, bin) => {
          const mass = item.masses[(site.site - 1) * item.values.length + bin] ?? 0;
          const thickness = Math.max(1, mass * rowGap * 0.72);
          const baseline = y(row) + (lane - 1) * laneGap;
          return <rect key={`${lane}-${bin}`} x={x(value) - 6.5} y={baseline - thickness / 2} width="13" height={thickness} fill={item.color} opacity="0.82" shapeRendering="crispEdges"><title>{`${item.label} ${gridLabel(value)}: posterior ${mass.toFixed(6)}`}</title></rect>;
        }))}
      </g>)}
      <line x1={left} x2={left} y1={top} y2={top + plotHeight} stroke={INK} />
      <line x1={left} x2={left + plotWidth} y1={top + plotHeight} y2={top + plotHeight} stroke={INK} />
      {[0.01, 0.05, 0.2, 0.6, 1, 2, 5, 10, 20].filter((value) => Math.log10(value + 0.05) <= maximumCoordinate + 1e-9).map((value) => <text key={value} x={x(value)} y={top + plotHeight + 17} textAnchor="end" fill={INK} fontSize="9" transform={`rotate(-90 ${x(value)} ${top + plotHeight + 17})`}>{gridLabel(value)}</text>)}
      <text x={left + plotWidth / 2} y={height - 13} textAnchor="middle" fill={INK} fontSize="18">{labels.marginalsXAxis}</text>
      <text x="22" y={top + plotHeight / 2} textAnchor="middle" fill={INK} fontSize="18" transform={`rotate(-90 22 ${top + plotHeight / 2})`}>{labels.marginalsYAxis}</text>
    </svg>
  );
}

const HEAT = ["#10077e", "#5126c8", "#1a79b8", "#159b72", "#d5b300", "#ff7600", "#c20f0f"] as const;
function heatColor(value: number): string {
  const scaled = clamp(value, 0, 1) * (HEAT.length - 1);
  return HEAT[Math.min(HEAT.length - 1, Math.round(scaled))]!;
}

function projectedSurface(result: BameRunResult, site: number, capView: "all" | "uncapped" | "capped") {
  if (result.method === "fame") {
    const xValues = result.posterior.omega1Values;
    const yValues = result.posterior.omega2Values;
    const values = new Float64Array(xValues.length * yValues.length);
    const source = (site - 1) * result.posterior.surfaces.length / result.posterior.siteCount;
    for (let a = 0; a < result.posterior.alphaValues.length; a += 1) for (let x = 0; x < xValues.length; x += 1) for (let y = 0; y < yValues.length; y += 1) {
      const category = (a * xValues.length + x) * yValues.length + y;
      const target = x * yValues.length + y;
      values[target] = values[target]! + (result.posterior.surfaces[source + category] ?? 0);
    }
    return { xValues, yValues, values, xLabel: "ω₁", yLabel: "ω₂" };
  }
  const xValues = result.posterior.muValues;
  const yValues = result.posterior.shapeValues;
  const values = new Float64Array(xValues.length * yValues.length);
  const categoriesPerSite = result.posterior.surfaces.length / result.posterior.siteCount;
  const source = (site - 1) * categoriesPerSite;
  for (let cap = 0; cap < 2; cap += 1) {
    if ((capView === "uncapped" && cap === 1) || (capView === "capped" && cap === 0)) continue;
    for (let x = 0; x < xValues.length; x += 1) for (let y = 0; y < yValues.length; y += 1) for (let a = 0; a < result.posterior.alphaValues.length; a += 1) {
      const category = ((cap * xValues.length + x) * yValues.length + y) * result.posterior.alphaValues.length + a;
      const target = x * yValues.length + y;
      values[target] = values[target]! + (result.posterior.surfaces[source + category] ?? 0);
    }
  }
  return { xValues, yValues, values, xLabel: "mean(ω)", yLabel: "Gamma shape" };
}

function PosteriorProjection({ result, site, capView, labels, svgRef }: {
  readonly result: BameRunResult;
  readonly site: BameSite;
  readonly capView: "all" | "uncapped" | "capped";
  readonly labels: BameLabels;
  readonly svgRef: RefObject<SVGSVGElement | null>;
}) {
  const titleId = useId();
  const projection = useMemo(() => projectedSurface(result, site.site, capView), [capView, result, site.site]);
  const width = 720;
  const height = 680;
  const left = 112;
  const top = 68;
  const plotSize = 500;
  const cellX = plotSize / projection.xValues.length;
  const cellY = plotSize / projection.yValues.length;
  const maximum = Math.max(0, ...projection.values);
  const title = `${labels.surfaceTitle} · codon ${site.site}`;
  return <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={titleId} style={{ ...svgStyle(), minWidth: "620px" }} data-figure="bame-posterior-surface">
    <title id={titleId}>{title}</title><text x={left} y="28" fill={INK} fontSize="21" fontWeight="650">{title}</text>
    <text x={left} y="49" fill={RED} fontSize="11">positive posterior {site.pPositive.toFixed(4)} · empirical BF {Number.isFinite(site.bayesFactor) ? site.bayesFactor.toPrecision(4) : "∞"}</text>
    {Array.from({ length: projection.xValues.length }, (_unused, x) => Array.from({ length: projection.yValues.length }, (_inner, y) => {
      const mass = projection.values[x * projection.yValues.length + y]!;
      return <rect key={`${x}-${y}`} x={left + x * cellX} y={top + (projection.yValues.length - 1 - y) * cellY} width={cellX + 0.2} height={cellY + 0.2} fill={heatColor(maximum > 0 ? mass / maximum : 0)} shapeRendering="crispEdges"><title>{`${projection.xLabel}=${gridLabel(projection.xValues[x]!)}, ${projection.yLabel}=${gridLabel(projection.yValues[y]!)}, posterior=${mass.toFixed(6)}`}</title></rect>;
    }))}
    <line x1={left} x2={left} y1={top} y2={top + plotSize} stroke={INK} /><line x1={left} x2={left + plotSize} y1={top + plotSize} y2={top + plotSize} stroke={INK} />
    {Array.from(projection.xValues).map((value, index) => <text key={`x-${index}`} x={left + (index + 0.5) * cellX} y={top + plotSize + 18} textAnchor="end" fill={INK} fontSize="9" transform={`rotate(-90 ${left + (index + 0.5) * cellX} ${top + plotSize + 18})`}>{gridLabel(value)}</text>)}
    {Array.from(projection.yValues).map((value, index) => <text key={`y-${index}`} x={left - 8} y={top + (projection.yValues.length - index - 0.5) * cellY + 3} textAnchor="end" fill={INK} fontSize="9">{gridLabel(value)}</text>)}
    <text x={left + plotSize / 2} y={height - 17} textAnchor="middle" fill={INK} fontSize="18">{labels.surfaceXAxis || projection.xLabel}</text>
    <text x="27" y={top + plotSize / 2} textAnchor="middle" fill={INK} fontSize="18" transform={`rotate(-90 27 ${top + plotSize / 2})`}>{labels.surfaceYAxis || projection.yLabel}</text>
  </svg>;
}

function FlavorOmegaCdf({ result, site, labels, svgRef }: { readonly result: FlavorRunResult; readonly site: BameSite; readonly labels: BameLabels; readonly svgRef: RefObject<SVGSVGElement | null> }) {
  const titleId = useId();
  const width = 900;
  const height = 470;
  const left = 80;
  const top = 60;
  const plotWidth = 760;
  const plotHeight = 330;
  const xMinimum = 0.001;
  const xMaximum = 100;
  const xs = Array.from({ length: 180 }, (_unused, index) => 10 ** (Math.log10(xMinimum) + index / 179 * (Math.log10(xMaximum) - Math.log10(xMinimum))));
  const categoriesPerSite = result.posterior.surfaces.length / result.posterior.siteCount;
  const surfaceOffset = (site.site - 1) * categoriesPerSite;
  const cdf = xs.map((x) => {
    let total = 0;
    for (let cap = 0; cap < 2; cap += 1) for (let mu = 0; mu < result.posterior.muValues.length; mu += 1) for (let shape = 0; shape < result.posterior.shapeValues.length; shape += 1) for (let alpha = 0; alpha < result.posterior.alphaValues.length; alpha += 1) {
      const category = ((cap * result.posterior.muValues.length + mu) * result.posterior.shapeValues.length + shape) * result.posterior.alphaValues.length + alpha;
      const mass = result.posterior.surfaces[surfaceOffset + category] ?? 0;
      if (mass === 0) continue;
      const gammaCdf = regularizedGammaP(result.posterior.shapeValues[shape]!, x * result.posterior.shapeValues[shape]! / result.posterior.muValues[mu]!);
      total += mass * (cap === 1 && x >= 1 ? 1 : gammaCdf);
    }
    return total;
  });
  const x = (value: number): number => left + (Math.log10(value) - Math.log10(xMinimum)) / (Math.log10(xMaximum) - Math.log10(xMinimum)) * plotWidth;
  const y = (value: number): number => top + (1 - value) * plotHeight;
  const path = cdf.map((value, index) => `${index === 0 ? "M" : "L"}${x(xs[index]!).toFixed(2)},${y(value).toFixed(2)}`).join(" ");
  return <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={titleId} style={svgStyle()} data-figure="flavor-omega-cdf">
    <title id={titleId}>{labels.cdfTitle}</title><text x={left} y="28" fill={INK} fontSize="21" fontWeight="650">{labels.cdfTitle} · codon {site.site}</text>
    {[0, 0.25, 0.5, 0.75, 1].map((tick) => <g key={tick}><line x1={left} x2={left + plotWidth} y1={y(tick)} y2={y(tick)} stroke="#e4e9e7" /><text x={left - 10} y={y(tick) + 4} textAnchor="end" fill={INK} fontSize="10">{tick}</text></g>)}
    {[0.001, 0.01, 0.1, 1, 10, 100].map((tick) => <text key={tick} x={x(tick)} y={top + plotHeight + 20} textAnchor="middle" fill={INK} fontSize="10">{tick}</text>)}
    <line x1={x(1)} x2={x(1)} y1={top} y2={top + plotHeight} stroke={GOLD} strokeDasharray="6 4" /><text x={x(1) + 6} y={top + 16} fill={GOLD} fontSize="11">ω=1 cap / selection boundary</text>
    <path d={path} fill="none" stroke={RED} strokeWidth="3" />
    <line x1={left} x2={left} y1={top} y2={top + plotHeight} stroke={INK} /><line x1={left} x2={left + plotWidth} y1={top + plotHeight} y2={top + plotHeight} stroke={INK} />
    <text x={left + plotWidth / 2} y={height - 15} textAnchor="middle" fill={INK} fontSize="17">Branch ω (log scale)</text><text x="22" y={top + plotHeight / 2} textAnchor="middle" fill={INK} fontSize="17" transform={`rotate(-90 22 ${top + plotHeight / 2})`}>Posterior predictive CDF</text>
  </svg>;
}

function LabelEditor({ labels, onChange }: { readonly labels: BameLabels; readonly onChange: (labels: BameLabels) => void }) {
  return <details className="figure-label-editor"><summary>Edit figure labels</summary><div className="figure-label-grid">{(Object.keys(labels) as Array<keyof BameLabels>).map((field) => <label key={field}><span>{field.replaceAll(/([A-Z])/g, " $1")}</span><input value={labels[field]} onChange={(event) => onChange({ ...labels, [field]: event.target.value })} /></label>)}</div><button type="button" className="button button--quiet" onClick={() => onChange(DEFAULT_LABELS)}>Reset labels</button></details>;
}

export function BameVisualizations({ result, threshold, onThresholdChange }: { readonly result: BameRunResult; readonly threshold: number; readonly onThresholdChange: (value: number) => void }) {
  const detected = useMemo(() => result.sites.filter((site) => site.pPositive > threshold), [result.sites, threshold]);
  const [activeFigure, setActiveFigure] = useState<FigureKey>("overview");
  const [selectedSite, setSelectedSite] = useState(result.detectedSites[0] ?? 1);
  const [rowLimit, setRowLimit] = useState(100);
  const [capView, setCapView] = useState<"all" | "uncapped" | "capped">("all");
  const [labels, setLabels] = useState<BameLabels>(() => result.method === "flavor" ? { ...DEFAULT_LABELS, surfaceXAxis: "Gamma mean(ω)", surfaceYAxis: "Gamma shape" } : DEFAULT_LABELS);
  const overviewRef = useRef<SVGSVGElement>(null);
  const marginalsRef = useRef<SVGSVGElement>(null);
  const surfaceRef = useRef<SVGSVGElement>(null);
  const cdfRef = useRef<SVGSVGElement>(null);
  const selected = result.sites[clamp(selectedSite - 1, 0, result.sites.length - 1)]!;
  const rows = detected.slice(0, rowLimit);
  useEffect(() => { if (detected.length > 0 && !detected.some((site) => site.site === selectedSite)) setSelectedSite(detected[0]!.site); }, [detected, selectedSite]);
  return <section className="figure-studio" aria-labelledby="bame-figure-heading">
    <div className="figure-studio__heading"><div><p className="eyebrow">Interactive figures</p><h3 id="bame-figure-heading">{result.method.toUpperCase()} figure studio</h3><p>Linked codons, editable labels, posterior projections, and native SVG export.</p></div><div className="figure-selection"><span>Selected codon</span><strong>{selected.site}</strong></div></div>
    <div className="figure-controls">
      <label className="figure-control figure-control--threshold"><span>Posterior threshold <strong>{threshold.toFixed(3)}</strong></span><input type="range" min="0.5" max="0.999" step="0.001" value={threshold} onChange={(event) => onThresholdChange(Number(event.target.value))} /></label>
      <label className="figure-control"><span>Selected codon</span><CommittedNumberInput min={1} max={result.sites.length} value={selected.site} onCommit={setSelectedSite} /></label>
      <label className="figure-control"><span>Maximum rows</span><select value={rowLimit} onChange={(event) => setRowLimit(Number(event.target.value))}>{[25, 50, 100, 250, 500].map((value) => <option key={value}>{value}</option>)}</select></label>
      {result.method === "flavor" && <label className="figure-control"><span>Surface categories</span><select value={capView} onChange={(event) => setCapView(event.target.value as typeof capView)}><option value="all">All</option><option value="uncapped">Uncapped only</option><option value="capped">Capped only</option></select></label>}
    </div>
    <LabelEditor labels={labels} onChange={setLabels} />
    <div className="figure-tabs" role="tablist" aria-label={`${result.method.toUpperCase()} figures`}>
      <button type="button" role="tab" aria-selected={activeFigure === "overview"} className={activeFigure === "overview" ? "is-active" : ""} onClick={() => setActiveFigure("overview")}>Selection posterior</button>
      <button type="button" role="tab" aria-selected={activeFigure === "marginals"} className={activeFigure === "marginals" ? "is-active" : ""} onClick={() => setActiveFigure("marginals")}>Parameter posteriors</button>
      <button type="button" role="tab" aria-selected={activeFigure === "surface"} className={activeFigure === "surface" ? "is-active" : ""} onClick={() => setActiveFigure("surface")}>Posterior projection</button>
      {result.method === "flavor" && <button type="button" role="tab" aria-selected={activeFigure === "omega-cdf"} className={activeFigure === "omega-cdf" ? "is-active" : ""} onClick={() => setActiveFigure("omega-cdf")}>Branch-ω CDF</button>}
    </div>
    {activeFigure === "overview" && <FigureShell title={labels.overviewTitle} description="Site posterior for an uncapped positive-selection component; point details include empirical Bayes factors." svgRef={overviewRef}><EvidenceOverview sites={result.sites} threshold={threshold} selectedSite={selected.site} onSelectSite={setSelectedSite} labels={labels} svgRef={overviewRef} /></FigureShell>}
    {activeFigure === "marginals" && (rows.length === 0 ? <div className="figure-empty"><strong>No sites exceed this threshold.</strong><span>Lower the threshold to reveal parameter probability-mass lanes.</span></div> : <FigureShell title={labels.marginalsTitle} description="Rectangle thickness is proportional to site posterior mass at that parameter value." svgRef={marginalsRef} tall><ParameterMarginals result={result} sites={rows} selectedSite={selected.site} onSelectSite={setSelectedSite} labels={labels} svgRef={marginalsRef} /></FigureShell>)}
    {activeFigure === "surface" && <FigureShell title={`${labels.surfaceTitle} · codon ${selected.site}`} description={result.method === "fame" ? "ω₁×ω₂ posterior, marginalized over α." : `${capView} Gamma mean×shape posterior, marginalized over α.`} svgRef={surfaceRef}><PosteriorProjection result={result} site={selected} capView={capView} labels={labels} svgRef={surfaceRef} /></FigureShell>}
    {activeFigure === "omega-cdf" && result.method === "flavor" && <FigureShell title={`${labels.cdfTitle} · codon ${selected.site}`} description="Posterior predictive branch-ω CDF; capped mass above one is placed at ω=1." svgRef={cdfRef}><FlavorOmegaCdf result={result} site={selected} labels={labels} svgRef={cdfRef} /></FigureShell>}
    <p className="figure-note">Click a codon to link all views. These are posterior probability masses, not decorative bars; SVG exports retain edited labels.</p>
  </section>;
}

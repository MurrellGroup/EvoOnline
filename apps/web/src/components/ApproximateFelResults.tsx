import React, { useId, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import {
  ExactBicubicLogLikelihoodSpline,
  approximateFelResultsToCsv,
  type ApproximateFelProducts,
  type ApproximateFelSiteResult,
} from "@phylo-workbench/model-fubar/browser-source";
import { downloadSvg } from "../lib/svg-export.js";

const RED = "#ff4b4f";
const BLUE = "#4f46f5";
const TEAL = "#0d756a";
const INK = "#172321";
const FONT = "DejaVu Sans, Arial, Helvetica, sans-serif";

interface FelFigureLabels {
  readonly title: string;
  readonly xAxis: string;
  readonly yAxis: string;
  readonly color: string;
  readonly alternative: string;
  readonly null: string;
  readonly connector: string;
}

const DEFAULT_LABELS: FelFigureLabels = {
  title: "Conditional likelihood surface",
  xAxis: "α",
  yAxis: "β",
  color: "Relative log likelihood",
  alternative: "Unconstrained optimum",
  null: "α = β optimum",
  connector: "FEL likelihood-ratio comparison",
};

const HEAT_STOPS: readonly [number, readonly [number, number, number]][] = [
  [0, [17, 12, 126]], [0.18, [68, 28, 205]], [0.36, [28, 105, 183]],
  [0.54, [7, 151, 98]], [0.72, [171, 190, 7]], [0.87, [255, 132, 0]], [1, [196, 15, 0]],
];

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function heatColor(value: number): string {
  const bounded = clamp(value, 0, 1);
  let lower = HEAT_STOPS[0]!;
  let upper = HEAT_STOPS.at(-1)!;
  for (let position = 1; position < HEAT_STOPS.length; position += 1) {
    if (bounded <= HEAT_STOPS[position]![0]) {
      lower = HEAT_STOPS[position - 1]!;
      upper = HEAT_STOPS[position]!;
      break;
    }
  }
  const fraction = (bounded - lower[0]) / Math.max(1e-12, upper[0] - lower[0]);
  const channel = (position: number): number => Math.round(lower[1][position]! + fraction * (upper[1][position]! - lower[1][position]!));
  return `rgb(${channel(0)},${channel(1)},${channel(2)})`;
}

function svgStyle(): CSSProperties {
  return { display: "block", width: "100%", height: "auto", background: "#fff", fontFamily: FONT };
}

function rateLabel(value: number): string {
  if (value >= 10) return Number(value.toPrecision(4)).toString();
  return Number(value.toPrecision(3)).toString();
}

function pLabel(value: number): string {
  if (value < 0.0001) return value.toExponential(2);
  return value.toFixed(value < 0.01 ? 4 : 3);
}

function downloadCsv(result: ApproximateFelProducts, threshold: number): void {
  const csv = approximateFelResultsToCsv(result, threshold);
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "approximate-fel-results.csv";
  anchor.click();
  URL.revokeObjectURL(url);
}

export function approximateFelCall(site: ApproximateFelSiteResult, threshold: number): "positive" | "purifying" | "none" {
  if (site.pPositive < threshold) return "positive";
  if (site.pPurifying < threshold) return "purifying";
  return "none";
}

function ConditionalLikelihoodFigure({
  result,
  site,
  labels,
  resolution,
  logWindow,
  scale,
  showGrid,
  svgRef,
}: {
  readonly result: ApproximateFelProducts;
  readonly site: ApproximateFelSiteResult;
  readonly labels: FelFigureLabels;
  readonly resolution: number;
  readonly logWindow: number;
  readonly scale: "log" | "likelihood";
  readonly showGrid: boolean;
  readonly svgRef: RefObject<SVGSVGElement | null>;
}) {
  const titleId = useId();
  const width = 760;
  const height = 735;
  const left = 112;
  const top = 75;
  const plotSize = 510;
  const gridSize = result.gridSize;
  const siteOffset = (site.site - 1) * gridSize * gridSize;
  const values = useMemo(
    () => Float64Array.from(result.relativeLogLikelihoods.subarray(siteOffset, siteOffset + gridSize * gridSize)),
    [gridSize, result.relativeLogLikelihoods, siteOffset],
  );
  const spline = useMemo(
    () => new ExactBicubicLogLikelihoodSpline(values, gridSize, site.splineTension),
    [gridSize, site.splineTension, values],
  );
  const maximum = site.logLikelihoodAlternative - site.gridLogLikelihoodMaximum;
  const minimum = maximum - logWindow;
  const cell = plotSize / resolution;
  const x = (coordinate: number): number => left + coordinate / Math.max(1, gridSize - 1) * plotSize;
  const y = (coordinate: number): number => top + (1 - coordinate / Math.max(1, gridSize - 1)) * plotSize;
  const directionColor = site.direction === "positive" ? RED : site.direction === "purifying" ? BLUE : TEAL;
  const tickIndices = Array.from(new Set(Array.from({ length: 7 }, (_unused, tick) => Math.round(tick * (gridSize - 1) / 6))));
  const normalized = (relativeLogLikelihood: number): number => scale === "log"
    ? (clamp(relativeLogLikelihood, minimum, maximum) - minimum) / Math.max(1e-12, maximum - minimum)
    : Math.exp(Math.min(0, relativeLogLikelihood - maximum));
  const title = `${labels.title} · codon ${site.site}`;

  return (
    <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={titleId} data-figure="approximate-fel-surface" style={{ ...svgStyle(), minWidth: "650px" }}>
      <title id={titleId}>{title}</title>
      <desc>Raw conditional log likelihood without the FUBAR prior. The line joins the constrained alpha equals beta optimum to the unconstrained optimum.</desc>
      <rect width={width} height={height} fill="#fff" />
      <text x={left} y="29" fill={INK} fontSize="21" fontWeight="650">{title}</text>
      <text x={left} y="52" fill={directionColor} fontSize="11">LRT={site.likelihoodRatio.toFixed(4)} · two-sided p={pLabel(site.pValue)} · {site.direction} direction</text>
      {Array.from({ length: resolution }, (_unused, row) => Array.from({ length: resolution }, (_inner, column) => {
        const alpha = (column + 0.5) / resolution * (gridSize - 1);
        const beta = (resolution - row - 0.5) / resolution * (gridSize - 1);
        const value = spline.evaluate(alpha, beta);
        return <rect key={`${row}-${column}`} x={left + column * cell} y={top + row * cell} width={cell + 0.15} height={cell + 0.15} fill={heatColor(normalized(value))} shapeRendering="crispEdges" />;
      }))}
      {showGrid && Array.from({ length: gridSize }, (_unused, position) => (
        <g key={position} opacity="0.28" pointerEvents="none">
          <line x1={x(position)} x2={x(position)} y1={top} y2={top + plotSize} stroke="#fff" strokeWidth="0.45" />
          <line x1={left} x2={left + plotSize} y1={y(position)} y2={y(position)} stroke="#fff" strokeWidth="0.45" />
        </g>
      ))}
      <line x1={x(0)} y1={y(0)} x2={x(gridSize - 1)} y2={y(gridSize - 1)} stroke="#ccd0ce" strokeWidth="1.6" strokeDasharray="7 5" />
      <line x1={x(site.nullCoordinate)} y1={y(site.nullCoordinate)} x2={x(site.alphaCoordinate)} y2={y(site.betaCoordinate)} stroke="#fff" strokeWidth="5" opacity="0.82" />
      <line x1={x(site.nullCoordinate)} y1={y(site.nullCoordinate)} x2={x(site.alphaCoordinate)} y2={y(site.betaCoordinate)} stroke={INK} strokeWidth="2" data-lrt-connector="true">
        <title>{`${labels.connector}: 2ΔlogL = ${site.likelihoodRatio.toFixed(6)}`}</title>
      </line>
      <polygon points={`${x(site.nullCoordinate)},${y(site.nullCoordinate) - 7} ${x(site.nullCoordinate) + 7},${y(site.nullCoordinate)} ${x(site.nullCoordinate)},${y(site.nullCoordinate) + 7} ${x(site.nullCoordinate) - 7},${y(site.nullCoordinate)}`} fill="#fff" stroke={INK} strokeWidth="2" data-optimum="null">
        <title>{`${labels.null}: α=β=${rateLabel(site.alphaBetaNull)}, logL=${site.logLikelihoodNull.toFixed(6)}`}</title>
      </polygon>
      <circle cx={x(site.alphaCoordinate)} cy={y(site.betaCoordinate)} r="7" fill={directionColor} stroke="#fff" strokeWidth="2.5" data-optimum="alternative">
        <title>{`${labels.alternative}: α=${rateLabel(site.alphaAlternative)}, β=${rateLabel(site.betaAlternative)}, logL=${site.logLikelihoodAlternative.toFixed(6)}`}</title>
      </circle>
      <line x1={left} x2={left} y1={top} y2={top + plotSize} stroke={INK} />
      <line x1={left} x2={left + plotSize} y1={top + plotSize} y2={top + plotSize} stroke={INK} />
      {tickIndices.map((tick) => (
        <g key={tick}>
          <text x={x(tick)} y={top + plotSize + 18} textAnchor="end" fill={INK} fontSize="10" transform={`rotate(-45 ${x(tick)} ${top + plotSize + 18})`}>{rateLabel(result.gridValues[tick]!)}</text>
          <text x={left - 10} y={y(tick) + 4} textAnchor="end" fill={INK} fontSize="10">{rateLabel(result.gridValues[tick]!)}</text>
        </g>
      ))}
      <text x={left + plotSize / 2} y="665" textAnchor="middle" fill={INK} fontSize="18">{labels.xAxis}</text>
      <text x="29" y={top + plotSize / 2} textAnchor="middle" fill={INK} fontSize="18" transform={`rotate(-90 29 ${top + plotSize / 2})`}>{labels.yAxis}</text>
      {Array.from({ length: 80 }, (_unused, position) => (
        <rect key={position} x="656" y={top + position * (plotSize / 80)} width="23" height={plotSize / 80 + 0.2} fill={heatColor(1 - position / 79)} />
      ))}
      <text x="686" y={top + 4} fill={INK} fontSize="9">{scale === "log" ? maximum.toFixed(2) : "1"}</text>
      <text x="686" y={top + plotSize} fill={INK} fontSize="9">{scale === "log" ? minimum.toFixed(2) : `e−${logWindow}`}</text>
      <text x="668" y={top + plotSize / 2} textAnchor="middle" fill={INK} fontSize="10" transform={`rotate(-90 668 ${top + plotSize / 2})`}>{scale === "log" ? labels.color : "Relative likelihood"}</text>
      <g transform={`translate(${left + 22} 710)`} fill={INK} fontSize="10">
        <circle cx="0" cy="0" r="5" fill={directionColor} /><text x="10" y="4">{labels.alternative}</text>
        <polygon points="188,-5 193,0 188,5 183,0" fill="#fff" stroke={INK} /><text x="202" y="4">{labels.null}</text>
        <line x1="330" x2="358" y1="0" y2="0" stroke={INK} strokeWidth="2" /><text x="367" y="4">LRT connector</text>
      </g>
    </svg>
  );
}

export function ApproximateFelResults({ result }: { readonly result: ApproximateFelProducts }) {
  const initial = result.sites.reduce((best, site) => site.pValue < best.pValue ? site : best, result.sites[0]!);
  const [threshold, setThreshold] = useState(0.05);
  const [showPositive, setShowPositive] = useState(true);
  const [showPurifying, setShowPurifying] = useState(true);
  const [detectedOnly, setDetectedOnly] = useState(false);
  const [selectedSite, setSelectedSite] = useState(initial.site);
  const [resolution, setResolution] = useState(48);
  const [logWindow, setLogWindow] = useState(12);
  const [scale, setScale] = useState<"log" | "likelihood">("log");
  const [showGrid, setShowGrid] = useState(false);
  const [labels, setLabels] = useState<FelFigureLabels>(DEFAULT_LABELS);
  const svgRef = useRef<SVGSVGElement>(null);
  const positiveCount = useMemo(() => result.sites.filter((site) => site.pPositive < threshold).length, [result.sites, threshold]);
  const purifyingCount = useMemo(() => result.sites.filter((site) => site.pPurifying < threshold).length, [result.sites, threshold]);
  const filtered = useMemo(() => result.sites.filter((site) => {
    const call = approximateFelCall(site, threshold);
    if (detectedOnly) return (showPositive && call === "positive") || (showPurifying && call === "purifying");
    if (showPositive && showPurifying) return true;
    return (showPositive && site.direction === "positive") || (showPurifying && site.direction === "purifying");
  }), [detectedOnly, result.sites, showPositive, showPurifying, threshold]);
  const selected = result.sites[clamp(selectedSite - 1, 0, result.sites.length - 1)]!;
  const visible = filtered.slice(0, 500);
  const labelFields = Object.keys(labels) as Array<keyof FelFigureLabels>;

  return (
    <section className="approximate-fel" aria-labelledby="approximate-fel-heading">
      <div className="approximate-fel__heading">
        <div><p className="eyebrow">Optional frequentist companion</p><h3 id="approximate-fel-heading">Approximate FEL</h3><p>Separate site-wise LRTs derived from the raw FUBAR conditional likelihood grid. No FUBAR prior enters these results.</p></div>
        <button type="button" className="button button--primary" onClick={() => downloadCsv(result, threshold)}>Download FEL CSV</button>
      </div>
      <div className="approximate-fel__separation"><strong>Separate from FUBAR</strong><span>The posterior table and figures above are unchanged. Thresholds here apply only to approximate FEL.</span></div>
      <div className="result-stats approximate-fel__stats">
        <div><span>Positive at p &lt; {threshold.toFixed(3)}</span><strong className="positive-text">{positiveCount}</strong></div>
        <div><span>Purifying at p &lt; {threshold.toFixed(3)}</span><strong className="purifying-text">{purifyingCount}</strong></div>
        <div><span>Exact-node error</span><strong>{result.diagnostics.maximumNodeError.toExponential(1)}</strong></div>
        <div><span>Guarded surfaces</span><strong>{result.diagnostics.guardedSites} / {result.siteCount}</strong></div>
      </div>
      <div className="selection-visibility" role="group" aria-label="Approximate FEL directions shown">
        <div><strong>Explore FEL directions</strong><span>Independent one-sided signed-root LRT p-values.</span></div>
        <label className="toggle toggle--positive"><input type="checkbox" checked={showPositive} onChange={(event) => setShowPositive(event.target.checked)} /><span>Positive selection</span></label>
        <label className="toggle toggle--purifying"><input type="checkbox" checked={showPurifying} onChange={(event) => setShowPurifying(event.target.checked)} /><span>Purifying selection</span></label>
      </div>
      <div className="figure-controls approximate-fel__controls">
        <label className="figure-control figure-control--threshold"><span>FEL p threshold <strong>{threshold.toFixed(3)}</strong></span><input type="range" min="0.001" max="0.2" step="0.001" value={threshold} onChange={(event) => setThreshold(Number(event.target.value))} /></label>
        <label className="figure-control"><span>Surface codon</span><input type="number" min="1" max={result.siteCount} value={selected.site} onChange={(event) => setSelectedSite(clamp(Number(event.target.value), 1, result.siteCount))} /></label>
        <label className="figure-control"><span>Color scale</span><select value={scale} onChange={(event) => setScale(event.target.value === "likelihood" ? "likelihood" : "log")}><option value="log">Relative log L</option><option value="likelihood">Relative likelihood</option></select></label>
        <label className="figure-control"><span>Log-L window <strong>{logWindow}</strong></span><input type="range" min="2" max="50" step="1" value={logWindow} onChange={(event) => setLogWindow(Number(event.target.value))} /></label>
        <label className="figure-control"><span>SVG resolution</span><select value={resolution} onChange={(event) => setResolution(Number(event.target.value))}>{[32, 48, 64].map((value) => <option key={value} value={value}>{value} × {value}</option>)}</select></label>
      </div>
      <div className="approximate-fel__minor-controls">
        <label className="toggle"><input type="checkbox" checked={showGrid} onChange={(event) => setShowGrid(event.target.checked)} /><span>Show original grid</span></label>
        <span>Site {selected.site}: α={rateLabel(selected.alphaAlternative)}, β={rateLabel(selected.betaAlternative)}, null α=β={rateLabel(selected.alphaBetaNull)}</span>
      </div>
      <details className="figure-label-editor">
        <summary>Edit conditional-likelihood figure labels</summary>
        <div className="figure-label-grid">{labelFields.map((field) => <label key={field}><span>{field}</span><input value={labels[field]} onChange={(event) => setLabels({ ...labels, [field]: event.target.value })} /></label>)}</div>
        <button type="button" className="button button--quiet" onClick={() => setLabels(DEFAULT_LABELS)}>Reset labels</button>
      </details>
      <article className="figure-card">
        <div className="figure-card__heading">
          <div><strong>{labels.title} · codon {selected.site}</strong><span>Interpolated raw conditional log likelihood; diamond = α=β optimum, circle = unrestricted optimum, connecting segment = LRT.</span></div>
          <button type="button" className="button button--secondary button--svg" onClick={() => svgRef.current !== null && downloadSvg(svgRef.current, `${labels.title} codon ${selected.site}`)}>Export SVG</button>
        </div>
        <div className="figure-scroll"><ConditionalLikelihoodFigure result={result} site={selected} labels={labels} resolution={resolution} logWindow={logWindow} scale={scale} showGrid={showGrid} svgRef={svgRef} /></div>
      </article>
      <details className="approximate-fel__method">
        <summary>Interpolation and LRT checks</summary>
        <p>The surface is fitted to max-shifted raw log likelihoods in the uniform FUBAR grid-index coordinate and passes through every grid value. A local curvature audit applies deterministic cubic tension only when needed; minimum tension was {result.diagnostics.minimumSplineTension.toFixed(4)}. The two-sided statistic is 2(log L<sub>alt</sub> − log L<sub>null</sub>) with one degree of freedom; directional values use the signed-root LRT.</p>
      </details>
      <div className="result-toolbar">
        <label className="toggle"><input type="checkbox" checked={detectedOnly} onChange={(event) => setDetectedOnly(event.target.checked)} /><span>Significant sites only</span></label>
        <span>{visible.length.toLocaleString()} rows shown{filtered.length > 500 ? " (first 500)" : ""}</span>
      </div>
      <div className="result-table-wrap">
        <table className="result-table approximate-fel__table">
          <thead><tr><th>Codon</th><th>p positive</th><th>p purifying</th><th>p two-sided</th><th>LRT</th><th>α alt</th><th>β alt</th><th>α=β null</th><th>Direction</th></tr></thead>
          <tbody>{visible.map((site) => {
            const call = approximateFelCall(site, threshold);
            return (
              <tr key={site.site} className={call === "positive" ? "is-positive" : call === "purifying" ? "is-purifying" : undefined} onClick={() => setSelectedSite(site.site)}>
                <td><strong>{site.site}</strong>{call !== "none" && <span className={`site-mark site-mark--${call}`}>{call === "positive" ? "+" : "−"}</span>}</td>
                <td>{pLabel(site.pPositive)}</td><td>{pLabel(site.pPurifying)}</td><td>{pLabel(site.pValue)}</td><td>{site.likelihoodRatio.toFixed(3)}</td><td>{rateLabel(site.alphaAlternative)}</td><td>{rateLabel(site.betaAlternative)}</td><td>{rateLabel(site.alphaBetaNull)}</td><td>{site.direction}</td>
              </tr>
            );
          })}</tbody>
        </table>
      </div>
    </section>
  );
}

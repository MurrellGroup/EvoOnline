import { useId, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import type { FubarSiteResult } from "@phylo-workbench/model-fubar/browser-source";
import type { FubarRunResult } from "../types.js";
import { downloadSvg } from "../lib/svg-export.js";

const RED = "#ff4b4f";
const BLUE = "#4f46f5";
const GREEN = "#54aa61";
const INK = "#172321";
const MUTED = "#6d7976";
const FONT = "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";

type FigureKey = "overview" | "marginals" | "surface";

interface FubarLabels {
  readonly alpha: string;
  readonly beta: string;
  readonly overviewTitle: string;
  readonly overviewXAxis: string;
  readonly overviewYAxis: string;
  readonly marginalsTitle: string;
  readonly marginalsXAxis: string;
  readonly marginalsYAxis: string;
  readonly surfaceTitle: string;
  readonly surfaceXAxis: string;
  readonly surfaceYAxis: string;
}

const DEFAULT_LABELS: FubarLabels = {
  alpha: "α",
  beta: "β",
  overviewTitle: "Posterior mean selection by codon",
  overviewXAxis: "Codon sites",
  overviewYAxis: "Rate",
  marginalsTitle: "Parameter posteriors at detected sites",
  marginalsXAxis: "Parameter value",
  marginalsYAxis: "Codon sites",
  surfaceTitle: "Site posterior surface",
  surfaceXAxis: "α",
  surfaceYAxis: "β",
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function gridLabel(value: number): string {
  if (value >= 10) return Number(value.toPrecision(4)).toString();
  return Number(value.toPrecision(3)).toString();
}

function svgStyle(): CSSProperties {
  return { display: "block", width: "100%", height: "auto", background: "#fff", fontFamily: FONT };
}

function selection(site: FubarSiteResult, threshold: number): "positive" | "purifying" | "none" {
  if (site.pPositive > threshold) return "positive";
  if (site.pPurifying > threshold) return "purifying";
  return "none";
}

function selectionColor(site: FubarSiteResult, threshold: number): string {
  const selected = selection(site, threshold);
  return selected === "positive" ? RED : selected === "purifying" ? BLUE : "#85908d";
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

function FubarOverview({ sites, threshold, labels, selectedSite, onSelectSite, svgRef }: {
  readonly sites: readonly FubarSiteResult[];
  readonly threshold: number;
  readonly labels: FubarLabels;
  readonly selectedSite: number;
  readonly onSelectSite: (site: number) => void;
  readonly svgRef: RefObject<SVGSVGElement | null>;
}) {
  const titleId = useId();
  const width = 1_200;
  const height = 430;
  const left = 78;
  const right = 24;
  const top = 86;
  const bottom = 64;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const maximum = Math.max(1.1, ...sites.flatMap((site) => [site.meanAlpha, site.meanBeta]));
  const transformedMaximum = Math.log10(maximum + 1);
  const x = (site: number): number => left + ((site - 1) / Math.max(1, sites.length - 1)) * plotWidth;
  const y = (value: number): number => top + (1 - Math.log10(Math.max(0, value) + 1) / transformedMaximum) * plotHeight;
  const yTicks = [0, 0.1, 0.5, 1, 2, 5, 10, 20, 40].filter((value) => value <= maximum * 1.05);
  const tickStep = Math.max(1, Math.ceil(sites.length / 10));

  return (
    <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={titleId} style={svgStyle()}>
      <title id={titleId}>{labels.overviewTitle}</title>
      <text x={left} y="30" fill={INK} fontSize="22" fontWeight="650">{labels.overviewTitle}</text>
      <g transform={`translate(${left + 180} 57)`} fill={INK} fontSize="12">
        <circle cx="0" cy="0" r="4" fill={GREEN} /><text x="10" y="4">mean {labels.alpha}</text>
        <circle cx="128" cy="0" r="4" fill={RED} /><text x="138" y="4">positive selection</text>
        <circle cx="302" cy="0" r="4" fill={BLUE} /><text x="312" y="4">purifying selection</text>
        <circle cx="478" cy="0" r="4" fill="#85908d" opacity="0.4" /><text x="488" y="4">below threshold</text>
      </g>
      {yTicks.map((tick) => (
        <g key={tick}>
          <line x1={left - 6} x2={left} y1={y(tick)} y2={y(tick)} stroke={INK} />
          <text x={left - 12} y={y(tick) + 4} textAnchor="end" fill={INK} fontSize="11">{tick}</text>
        </g>
      ))}
      {sites.filter((_site, index) => index % tickStep === 0 || index === sites.length - 1).map((site) => (
        <g key={site.site}>
          <line x1={x(site.site)} x2={x(site.site)} y1={top + plotHeight} y2={top + plotHeight + 5} stroke={INK} />
          <text x={x(site.site)} y={top + plotHeight + 22} textAnchor="middle" fill={INK} fontSize="10">{site.site}</text>
        </g>
      ))}
      <line x1={left} x2={left} y1={top} y2={top + plotHeight} stroke={INK} strokeWidth="1.2" />
      <line x1={left} x2={left + plotWidth} y1={top + plotHeight} y2={top + plotHeight} stroke={INK} strokeWidth="1.2" />
      {sites.map((site) => {
        const color = selectionColor(site, threshold);
        const strong = selection(site, threshold) !== "none";
        return (
          <g key={site.site} opacity={strong ? 0.86 : 0.12} onClick={() => onSelectSite(site.site)} style={{ cursor: "pointer" }}>
            <line x1={x(site.site)} x2={x(site.site)} y1={y(site.meanAlpha)} y2={y(site.meanBeta)} stroke={color} strokeWidth={strong ? 2.2 : 1.2} />
            <circle cx={x(site.site)} cy={y(site.meanAlpha)} r={strong ? 3.2 : 2.2} fill={GREEN}><title>{`Codon ${site.site}: mean α ${site.meanAlpha.toFixed(4)}`}</title></circle>
            <circle cx={x(site.site)} cy={y(site.meanBeta)} r={strong ? 3.5 : 2.3} fill={color}><title>{`Codon ${site.site}: mean β ${site.meanBeta.toFixed(4)}; P+ ${site.pPositive.toFixed(4)}; P− ${site.pPurifying.toFixed(4)}`}</title></circle>
          </g>
        );
      })}
      {sites[selectedSite - 1] !== undefined && (
        <line x1={x(selectedSite)} x2={x(selectedSite)} y1={top} y2={top + plotHeight} stroke="#0d5e57" strokeWidth="1.4" strokeDasharray="3 3" pointerEvents="none" />
      )}
      <text x={left + plotWidth / 2} y={height - 14} textAnchor="middle" fill={INK} fontSize="16">{labels.overviewXAxis}</text>
      <text x="21" y={top + plotHeight / 2} textAnchor="middle" fill={INK} fontSize="18" transform={`rotate(-90 21 ${top + plotHeight / 2})`}>{labels.overviewYAxis}</text>
    </svg>
  );
}

function FubarMarginals({ result, sites, threshold, labels, selectedSite, onSelectSite, svgRef }: {
  readonly result: FubarRunResult;
  readonly sites: readonly FubarSiteResult[];
  readonly threshold: number;
  readonly labels: FubarLabels;
  readonly selectedSite: number;
  readonly onSelectSite: (site: number) => void;
  readonly svgRef: RefObject<SVGSVGElement | null>;
}) {
  const titleId = useId();
  const width = 520;
  const left = 112;
  const right = 20;
  const top = 92;
  const bottom = 118;
  const rowGap = 52;
  const plotWidth = width - left - right;
  const plotHeight = Math.max(rowGap, sites.length * rowGap);
  const height = top + plotHeight + bottom;
  const bins = result.posterior.gridSize;
  const step = plotWidth / bins;
  const barWidth = step * 0.8;
  const x = (bin: number): number => left + (bin + 0.5) * step;
  const y = (row: number): number => top + row * rowGap + rowGap / 2;
  const laneOffset = rowGap * 0.2;
  const maximumThickness = rowGap * 0.7;

  return (
    <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={titleId} data-layout="paper-portrait" style={{ ...svgStyle(), width: `${width}px`, minWidth: `${width}px`, margin: "0 auto" }}>
      <title id={titleId}>{labels.marginalsTitle}</title>
      <desc>Green alpha posterior mass is shown above each codon; beta posterior mass is below, red for positive and blue for purifying selection.</desc>
      <text x={left} y="25" fill={INK} fontSize="18" fontWeight="650">{labels.marginalsTitle}</text>
      <g transform="translate(164 62)" fill={INK} fontSize="11">
        <rect x="0" y="-19" width="226" height="31" fill="#fff" stroke={INK} strokeWidth="0.8" />
        <rect x="11" y="-11" width="20" height="10" fill={GREEN} opacity="0.8" /><text x="38" y="-2">{labels.alpha}</text>
        <rect x="82" y="-11" width="20" height="10" fill={RED} opacity="0.8" /><text x="109" y="-2">{labels.beta} +</text>
        <rect x="154" y="-11" width="20" height="10" fill={BLUE} opacity="0.8" /><text x="181" y="-2">{labels.beta} −</text>
      </g>
      {sites.map((site, row) => {
        const sourceSite = site.site - 1;
        const betaColor = selectionColor(site, threshold);
        return (
          <g key={site.site} onClick={() => onSelectSite(site.site)} style={{ cursor: "pointer" }}>
            {site.site === selectedSite && <rect x={left - 64} y={top + row * rowGap} width={plotWidth + 66} height={rowGap} fill="#eaf4f0" />}
            <text x={left - 15} y={y(row) + 4} textAnchor="end" fill={site.site === selectedSite ? "#0d5e57" : INK} fontSize="13" fontWeight="700">{site.site}</text>
            {Array.from({ length: bins }, (_unused, bin) => {
              const alphaMass = result.posterior.alpha[sourceSite * bins + bin] ?? 0;
              const betaMass = result.posterior.beta[sourceSite * bins + bin] ?? 0;
              const alphaHeight = Math.max(1.1, alphaMass * maximumThickness);
              const betaHeight = Math.max(1.1, betaMass * maximumThickness);
              return (
                <g key={bin} shapeRendering="crispEdges">
                  <rect x={x(bin) - barWidth / 2} y={y(row) - laneOffset - alphaHeight / 2} width={barWidth} height={alphaHeight} fill={GREEN} opacity="0.8"><title>{`α ${gridLabel(result.posterior.gridValues[bin]!)}: ${alphaMass.toFixed(5)}`}</title></rect>
                  <rect x={x(bin) - barWidth / 2} y={y(row) + laneOffset - betaHeight / 2} width={barWidth} height={betaHeight} fill={betaColor} opacity="0.82"><title>{`β ${gridLabel(result.posterior.gridValues[bin]!)}: ${betaMass.toFixed(5)}`}</title></rect>
                </g>
              );
            })}
          </g>
        );
      })}
      <line x1={left} x2={left} y1={top} y2={top + plotHeight} stroke={INK} strokeWidth="1.3" />
      <line x1={left} x2={left + plotWidth} y1={top + plotHeight} y2={top + plotHeight} stroke={INK} strokeWidth="1.3" />
      {Array.from(result.posterior.gridValues).map((value, bin) => (
        <text key={bin} x={x(bin)} y={top + plotHeight + 20} textAnchor="end" fill={INK} fontSize="10" transform={`rotate(-90 ${x(bin)} ${top + plotHeight + 20})`}>{gridLabel(value)}</text>
      ))}
      <text x={left + plotWidth / 2} y={height - 16} textAnchor="middle" fill={INK} fontSize="18">{labels.marginalsXAxis}</text>
      <text x="24" y={top + plotHeight / 2} textAnchor="middle" fill={INK} fontSize="19" transform={`rotate(-90 24 ${top + plotHeight / 2})`}>{labels.marginalsYAxis}</text>
    </svg>
  );
}

const TURBO_STOPS: readonly [number, readonly [number, number, number]][] = [
  [0, [18, 7, 126]], [0.16, [74, 28, 206]], [0.32, [24, 112, 184]],
  [0.5, [11, 155, 81]], [0.68, [190, 185, 0]], [0.84, [255, 123, 0]], [1, [196, 15, 0]],
];

function heatColor(value: number): string {
  const normalized = clamp(value, 0, 1);
  let lower = TURBO_STOPS[0]!;
  let upper = TURBO_STOPS[TURBO_STOPS.length - 1]!;
  for (let index = 1; index < TURBO_STOPS.length; index += 1) {
    if (normalized <= TURBO_STOPS[index]![0]) {
      lower = TURBO_STOPS[index - 1]!;
      upper = TURBO_STOPS[index]!;
      break;
    }
  }
  const fraction = (normalized - lower[0]) / Math.max(1e-12, upper[0] - lower[0]);
  const channel = (index: number): number => Math.round(lower[1][index]! + fraction * (upper[1][index]! - lower[1][index]!));
  return `rgb(${channel(0)},${channel(1)},${channel(2)})`;
}

function PosteriorSurface({ result, site, labels, svgRef }: {
  readonly result: FubarRunResult;
  readonly site: FubarSiteResult;
  readonly labels: FubarLabels;
  readonly svgRef: RefObject<SVGSVGElement | null>;
}) {
  const titleId = useId();
  const width = 720;
  const height = 690;
  const left = 112;
  const top = 68;
  const plotSize = 500;
  const gridSize = result.posterior.gridSize;
  const cell = plotSize / gridSize;
  const surfaceOffset = (site.site - 1) * gridSize * gridSize;
  let maximum = 0;
  for (let category = 0; category < gridSize * gridSize; category += 1) maximum = Math.max(maximum, result.posterior.surfaces[surfaceOffset + category] ?? 0);
  const title = `${labels.surfaceTitle} · codon ${site.site}`;

  return (
    <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={titleId} style={{ ...svgStyle(), minWidth: "620px" }}>
      <title id={titleId}>{title}</title>
      <text x={left} y="28" fill={INK} fontSize="21" fontWeight="650">{title}</text>
      <text x={left} y="49" fill={selectionColor(site, 0.5)} fontSize="11">P(β&gt;α)={site.pPositive.toFixed(4)} · P(α&gt;β)={site.pPurifying.toFixed(4)}</text>
      {Array.from({ length: gridSize }, (_unused, alphaIndex) => Array.from({ length: gridSize }, (_inner, betaIndex) => {
        const category = alphaIndex * gridSize + betaIndex;
        const mass = result.posterior.surfaces[surfaceOffset + category] ?? 0;
        const normalized = maximum > 0 ? mass / maximum : 0;
        const cellX = left + alphaIndex * cell;
        const cellY = top + (gridSize - 1 - betaIndex) * cell;
        return (
          <rect key={`${alphaIndex}-${betaIndex}`} x={cellX} y={cellY} width={cell + 0.2} height={cell + 0.2} fill={heatColor(normalized)} shapeRendering="crispEdges">
            <title>{`α=${gridLabel(result.posterior.gridValues[alphaIndex]!)}, β=${gridLabel(result.posterior.gridValues[betaIndex]!)}, posterior=${mass.toFixed(6)}`}</title>
          </rect>
        );
      }))}
      <line x1={left + cell / 2} y1={top + plotSize - cell / 2} x2={left + plotSize - cell / 2} y2={top + cell / 2} stroke="#a6aaa8" strokeWidth="1.5" strokeDasharray="6 5" />
      <line x1={left} x2={left} y1={top} y2={top + plotSize} stroke={INK} />
      <line x1={left} x2={left + plotSize} y1={top + plotSize} y2={top + plotSize} stroke={INK} />
      {Array.from(result.posterior.gridValues).map((value, index) => (
        <g key={`x-${index}`}>
          <text x={left + (index + 0.5) * cell} y={top + plotSize + 17} textAnchor="end" fill={INK} fontSize="9" transform={`rotate(-90 ${left + (index + 0.5) * cell} ${top + plotSize + 17})`}>{gridLabel(value)}</text>
          <text x={left - 9} y={top + (gridSize - index - 0.5) * cell + 3} textAnchor="end" fill={INK} fontSize="9">{gridLabel(value)}</text>
        </g>
      ))}
      <text x={left + plotSize / 2} y={height - 18} textAnchor="middle" fill={INK} fontSize="18">{labels.surfaceXAxis}</text>
      <text x="28" y={top + plotSize / 2} textAnchor="middle" fill={INK} fontSize="18" transform={`rotate(-90 28 ${top + plotSize / 2})`}>{labels.surfaceYAxis}</text>
      {Array.from({ length: 80 }, (_unused, index) => (
        <rect key={index} x={636} y={top + index * (plotSize / 80)} width="22" height={plotSize / 80 + 0.2} fill={heatColor(1 - index / 79)} />
      ))}
      <text x="664" y={top + 4} fill={INK} fontSize="9">{maximum.toFixed(4)}</text>
      <text x="664" y={top + plotSize} fill={INK} fontSize="9">0</text>
      <text x="647" y={top + plotSize / 2} textAnchor="middle" fill={INK} fontSize="10" transform={`rotate(-90 647 ${top + plotSize / 2})`}>Posterior mass</text>
    </svg>
  );
}

function LabelEditor({ labels, onChange }: { readonly labels: FubarLabels; readonly onChange: (labels: FubarLabels) => void }) {
  const fields = Object.keys(labels) as Array<keyof FubarLabels>;
  return (
    <details className="figure-label-editor">
      <summary>Edit figure labels</summary>
      <div className="figure-label-grid">
        {fields.map((field) => (
          <label key={field}><span>{field.replaceAll(/([A-Z])/g, " $1")}</span><input value={labels[field]} onChange={(event) => onChange({ ...labels, [field]: event.target.value })} /></label>
        ))}
      </div>
      <button type="button" className="button button--quiet" onClick={() => onChange(DEFAULT_LABELS)}>Reset labels</button>
    </details>
  );
}

export function FubarVisualizations({ result, threshold, onThresholdChange }: {
  readonly result: FubarRunResult;
  readonly threshold: number;
  readonly onThresholdChange: (threshold: number) => void;
}) {
  const detected = useMemo(() => result.sites.filter((site) => site.pPositive > threshold || site.pPurifying > threshold), [result.sites, threshold]);
  const [activeFigure, setActiveFigure] = useState<FigureKey>("overview");
  const [selectedSite, setSelectedSite] = useState(result.positiveSites[0] ?? result.purifyingSites[0] ?? 1);
  const [rowLimit, setRowLimit] = useState(100);
  const [labels, setLabels] = useState<FubarLabels>(DEFAULT_LABELS);
  const overviewRef = useRef<SVGSVGElement>(null);
  const marginalsRef = useRef<SVGSVGElement>(null);
  const surfaceRef = useRef<SVGSVGElement>(null);
  const selected = result.sites[clamp(selectedSite - 1, 0, result.sites.length - 1)]!;
  const rows = detected.slice(0, rowLimit);

  return (
    <section className="figure-studio" aria-labelledby="fubar-figure-heading">
      <div className="figure-studio__heading">
        <div><p className="eyebrow">Interactive figures</p><h3 id="fubar-figure-heading">FUBAR figure studio</h3><p>Positive and purifying selection views with linked codons, editable labels, and native SVG export.</p></div>
        <div className="figure-selection"><span>Selected codon</span><strong>{selected.site}</strong></div>
      </div>
      <div className="figure-controls">
        <label className="figure-control figure-control--threshold"><span>Posterior threshold <strong>{threshold.toFixed(3)}</strong></span><input type="range" min="0.5" max="0.999" step="0.001" value={threshold} onChange={(event) => onThresholdChange(Number(event.target.value))} /></label>
        <label className="figure-control"><span>Surface codon</span><input type="number" min="1" max={result.sites.length} value={selected.site} onChange={(event) => setSelectedSite(clamp(Number(event.target.value), 1, result.sites.length))} /></label>
        <label className="figure-control"><span>Maximum rows</span><select value={rowLimit} onChange={(event) => setRowLimit(Number(event.target.value))}>{[25, 50, 100, 250, 500].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <div className="figure-control figure-control--summary"><span>Positive / purifying</span><strong>{detected.filter((site) => site.pPositive > threshold).length} / {detected.filter((site) => site.pPurifying > threshold).length}</strong></div>
      </div>
      <LabelEditor labels={labels} onChange={setLabels} />
      <div className="figure-tabs" role="tablist" aria-label="FUBAR figures">
        <button type="button" role="tab" aria-selected={activeFigure === "overview"} className={activeFigure === "overview" ? "is-active" : ""} onClick={() => setActiveFigure("overview")}>Selection overview</button>
        <button type="button" role="tab" aria-selected={activeFigure === "marginals"} className={activeFigure === "marginals" ? "is-active" : ""} onClick={() => setActiveFigure("marginals")}>Parameter posteriors</button>
        <button type="button" role="tab" aria-selected={activeFigure === "surface"} className={activeFigure === "surface" ? "is-active" : ""} onClick={() => setActiveFigure("surface")}>Posterior surface</button>
      </div>
      {activeFigure === "overview" && <FigureShell title={labels.overviewTitle} description="Green α and one β per codon; red highlights positive and blue highlights purifying selection." svgRef={overviewRef}><FubarOverview sites={result.sites} threshold={threshold} labels={labels} selectedSite={selected.site} onSelectSite={setSelectedSite} svgRef={overviewRef} /></FigureShell>}
      {activeFigure === "marginals" && (rows.length === 0
        ? <div className="figure-empty"><strong>No sites exceed this threshold.</strong><span>Lower the threshold to reveal α and β posterior marginals.</span></div>
        : <FigureShell title={labels.marginalsTitle} description={`Green α is above each codon; β is below and colored by selection direction.${detected.length > rows.length ? ` Showing the first ${rows.length}.` : ""}`} svgRef={marginalsRef} tall><FubarMarginals result={result} sites={rows} threshold={threshold} labels={labels} selectedSite={selected.site} onSelectSite={setSelectedSite} svgRef={marginalsRef} /></FigureShell>)}
      {activeFigure === "surface" && <FigureShell title={`${labels.surfaceTitle} · codon ${selected.site}`} description="Full site posterior over the fixed α×β grid; the dashed diagonal is β=α." svgRef={surfaceRef}><PosteriorSurface result={result} site={selected} labels={labels} svgRef={surfaceRef} /></FigureShell>}
      <p className="figure-note">Click a codon in the overview or marginal plot to open its posterior surface. Red denotes P(β&gt;α); blue denotes P(α&gt;β).</p>
    </section>
  );
}

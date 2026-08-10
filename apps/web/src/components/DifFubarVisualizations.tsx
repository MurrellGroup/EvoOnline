import {
  useId,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import type { PosteriorMarginals, SiteResult } from "@phylo-workbench/model-diffubar/browser-source";
import { downloadSvg } from "../lib/svg-export.js";
import type { DifFubarRunResult } from "../types.js";

const RED = "#ff4b4f";
const BLUE = "#4f46f5";
const GREEN = "#54aa61";
const INK = "#172321";
const MUTED = "#6d7976";
const GRID = "#dfe4e1";
const FONT = "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";

type SvgInteractionEvent = ReactPointerEvent<SVGRectElement> | ReactMouseEvent<SVGRectElement>;

type FigureKey = "overview" | "marginals" | "evidence";

export interface FigureLabels {
  readonly group1: string;
  readonly group2: string;
  readonly alpha: string;
  readonly overviewTitle: string;
  readonly overviewXAxis: string;
  readonly overviewYAxis: string;
  readonly marginalsTitle: string;
  readonly marginalsXAxis: string;
  readonly marginalsYAxis: string;
  readonly evidenceTitle: string;
  readonly evidenceYAxis: string;
}

export const DEFAULT_LABELS: FigureLabels = {
  group1: "G1",
  group2: "G2",
  alpha: "α",
  overviewTitle: "Posterior mean selection by codon",
  overviewXAxis: "Codon sites",
  overviewYAxis: "ω",
  marginalsTitle: "Parameter posteriors at detected sites",
  marginalsXAxis: "Parameter value",
  marginalsYAxis: "Codon sites",
  evidenceTitle: "Posterior evidence at detected sites",
  evidenceYAxis: "Codon sites",
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function evidenceMaximum(site: SiteResult): number {
  return Math.max(site.pOmega1Greater, site.pOmega2Greater, site.pOmega1Positive, site.pOmega2Positive);
}

function gridLabel(value: number): string {
  if (value >= 10) return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return Number(value.toPrecision(3)).toString();
}

function fixed(value: number, digits = 3): string {
  return value.toFixed(digits);
}

function circlePath(x: number, y: number, radius: number): string {
  const left = (x - radius).toFixed(2);
  const diameter = (radius * 2).toFixed(2);
  return `M${left},${y.toFixed(2)}a${radius},${radius} 0 1,0 ${diameter},0a${radius},${radius} 0 1,0 -${diameter},0`;
}

function rectPath(x: number, y: number, width: number, height: number): string {
  return `M${x.toFixed(2)},${y.toFixed(2)}h${width.toFixed(2)}v${height.toFixed(2)}h-${width.toFixed(2)}Z`;
}

function svgStyle(): CSSProperties {
  return { display: "block", width: "100%", height: "auto", background: "#ffffff", fontFamily: FONT };
}

function FigureShell({
  title,
  description,
  svgRef,
  tall = false,
  children,
}: {
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
        <button
          type="button"
          className="button button--secondary button--svg"
          onClick={() => svgRef.current !== null && downloadSvg(svgRef.current, title)}
        >
          Export SVG
        </button>
      </div>
      <div className={`figure-scroll ${tall ? "figure-scroll--tall" : ""}`}>{children}</div>
    </article>
  );
}

interface OverviewProps {
  readonly sites: readonly SiteResult[];
  readonly startSite: number;
  readonly endSite: number;
  readonly threshold: number;
  readonly labels: FigureLabels;
  readonly selectedSite?: number;
  readonly onSelectSite: (site: number) => void;
  readonly svgRef: RefObject<SVGSVGElement | null>;
}

function OmegaOverview({ sites, startSite, endSite, threshold, labels, selectedSite, onSelectSite, svgRef }: OverviewProps) {
  const titleId = useId();
  const [hovered, setHovered] = useState<SiteResult>();
  const width = 1_200;
  const height = 430;
  const left = 72;
  const right = 24;
  const top = 92;
  const bottom = 62;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const windowSpan = Math.max(1, endSite - startSite);
  const transform = (omega: number): number => Math.log10(Math.max(0.01, omega) + 1);
  const lower = transform(0.01);
  const upper = transform(10);
  const x = (site: number): number => left + ((site - startSite) / windowSpan) * plotWidth;
  const y = (omega: number): number => top + (1 - (transform(clamp(omega, 0.01, 10)) - lower) / (upper - lower)) * plotHeight;
  const siteByNumber = useMemo(() => new Map(sites.map((site) => [site.site, site])), [sites]);
  const visible = useMemo(
    () => sites.filter((site) => site.site >= startSite && site.site <= endSite),
    [endSite, sites, startSite],
  );
  const paths = useMemo(() => {
    const output = {
      lineRedHigh: "", lineRedLow: "", lineBlueHigh: "", lineBlueLow: "",
      point1High: "", point1Low: "", point2High: "", point2Low: "",
    };
    for (const site of visible) {
      const siteX = x(site.site);
      const omega1Y = y(site.meanOmega1);
      const omega2Y = y(site.meanOmega2);
      const differential = Math.max(site.pOmega1Greater, site.pOmega2Greater) > threshold;
      const lineKey = site.meanOmega1 > site.meanOmega2
        ? differential ? "lineRedHigh" : "lineRedLow"
        : differential ? "lineBlueHigh" : "lineBlueLow";
      output[lineKey] += `M${siteX.toFixed(2)},${omega1Y.toFixed(2)}V${omega2Y.toFixed(2)}`;
      output[site.pOmega1Positive > threshold ? "point1High" : "point1Low"] += circlePath(siteX, omega1Y, 2.7);
      output[site.pOmega2Positive > threshold ? "point2High" : "point2Low"] += circlePath(siteX, omega2Y, 2.7);
    }
    return output;
  }, [threshold, visible]);
  const yTicks = [0.01, 0.42, 1, 1.8, 3, 4.6, 6.8, 10];
  const xTicks = useMemo(() => {
    const count = Math.min(10, Math.max(1, endSite - startSite));
    return [...new Set(Array.from({ length: count + 1 }, (_, index) => Math.round(startSite + (index / count) * (endSite - startSite))))];
  }, [endSite, startSite]);

  const siteFromPointer = (event: SvgInteractionEvent): SiteResult | undefined => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const fraction = clamp((event.clientX - bounds.left) / Math.max(1, bounds.width), 0, 1);
    return siteByNumber.get(Math.round(startSite + fraction * (endSite - startSite)));
  };
  const selected = selectedSite === undefined ? undefined : siteByNumber.get(selectedSite);

  return (
    <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={titleId} style={svgStyle()}>
      <title id={titleId}>{labels.overviewTitle}</title>
      <text x={left} y={30} fill={INK} fontSize="22" fontWeight="650">{labels.overviewTitle}</text>
      <g transform={`translate(${left + 155} 54)`} fontSize="12" fill={INK}>
        <circle cx="0" cy="0" r="4" fill={RED} /><text x="10" y="4">{labels.group1} ω&gt;1</text>
        <circle cx="150" cy="0" r="4" fill={BLUE} /><text x="160" y="4">{labels.group2} ω&gt;1</text>
        <line x1="305" x2="345" y1="0" y2="0" stroke={RED} strokeWidth="2" /><text x="355" y="4">{labels.group1} ω&gt;{labels.group2} ω</text>
        <line x1="505" x2="545" y1="0" y2="0" stroke={BLUE} strokeWidth="2" /><text x="555" y="4">{labels.group2} ω&gt;{labels.group1} ω</text>
        <line x1="705" x2="745" y1="0" y2="0" stroke="#999f9d" strokeWidth="2" strokeDasharray="4 5" /><text x="755" y="4">ω=1</text>
      </g>

      {yTicks.map((tick) => (
        <g key={tick}>
          <line x1={left - 6} x2={left} y1={y(tick)} y2={y(tick)} stroke={INK} strokeWidth="1" />
          <text x={left - 12} y={y(tick) + 4} textAnchor="end" fill={INK} fontSize="11">{tick.toFixed(tick < 0.1 ? 2 : 1)}</text>
        </g>
      ))}
      {xTicks.map((tick) => (
        <g key={tick}>
          <line x1={x(tick)} x2={x(tick)} y1={top + plotHeight} y2={top + plotHeight + 5} stroke={INK} />
          <text x={x(tick)} y={top + plotHeight + 23} textAnchor="middle" fill={INK} fontSize="11">{tick}</text>
        </g>
      ))}
      <line x1={left} x2={left} y1={top} y2={top + plotHeight} stroke={INK} strokeWidth="1.2" />
      <line x1={left} x2={left + plotWidth} y1={top + plotHeight} y2={top + plotHeight} stroke={INK} strokeWidth="1.2" />
      <line x1={left} x2={left + plotWidth} y1={y(1)} y2={y(1)} stroke="#9da3a1" strokeWidth="2" strokeDasharray="4 5" opacity="0.72" />

      <path d={paths.lineRedLow} fill="none" stroke={RED} strokeWidth="2" opacity="0.075" />
      <path d={paths.lineBlueLow} fill="none" stroke={BLUE} strokeWidth="2" opacity="0.075" />
      <path d={paths.lineRedHigh} fill="none" stroke={RED} strokeWidth="2" opacity="0.75" />
      <path d={paths.lineBlueHigh} fill="none" stroke={BLUE} strokeWidth="2" opacity="0.75" />
      <path d={paths.point1Low} fill={RED} opacity="0.1125" />
      <path d={paths.point2Low} fill={BLUE} opacity="0.1125" />
      <path d={paths.point1High} fill={RED} opacity="0.75" />
      <path d={paths.point2High} fill={BLUE} opacity="0.75" />

      {selected !== undefined && selected.site >= startSite && selected.site <= endSite && (
        <g pointerEvents="none">
          <line x1={x(selected.site)} x2={x(selected.site)} y1={top} y2={top + plotHeight} stroke="#0d5e57" strokeWidth="1.4" strokeDasharray="3 3" />
          <circle cx={x(selected.site)} cy={y(selected.meanOmega1)} r="5" fill={RED} stroke="#fff" strokeWidth="2" />
          <circle cx={x(selected.site)} cy={y(selected.meanOmega2)} r="5" fill={BLUE} stroke="#fff" strokeWidth="2" />
        </g>
      )}
      <rect
        data-transient="true"
        x={left}
        y={top}
        width={plotWidth}
        height={plotHeight}
        fill="transparent"
        style={{ cursor: "crosshair" }}
        onPointerMove={(event) => setHovered(siteFromPointer(event))}
        onPointerLeave={() => setHovered(undefined)}
        onClick={(event) => {
          const site = siteFromPointer(event);
          if (site !== undefined) onSelectSite(site.site);
        }}
      />
      {hovered !== undefined && (
        <g data-transient="true" transform={`translate(${clamp(x(hovered.site) + 9, left + 2, width - 210)} ${top + 8})`} pointerEvents="none">
          <rect width="196" height="65" rx="5" fill="#fff" stroke="#cad3ce" />
          <text x="10" y="17" fill={INK} fontSize="11" fontWeight="700">Codon {hovered.site}</text>
          <text x="10" y="35" fill={RED} fontSize="10">{labels.group1} ω = {fixed(hovered.meanOmega1)}</text>
          <text x="10" y="51" fill={BLUE} fontSize="10">{labels.group2} ω = {fixed(hovered.meanOmega2)}</text>
        </g>
      )}
      <text x={left + plotWidth / 2} y={height - 14} textAnchor="middle" fill={INK} fontSize="16">{labels.overviewXAxis}</text>
      <text x="20" y={top + plotHeight / 2} textAnchor="middle" fill={INK} fontSize="18" transform={`rotate(-90 20 ${top + plotHeight / 2})`}>{labels.overviewYAxis}</text>
    </svg>
  );
}

interface RowFigureProps {
  readonly sites: readonly SiteResult[];
  readonly threshold: number;
  readonly labels: FigureLabels;
  readonly selectedSite?: number;
  readonly onSelectSite: (site: number) => void;
  readonly svgRef: RefObject<SVGSVGElement | null>;
}

interface MarginalMark {
  readonly site: number;
  readonly bin: number;
  readonly x: number;
  readonly y: number;
  readonly baseline: number;
  readonly width: number;
  readonly height: number;
  readonly mass: number;
}

export function PosteriorMarginalFigure({
  sites,
  threshold: _threshold,
  labels,
  selectedSite,
  onSelectSite,
  svgRef,
  marginals,
}: RowFigureProps & { readonly marginals: PosteriorMarginals }) {
  const titleId = useId();
  const [hovered, setHovered] = useState<{ site: SiteResult; bin: number }>();
  const width = 520;
  const left = 112;
  const right = 20;
  const top = 92;
  const bottom = 118;
  const rowGap = 52;
  const plotWidth = width - left - right;
  const plotHeight = Math.max(rowGap, sites.length * rowGap);
  const height = top + plotHeight + bottom;
  const bins = marginals.omegaValues.length;
  const xStep = plotWidth / Math.max(1, bins);
  const x = (bin: number): number => left + (bin + 0.5) * xStep;
  const y = (row: number): number => top + row * rowGap + rowGap / 2;
  // The Julia figure spaces sites by 0.5 units, offsets alpha/omega by ±0.1,
  // and scales each marginal mass by 0.35. These ratios reproduce that exact
  // geometry in SVG coordinates: ±20% of a row and up to 70% row thickness.
  const laneOffset = rowGap * 0.2;
  const maximumThickness = rowGap * 0.7;
  const minimumThickness = 1.15;
  // The paper panel is deliberately narrow and Plots.jl bars occupy most of
  // their categorical bin. Keeping that intrinsic width is essential: a
  // responsive full-width SVG turns the marginal into disconnected dashes.
  const barWidth = xStep * 0.8;
  const distributions = useMemo(() => {
    const alpha: MarginalMark[] = [];
    const omega1: MarginalMark[] = [];
    const omega2: MarginalMark[] = [];
    for (let row = 0; row < sites.length; row += 1) {
      const site = sites[row]!;
      const siteIndex = site.site - 1;
      for (let bin = 0; bin < bins; bin += 1) {
        const binX = x(bin);
        const center = y(row);
        const alphaMass = clamp(marginals.alpha[siteIndex * marginals.alphaValues.length + bin] ?? 0, 0, 1);
        const omega1Mass = clamp(marginals.omega1[siteIndex * bins + bin] ?? 0, 0, 1);
        const omega2Mass = clamp(marginals.omega2[siteIndex * bins + bin] ?? 0, 0, 1);
        const alphaBaseline = center - laneOffset;
        const omegaBaseline = center + laneOffset;
        const makeMark = (mass: number, baseline: number): MarginalMark => {
          const markHeight = Math.max(minimumThickness, mass * maximumThickness);
          return {
            site: site.site,
            bin,
            x: binX - barWidth / 2,
            y: baseline - markHeight / 2,
            baseline,
            width: barWidth,
            height: markHeight,
            mass,
          };
        };
        alpha.push(makeMark(alphaMass, alphaBaseline));
        omega1.push(makeMark(omega1Mass, omegaBaseline));
        omega2.push(makeMark(omega2Mass, omegaBaseline));
      }
    }
    return { alpha, omega1, omega2 };
  }, [barWidth, bins, laneOffset, marginals, maximumThickness, sites]);
  const oneBin = Array.from(marginals.omegaValues).findIndex((value) => value >= 1);

  const hoverFromPointer = (event: SvgInteractionEvent): { site: SiteResult; bin: number } | undefined => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const localX = clamp((event.clientX - bounds.left) / Math.max(1, bounds.width), 0, 0.999999);
    const localY = clamp((event.clientY - bounds.top) / Math.max(1, bounds.height), 0, 0.999999);
    const row = Math.floor(localY * sites.length);
    const bin = Math.floor(localX * bins);
    const site = sites[row];
    return site === undefined ? undefined : { site, bin };
  };

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-labelledby={titleId}
      data-layout="paper-portrait"
      data-bin-occupancy="0.8"
      style={{ ...svgStyle(), width: `${width}px`, minWidth: `${width}px`, margin: "0 auto" }}
    >
      <title id={titleId}>{labels.marginalsTitle}</title>
      <desc>For every codon, green alpha marginal mass is centered above the site line and red and blue omega marginal masses are centered below it. Rectangle thickness is proportional to posterior probability at that parameter-grid value.</desc>
      <text x={left} y="25" fill={INK} fontSize="18" fontWeight="650">{labels.marginalsTitle}</text>
      <g transform="translate(125 62)" fill={INK} fontSize="11">
        <rect x="0" y="-19" width="272" height="31" fill="#fff" stroke={INK} strokeWidth="0.8" />
        <rect x="11" y="-11" width="20" height="10" fill={RED} opacity="0.78" /><text x="38" y="-2">ω · {labels.group1}</text>
        <rect x="108" y="-11" width="20" height="10" fill={BLUE} opacity="0.78" /><text x="135" y="-2">ω · {labels.group2}</text>
        <rect x="214" y="-11" width="20" height="10" fill={GREEN} opacity="0.78" /><text x="241" y="-2">{labels.alpha}</text>
      </g>
      {oneBin >= 0 && <rect x={x(oneBin) - xStep / 2} y={top} width={xStep} height={plotHeight} fill="#8e9794" opacity="0.055" />}
      {sites.map((site, row) => (
        <g key={site.site}>
          {site.site === selectedSite && <rect x={left - 64} y={top + row * rowGap} width={plotWidth + 66} height={rowGap} fill="#eaf4f0" />}
          <text x={left - 15} y={y(row) + 4} textAnchor="end" fill={site.site === selectedSite ? "#0d5e57" : INK} fontSize="13" fontWeight={site.site === selectedSite ? "800" : "650"}>{site.site}</text>
        </g>
      ))}
      <g data-series="alpha" fill={GREEN} opacity="0.78" shapeRendering="crispEdges">
        {distributions.alpha.map((mark) => (
          <rect key={`${mark.site}-${mark.bin}`} data-site={mark.site} data-bin={mark.bin} data-baseline={mark.baseline.toFixed(2)} data-mass={mark.mass.toFixed(6)} x={mark.x} y={mark.y} width={mark.width} height={mark.height} />
        ))}
      </g>
      <g data-series="omega1" fill={RED} opacity="0.78" shapeRendering="crispEdges">
        {distributions.omega1.map((mark) => (
          <rect key={`${mark.site}-${mark.bin}`} data-site={mark.site} data-bin={mark.bin} data-baseline={mark.baseline.toFixed(2)} data-mass={mark.mass.toFixed(6)} x={mark.x} y={mark.y} width={mark.width} height={mark.height} />
        ))}
      </g>
      <g data-series="omega2" fill={BLUE} opacity="0.78" shapeRendering="crispEdges">
        {distributions.omega2.map((mark) => (
          <rect key={`${mark.site}-${mark.bin}`} data-site={mark.site} data-bin={mark.bin} data-baseline={mark.baseline.toFixed(2)} data-mass={mark.mass.toFixed(6)} x={mark.x} y={mark.y} width={mark.width} height={mark.height} />
        ))}
      </g>
      <line x1={left} x2={left} y1={top} y2={top + plotHeight} stroke={INK} strokeWidth="1.35" />
      <line x1={left} x2={left + plotWidth} y1={top + plotHeight} y2={top + plotHeight} stroke={INK} strokeWidth="1.35" />
      {Array.from(marginals.omegaValues).map((value, bin) => (
        <text key={bin} x={x(bin)} y={top + plotHeight + 20} textAnchor="end" fill={INK} fontSize="10" transform={`rotate(-90 ${x(bin)} ${top + plotHeight + 20})`}>{gridLabel(value)}</text>
      ))}
      <rect
        data-transient="true"
        x={left}
        y={top}
        width={plotWidth}
        height={plotHeight}
        fill="transparent"
        style={{ cursor: "crosshair" }}
        onPointerMove={(event) => setHovered(hoverFromPointer(event))}
        onPointerLeave={() => setHovered(undefined)}
        onClick={(event) => {
          const item = hoverFromPointer(event);
          if (item !== undefined) onSelectSite(item.site.site);
        }}
      />
      {hovered !== undefined && (() => {
        const siteIndex = hovered.site.site - 1;
        const alphaMass = marginals.alpha[siteIndex * marginals.alphaValues.length + hovered.bin] ?? 0;
        const omega1Mass = marginals.omega1[siteIndex * bins + hovered.bin] ?? 0;
        const omega2Mass = marginals.omega2[siteIndex * bins + hovered.bin] ?? 0;
        const tx = clamp(x(hovered.bin) + 8, left, width - 211);
        const row = sites.indexOf(hovered.site);
        const ty = clamp(y(row) - 73, top, top + plotHeight - 73);
        return (
          <g data-transient="true" transform={`translate(${tx} ${ty})`} pointerEvents="none">
            <rect width="202" height="70" rx="5" fill="#fff" stroke="#cad3ce" />
            <text x="10" y="16" fill={INK} fontSize="10" fontWeight="700">Codon {hovered.site.site} · grid {gridLabel(marginals.omegaValues[hovered.bin]!)}</text>
            <text x="10" y="33" fill={RED} fontSize="9">{labels.group1} ω: {fixed(omega1Mass, 4)}</text>
            <text x="10" y="48" fill={BLUE} fontSize="9">{labels.group2} ω: {fixed(omega2Mass, 4)}</text>
            <text x="10" y="63" fill={GREEN} fontSize="9">{labels.alpha}: {fixed(alphaMass, 4)}</text>
          </g>
        );
      })()}
      <text x={left + plotWidth / 2} y={height - 16} textAnchor="middle" fill={INK} fontSize="18">{labels.marginalsXAxis}</text>
      <text x="24" y={top + plotHeight / 2} textAnchor="middle" fill={INK} fontSize="19" transform={`rotate(-90 24 ${top + plotHeight / 2})`}>{labels.marginalsYAxis}</text>
    </svg>
  );
}

function EvidenceFigure({ sites, threshold, labels, selectedSite, onSelectSite, svgRef }: RowFigureProps) {
  const titleId = useId();
  const [hovered, setHovered] = useState<{ site: SiteResult; column: number }>();
  const width = 620;
  const left = 132;
  const top = 66;
  const bottom = 138;
  const rowGap = 30;
  const columnWidth = 82;
  const cellWidth = 43;
  const plotWidth = columnWidth * 4;
  const plotHeight = Math.max(rowGap, sites.length * rowGap);
  const height = top + plotHeight + bottom;
  const x = (column: number): number => left + columnWidth * (column + 0.5);
  const y = (row: number): number => top + row * rowGap + rowGap / 2;
  const columns = [
    `P(ω ${labels.group1}>ω ${labels.group2})`,
    `P(ω ${labels.group2}>ω ${labels.group1})`,
    `P(ω ${labels.group1}>1)`,
    `P(ω ${labels.group2}>1)`,
  ];
  const values = (site: SiteResult): readonly number[] => [
    site.pOmega1Greater,
    site.pOmega2Greater,
    site.pOmega1Positive,
    site.pOmega2Positive,
  ];
  const paths = useMemo(() => {
    let red = "";
    let blue = "";
    let redBase = "";
    let blueBase = "";
    for (let row = 0; row < sites.length; row += 1) {
      const probabilities = values(sites[row]!);
      for (let column = 0; column < probabilities.length; column += 1) {
        const centerX = x(column);
        const centerY = y(row);
        const intensity = clamp((probabilities[column]! - threshold) * 20, 0, 1);
        const barHeight = Math.max(1, intensity * rowGap * 0.9);
        const mark = rectPath(centerX - cellWidth / 2, centerY - barHeight / 2, cellWidth, barHeight);
        const baseline = `M${(centerX - cellWidth / 2).toFixed(2)},${centerY.toFixed(2)}h${cellWidth}`;
        if (column === 0 || column === 2) {
          red += mark;
          redBase += baseline;
        } else {
          blue += mark;
          blueBase += baseline;
        }
      }
    }
    return { red, blue, redBase, blueBase };
  }, [sites, threshold]);

  const hoverFromPointer = (event: SvgInteractionEvent): { site: SiteResult; column: number } | undefined => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const localX = clamp((event.clientX - bounds.left) / Math.max(1, bounds.width), 0, 0.999999);
    const localY = clamp((event.clientY - bounds.top) / Math.max(1, bounds.height), 0, 0.999999);
    const site = sites[Math.floor(localY * sites.length)];
    return site === undefined ? undefined : { site, column: Math.floor(localX * 4) };
  };

  return (
    <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={titleId} style={{ ...svgStyle(), minWidth: "500px" }}>
      <title id={titleId}>{labels.evidenceTitle}</title>
      <text x={left} y="29" fill={INK} fontSize="21" fontWeight="650">{labels.evidenceTitle}</text>
      {sites.map((site, row) => (
        <g key={site.site}>
          {site.site === selectedSite && <rect x={left - 75} y={top + row * rowGap} width={plotWidth + 77} height={rowGap} fill="#eaf4f0" />}
          <text x={left - 15} y={y(row) + 4} textAnchor="end" fill={site.site === selectedSite ? "#0d5e57" : INK} fontSize="11" fontWeight={site.site === selectedSite ? "800" : "600"}>{site.site}</text>
        </g>
      ))}
      <path d={paths.redBase} stroke={RED} strokeWidth="1" />
      <path d={paths.blueBase} stroke={BLUE} strokeWidth="1" />
      <path d={paths.red} fill={RED} opacity="0.82" />
      <path d={paths.blue} fill={BLUE} opacity="0.82" />
      <line x1={left} x2={left} y1={top} y2={top + plotHeight} stroke={INK} />
      <line x1={left} x2={left + plotWidth} y1={top + plotHeight} y2={top + plotHeight} stroke={INK} />
      {columns.map((label, column) => (
        <text key={label} x={x(column)} y={top + plotHeight + 18} textAnchor="end" fill={column === 0 || column === 2 ? RED : BLUE} fontSize="11" transform={`rotate(-90 ${x(column)} ${top + plotHeight + 18})`}>{label}</text>
      ))}
      <rect
        data-transient="true"
        x={left}
        y={top}
        width={plotWidth}
        height={plotHeight}
        fill="transparent"
        style={{ cursor: "crosshair" }}
        onPointerMove={(event) => setHovered(hoverFromPointer(event))}
        onPointerLeave={() => setHovered(undefined)}
        onClick={(event) => {
          const item = hoverFromPointer(event);
          if (item !== undefined) onSelectSite(item.site.site);
        }}
      />
      {hovered !== undefined && (() => {
        const row = sites.indexOf(hovered.site);
        const probability = values(hovered.site)[hovered.column]!;
        const tx = clamp(x(hovered.column) + 10, left, width - 223);
        const ty = clamp(y(row) - 51, top, top + plotHeight - 51);
        return (
          <g data-transient="true" transform={`translate(${tx} ${ty})`} pointerEvents="none">
            <rect width="214" height="48" rx="5" fill="#fff" stroke="#cad3ce" />
            <text x="10" y="17" fill={INK} fontSize="10" fontWeight="700">Codon {hovered.site.site}</text>
            <text x="10" y="34" fill={hovered.column === 0 || hovered.column === 2 ? RED : BLUE} fontSize="9">{columns[hovered.column]} = {fixed(probability, 4)}</text>
          </g>
        );
      })()}
      <text x="25" y={top + plotHeight / 2} textAnchor="middle" fill={INK} fontSize="17" transform={`rotate(-90 25 ${top + plotHeight / 2})`}>{labels.evidenceYAxis}</text>
      <text x={left} y={height - 20} fill={MUTED} fontSize="10">Bar height = clamp((posterior − {threshold.toFixed(3)}) × 20, 0, 1), matching the paper implementation.</text>
    </svg>
  );
}

function LabelEditor({ labels, onChange }: { readonly labels: FigureLabels; readonly onChange: (labels: FigureLabels) => void }) {
  const fields: readonly { key: keyof FigureLabels; label: string }[] = [
    { key: "group1", label: "Group 1 label" },
    { key: "group2", label: "Group 2 label" },
    { key: "alpha", label: "Alpha label" },
    { key: "overviewTitle", label: "Overview title" },
    { key: "overviewXAxis", label: "Overview x-axis" },
    { key: "overviewYAxis", label: "Overview y-axis" },
    { key: "marginalsTitle", label: "Distribution title" },
    { key: "marginalsXAxis", label: "Distribution x-axis" },
    { key: "marginalsYAxis", label: "Distribution y-axis" },
    { key: "evidenceTitle", label: "Evidence title" },
    { key: "evidenceYAxis", label: "Evidence y-axis" },
  ];
  return (
    <details className="figure-label-editor">
      <summary>Edit figure labels</summary>
      <div className="figure-label-grid">
        {fields.map((field) => (
          <label key={field.key}>
            <span>{field.label}</span>
            <input value={labels[field.key]} onChange={(event) => onChange({ ...labels, [field.key]: event.target.value })} />
          </label>
        ))}
      </div>
      <button type="button" className="button button--quiet" onClick={() => onChange(DEFAULT_LABELS)}>Reset labels</button>
    </details>
  );
}

export function DifFubarVisualizations({
  result,
  threshold,
  onThresholdChange,
}: {
  readonly result: DifFubarRunResult;
  readonly threshold: number;
  readonly onThresholdChange: (threshold: number) => void;
}) {
  const [activeFigure, setActiveFigure] = useState<FigureKey>("overview");
  const [startSite, setStartSite] = useState(1);
  const [endSite, setEndSite] = useState(Math.max(1, result.sites.length));
  const [rowLimit, setRowLimit] = useState(100);
  const [selectedSite, setSelectedSite] = useState<number>();
  const [labels, setLabels] = useState<FigureLabels>(DEFAULT_LABELS);
  const overviewRef = useRef<SVGSVGElement>(null);
  const marginalsRef = useRef<SVGSVGElement>(null);
  const evidenceRef = useRef<SVGSVGElement>(null);

  const detectedSites = useMemo(
    () => result.sites.filter((site) => evidenceMaximum(site) > threshold && site.site >= startSite && site.site <= endSite),
    [endSite, result.sites, startSite, threshold],
  );
  const rowSites = detectedSites.slice(0, rowLimit);
  const activeDescription = activeFigure === "overview"
    ? "All sites; significant evidence controls mark opacity exactly as in the Julia plot. Click anywhere to inspect a codon."
    : activeFigure === "marginals"
      ? "Per-site marginal mass on the fitted grid: green α above each codon, with red G1 ω and blue G2 ω below; local thickness is posterior probability."
      : "The four posterior tests from the paper; bar height is threshold-relative evidence.";

  return (
    <section className="figure-studio" aria-labelledby="figure-studio-heading">
      <div className="figure-studio__heading">
        <div>
          <p className="eyebrow">Interactive figures</p>
          <h3 id="figure-studio-heading">DifFUBAR figure studio</h3>
          <p>Linked paper-parity views with editable publication labels and native vector export.</p>
        </div>
        <div className="figure-selection">
          <span>Selected codon</span>
          <strong>{selectedSite ?? "—"}</strong>
          {selectedSite !== undefined && <button type="button" onClick={() => setSelectedSite(undefined)}>Clear</button>}
        </div>
      </div>

      <div className="figure-controls">
        <label className="figure-control figure-control--threshold">
          <span>Posterior threshold <strong>{threshold.toFixed(3)}</strong></span>
          <input type="range" min="0.5" max="0.999" step="0.001" value={threshold} onChange={(event) => onThresholdChange(Number(event.target.value))} />
        </label>
        <label className="figure-control">
          <span>First codon</span>
          <input type="number" min="1" max={endSite} value={startSite} onChange={(event) => setStartSite(clamp(Number(event.target.value), 1, endSite))} />
        </label>
        <label className="figure-control">
          <span>Last codon</span>
          <input type="number" min={startSite} max={result.sites.length} value={endSite} onChange={(event) => setEndSite(clamp(Number(event.target.value), startSite, result.sites.length))} />
        </label>
        <label className="figure-control">
          <span>Maximum rows</span>
          <select value={rowLimit} onChange={(event) => setRowLimit(Number(event.target.value))}>
            {[25, 50, 100, 250, 500].map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <div className="figure-control figure-control--summary"><span>Detected in window</span><strong>{detectedSites.length.toLocaleString()}</strong></div>
      </div>

      <LabelEditor labels={labels} onChange={setLabels} />

      <div className="figure-tabs" role="tablist" aria-label="DifFUBAR figures">
        <button type="button" role="tab" aria-selected={activeFigure === "overview"} className={activeFigure === "overview" ? "is-active" : ""} onClick={() => setActiveFigure("overview")}>ω overview</button>
        <button type="button" role="tab" aria-selected={activeFigure === "marginals"} className={activeFigure === "marginals" ? "is-active" : ""} onClick={() => setActiveFigure("marginals")}>Parameter posteriors</button>
        <button type="button" role="tab" aria-selected={activeFigure === "evidence"} className={activeFigure === "evidence" ? "is-active" : ""} onClick={() => setActiveFigure("evidence")}>Evidence matrix</button>
      </div>

      {activeFigure === "overview" && (
        <FigureShell title={labels.overviewTitle} description={activeDescription} svgRef={overviewRef}>
          <OmegaOverview
            sites={result.sites}
            startSite={startSite}
            endSite={endSite}
            threshold={threshold}
            labels={labels}
            {...(selectedSite === undefined ? {} : { selectedSite })}
            onSelectSite={setSelectedSite}
            svgRef={overviewRef}
          />
        </FigureShell>
      )}

      {activeFigure === "marginals" && (
        result.posteriorMarginals === undefined ? (
          <div className="figure-empty"><strong>Posterior distributions are unavailable for this run.</strong><span>Re-run the analysis with the current browser worker to collect compact marginal counts.</span></div>
        ) : rowSites.length === 0 ? (
          <div className="figure-empty"><strong>No sites exceed this threshold in the selected window.</strong><span>Lower the posterior threshold or widen the codon range.</span></div>
        ) : (
          <FigureShell title={labels.marginalsTitle} description={`${activeDescription}${detectedSites.length > rowSites.length ? ` Showing the first ${rowSites.length}.` : ""}`} svgRef={marginalsRef} tall>
            <PosteriorMarginalFigure
              sites={rowSites}
              threshold={threshold}
              labels={labels}
              {...(selectedSite === undefined ? {} : { selectedSite })}
              onSelectSite={setSelectedSite}
              svgRef={marginalsRef}
              marginals={result.posteriorMarginals}
            />
          </FigureShell>
        )
      )}

      {activeFigure === "evidence" && (
        rowSites.length === 0 ? (
          <div className="figure-empty"><strong>No sites exceed this threshold in the selected window.</strong><span>Lower the posterior threshold or widen the codon range.</span></div>
        ) : (
          <FigureShell title={labels.evidenceTitle} description={`${activeDescription}${detectedSites.length > rowSites.length ? ` Showing the first ${rowSites.length}.` : ""}`} svgRef={evidenceRef} tall>
            <EvidenceFigure
              sites={rowSites}
              threshold={threshold}
              labels={labels}
              {...(selectedSite === undefined ? {} : { selectedSite })}
              onSelectSite={setSelectedSite}
              svgRef={evidenceRef}
            />
          </FigureShell>
        )
      )}
    </section>
  );
}

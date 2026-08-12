import { useId, useMemo, useRef, useState } from "react";
import type { FsartAnalysisResult } from "@phylo-workbench/model-fsart/browser-source";
import { downloadSvg } from "../lib/svg-export.js";

const FONT = "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
type Metric = "consensus" | "evidence" | "g2" | "switch" | "support";

export function FsartBreakpointFigure({
  result,
  selectedRank,
  onSelectRank,
}: {
  readonly result: FsartAnalysisResult;
  readonly selectedRank: number;
  readonly onSelectRank: (rank: number) => void;
}) {
  const titleId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const [title, setTitle] = useState("Consensus breakpoint proposal landscape");
  const [metric, setMetric] = useState<Metric>("consensus");
  const [width, setWidth] = useState(1200);
  const [height, setHeight] = useState(430);
  const [showTriplets, setShowTriplets] = useState(true);
  const [showIntervals, setShowIntervals] = useState(true);
  const viterbiBreakpoints = useMemo(() => result.partition.acceptedBreakpoints, [result.partition.acceptedBreakpoints]);
  const metricValue = (signal: FsartAnalysisResult["tripletSignals"][number]): number => metric === "evidence"
    ? signal.evidence
    : metric === "g2"
      ? signal.g2
      : metric === "switch"
        ? signal.switchPosterior
        : 1;
  const mergedMetric = (breakpoint: FsartAnalysisResult["breakpoints"][number]): number => metric === "consensus"
    ? breakpoint.consensusScore ?? breakpoint.evidence
    : metric === "support" ? breakpoint.supportTriplets : metricValue(breakpoint.representative);
  const values = [...result.tripletSignals.map(metricValue), ...result.breakpoints.map(mergedMetric)].filter(Number.isFinite);
  const maximum = Math.max(1, ...values);
  const left = 72;
  const right = 28;
  const top = 66;
  const bottom = 60;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const x = (site: number): number => left + (site / Math.max(1, result.diagnostics.sites)) * plotWidth;
  const y = (value: number): number => top + plotHeight - Math.max(0, Math.min(1, value / maximum)) * plotHeight;
  const metricLabel = metric === "consensus" ? "Count + compressed-strength consensus score" : metric === "evidence" ? "−log₁₀ strongest raw scan p" : metric === "g2" ? "Triplet window G²" : metric === "switch" ? "HMM switch posterior" : "Supporting taxa triplets";
  const xTicks = 8;

  return <article className="figure-card fsart-breakpoint-card">
    <div className="figure-card__heading"><div><strong>{title}</strong><span>Thin marks are individual triplet peaks; circles aggregate independent triplet count and compressed strength. Green rings overlap a final Viterbi switch.</span></div><button type="button" className="button button--secondary button--svg" onClick={() => svgRef.current !== null && downloadSvg(svgRef.current, title)}>Export SVG</button></div>
    <div className="tree-figure-controls fsart-figure-controls">
      <label><span>Figure title</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label><span>Vertical metric</span><select value={metric} onChange={(event) => setMetric(event.target.value as Metric)}><option value="consensus">Consensus score</option><option value="support">Supporting triplets</option><option value="evidence">Strongest raw evidence</option><option value="g2">Window G²</option><option value="switch">Triplet-HMM switch posterior</option></select></label>
      <label><span>Width {width}px</span><input type="range" min="760" max="2400" step="40" value={width} onChange={(event) => setWidth(Number(event.target.value))} /></label>
      <label><span>Height {height}px</span><input type="range" min="300" max="760" step="20" value={height} onChange={(event) => setHeight(Number(event.target.value))} /></label>
      <label className="toggle"><input type="checkbox" checked={showTriplets} onChange={(event) => setShowTriplets(event.target.checked)} /><span>Triplet peaks</span></label>
      <label className="toggle"><input type="checkbox" checked={showIntervals} onChange={(event) => setShowIntervals(event.target.checked)} /><span>Intervals</span></label>
    </div>
    <div className="figure-scroll"><svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-labelledby={titleId} style={{ display: "block", minWidth: `${width}px`, background: "#fff", fontFamily: FONT }}>
      <title id={titleId}>{title}</title>
      <text x={left} y="30" fill="#172321" fontSize="19" fontWeight="650">{title}</text>
      {result.partition.segments.map((segment, index) => <rect key={segment.id} x={x(segment.start - 1)} y={top} width={Math.max(1, x(segment.end) - x(segment.start - 1))} height={plotHeight} fill={index % 2 === 0 ? "#f4f8f5" : "#faf7f0"} />)}
      {Array.from({ length: 5 }, (_, index) => index / 4).map((fraction) => {
        const value = fraction * maximum;
        return <g key={fraction}><line x1={left} x2={width - right} y1={y(value)} y2={y(value)} stroke="#e3e8e5" strokeDasharray="3 5" /><text x={left - 8} y={y(value) + 3} textAnchor="end" fill="#6c7975" fontSize="9">{value >= 100 ? value.toExponential(1) : value.toFixed(metric === "switch" ? 2 : 1)}</text></g>;
      })}
      {showTriplets && result.tripletSignals.map((signal, index) => <line key={`${signal.taxa.join("-")}-${signal.breakpoint}-${index}`} x1={x(signal.breakpoint)} x2={x(signal.breakpoint)} y1={y(metricValue(signal))} y2={top + plotHeight} stroke="#7f918b" strokeWidth="1" opacity="0.24"><title>{`${signal.taxaNames.join(" / ")} · breakpoint ${signal.breakpoint} · raw p ${signal.rawP.toPrecision(4)}`}</title></line>)}
      {viterbiBreakpoints.map((breakpoint, index) => <g key={`viterbi-${breakpoint}`}><line x1={x(breakpoint)} x2={x(breakpoint)} y1={top} y2={top + plotHeight} stroke="#138270" strokeWidth="2.2" strokeDasharray="5 4" /><text x={x(breakpoint)} y={top - 8} textAnchor="middle" fill="#126c5e" fontSize="9" fontWeight="750">{`V${index + 1}`}</text></g>)}
      {result.breakpoints.map((breakpoint) => {
        const yy = y(mergedMetric(breakpoint));
        const selected = breakpoint.rank === selectedRank;
        const nearViterbi = viterbiBreakpoints.some((value) => value >= breakpoint.supportLow && value <= breakpoint.supportHigh);
        const color = nearViterbi ? "#14806f" : "#314f74";
        return <g key={breakpoint.id} onClick={() => onSelectRank(breakpoint.rank)} style={{ cursor: "pointer" }}>
          <title>{`${breakpoint.id} · after site ${breakpoint.breakpoint} · consensus ${(breakpoint.consensusScore ?? breakpoint.evidence).toFixed(3)} · ${breakpoint.supportTriplets} triplets · ${nearViterbi ? "overlaps a Viterbi switch" : "proposal only"}`}</title>
          {showIntervals && <><rect x={x(breakpoint.supportLow)} y={top} width={Math.max(2, x(breakpoint.supportHigh) - x(breakpoint.supportLow))} height={plotHeight} fill={color} opacity="0.055" /><line x1={x(breakpoint.intervalLow)} x2={x(breakpoint.intervalHigh)} y1={yy} y2={yy} stroke={color} strokeWidth={selected ? 5 : 3} opacity="0.75" /></>}
          <line x1={x(breakpoint.breakpoint)} x2={x(breakpoint.breakpoint)} y1={yy} y2={top + plotHeight} stroke={color} strokeWidth={selected ? 2.3 : 1.4} />
          <circle cx={x(breakpoint.breakpoint)} cy={yy} r={selected ? 7 : 5} fill="#fff" stroke={color} strokeWidth={selected ? 3 : 2} />
          <text x={x(breakpoint.breakpoint)} y={Math.max(top + 11, yy - 10)} textAnchor="middle" fill={color} fontSize={selected ? 11 : 9} fontWeight="750">{breakpoint.rank}</text>
        </g>;
      })}
      {Array.from({ length: xTicks + 1 }, (_, index) => Math.round(result.diagnostics.sites * index / xTicks)).map((site) => <g key={site}><line x1={x(site)} x2={x(site)} y1={top + plotHeight} y2={top + plotHeight + 5} stroke="#43534f" /><text x={x(site)} y={top + plotHeight + 19} textAnchor="middle" fill="#5e6d69" fontSize="9">{site.toLocaleString()}</text></g>)}
      <line x1={left} x2={width - right} y1={top + plotHeight} y2={top + plotHeight} stroke="#263632" />
      <line x1={left} x2={left} y1={top} y2={top + plotHeight} stroke="#263632" />
      <text x={(left + width - right) / 2} y={height - 14} textAnchor="middle" fill="#273633" fontSize="12">Breakpoint after aligned nucleotide site</text>
      <text transform={`translate(18 ${top + plotHeight / 2}) rotate(-90)`} textAnchor="middle" fill="#273633" fontSize="12">{metricLabel}</text>
    </svg></div>
  </article>;
}

import { useId, useRef, useState } from "react";
import type { MergedBreakpoint } from "@phylo-workbench/model-fsart/browser-source";
import { downloadSvg } from "../lib/svg-export.js";

const FONT = "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
const COLORS = ["#d65a5f", "#5663d9", "#2e9278"] as const;

export function FsartTripletFigure({ breakpoint, alignmentSites }: { readonly breakpoint: MergedBreakpoint; readonly alignmentSites: number }) {
  const titleId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const [title, setTitle] = useState(`Triplet topology trace for ${breakpoint.id}`);
  const [scale, setScale] = useState(3);
  const [height, setHeight] = useState(390);
  const [showMap, setShowMap] = useState(true);
  const signal = breakpoint.representative;
  const trace = signal.trace;
  const labels = [
    `${signal.taxaNames[0]} = ${signal.taxaNames[1]}`,
    `${signal.taxaNames[0]} = ${signal.taxaNames[2]}`,
    `${signal.taxaNames[1]} = ${signal.taxaNames[2]}`,
  ];
  const left = 180;
  const right = 26;
  const top = 68;
  const bottom = 48;
  const width = Math.max(900, left + right + alignmentSites * scale);
  const plotWidth = width - left - right;
  const x = (site: number): number => left + (site / Math.max(1, alignmentSites)) * plotWidth;
  const stateY = (state: number): number => top + 28 + state * 42;
  const posteriorTop = top + 170;
  const posteriorHeight = Math.max(55, height - posteriorTop - bottom);

  return <article className="figure-card fsart-triplet-card">
    <div className="figure-card__heading"><div><strong>{title}</strong><span>Only sites at which exactly one of the three sequence pairs matches are shown. The lower track is P(hidden topology changes).</span></div><button type="button" className="button button--secondary button--svg" onClick={() => svgRef.current !== null && downloadSvg(svgRef.current, title)}>Export SVG</button></div>
    <div className="tree-figure-controls fsart-figure-controls">
      <label><span>Figure title</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label><span>Horizontal scale {scale}px/site</span><input type="range" min="1" max="12" step="1" value={scale} onChange={(event) => setScale(Number(event.target.value))} /></label>
      <label><span>Height {height}px</span><input type="range" min="320" max="650" step="10" value={height} onChange={(event) => setHeight(Number(event.target.value))} /></label>
      <label className="toggle"><input type="checkbox" checked={showMap} onChange={(event) => setShowMap(event.target.checked)} /><span>HMM MAP track</span></label>
    </div>
    <div className="figure-scroll"><svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-labelledby={titleId} style={{ display: "block", minWidth: `${width}px`, background: "#fff", fontFamily: FONT }}>
      <title id={titleId}>{title}</title>
      <text x={left} y="28" fill="#172321" fontSize="18" fontWeight="650">{title}</text>
      <rect x={x(breakpoint.intervalLow)} y={top - 8} width={Math.max(2, x(breakpoint.intervalHigh) - x(breakpoint.intervalLow))} height={height - top - bottom + 8} fill="#d88916" opacity="0.08" />
      {labels.map((label, state) => <g key={label}><line x1={left} x2={width - right} y1={stateY(state)} y2={stateY(state)} stroke="#e3e8e5" /><rect x={20} y={stateY(state) - 7} width={9} height={9} fill={COLORS[state]} /><text x={35} y={stateY(state) + 2} fill="#40504c" fontSize="9">{label}</text></g>)}
      {Array.from(trace.positions, (position, index) => {
        const state = trace.observations[index]!;
        return <circle key={`${position}-${index}`} cx={x(position)} cy={stateY(state)} r="2.7" fill={COLORS[state]} opacity="0.8"><title>{`Informative site ${position}: ${labels[state]}`}</title></circle>;
      })}
      {showMap && Array.from(trace.positions, (position, index) => {
        if (index + 1 >= trace.positions.length) return null;
        const state = trace.mapStates[index]!;
        return <rect key={`map-${index}`} x={x(position)} y={top - 3} width={Math.max(1, x(trace.positions[index + 1]!) - x(position))} height="8" fill={COLORS[state]} opacity="0.85"><title>{`MAP hidden topology: ${labels[state]}`}</title></rect>;
      })}
      <text x={left - 12} y={posteriorTop + 4} textAnchor="end" fill="#53625e" fontSize="9">P(switch)</text>
      <line x1={left} x2={width - right} y1={posteriorTop + posteriorHeight} y2={posteriorTop + posteriorHeight} stroke="#33433f" />
      {Array.from(trace.switchPosterior, (posterior, index) => {
        const x1 = x(trace.positions[index]!);
        const x2 = x(trace.positions[index + 1]!);
        const barHeight = posterior * posteriorHeight;
        return <rect key={`switch-${index}`} x={x1} y={posteriorTop + posteriorHeight - barHeight} width={Math.max(1, x2 - x1)} height={Math.max(0.5, barHeight)} fill="#d88916" opacity="0.72"><title>{`Between informative sites ${trace.positions[index]} and ${trace.positions[index + 1]}: P(switch) ${posterior.toFixed(4)}`}</title></rect>;
      })}
      <line x1={x(breakpoint.breakpoint)} x2={x(breakpoint.breakpoint)} y1={top - 12} y2={posteriorTop + posteriorHeight} stroke="#172321" strokeWidth="1.6" />
      <text x={x(breakpoint.breakpoint) + 5} y={top + 16} fill="#172321" fontSize="9">{`break after ${breakpoint.breakpoint}`}</text>
      <text x={(left + width - right) / 2} y={height - 12} textAnchor="middle" fill="#273633" fontSize="12">Aligned nucleotide site</text>
    </svg></div>
  </article>;
}

import { useId, useRef, useState } from "react";
import type { TreeHmmExplorationResult, TreeHmmResult } from "@phylo-workbench/model-fsart/browser-source";
import { downloadSvg } from "../lib/svg-export.js";

const FONT = "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";

type Inference = TreeHmmResult | TreeHmmExplorationResult;

function posteriorCurve(result: Inference, state: number, x: (site: number) => number, y: (value: number) => number, maximumPoints: number): string {
  const stride = Math.max(1, Math.ceil(result.sites / maximumPoints));
  const points: string[] = [];
  for (let start = 0; start < result.sites; start += stride) {
    const end = Math.min(result.sites, start + stride);
    let total = 0;
    for (let site = start; site < end; site += 1) total += result.statePosterior[state * result.sites + site] ?? 0;
    points.push(`${points.length === 0 ? "M" : "L"}${x((start + end) / 2).toFixed(2)},${y(total / (end - start)).toFixed(2)}`);
  }
  return points.join(" ");
}

export function FsartTreeHmmFigure({ result, defaultStyle = "bands", defaultTitle = "Topology-HMM posterior along the alignment" }: {
  readonly result: Inference;
  readonly defaultStyle?: "bands" | "curves";
  readonly defaultTitle?: string;
}) {
  const titleId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const [title, setTitle] = useState(defaultTitle);
  const [width, setWidth] = useState(1280);
  const [height, setHeight] = useState(520);
  const [showPath, setShowPath] = useState(true);
  const [showIntervals, setShowIntervals] = useState(true);
  const [plotStyle, setPlotStyle] = useState<"bands" | "curves">(defaultStyle);
  if (result.status !== "complete") return <div className="figure-empty"><strong>Tree HMM unavailable.</strong><span>{result.message ?? "Tree-HMM scoring was not completed."}</span></div>;
  const left = 82;
  const right = 30;
  const top = 78;
  const posteriorHeight = Math.max(140, height - 230);
  const switchTop = top + posteriorHeight + 52;
  const switchHeight = Math.max(55, height - switchTop - 54);
  const plotWidth = width - left - right;
  const x = (site: number): number => left + site / Math.max(1, result.sites) * plotWidth;
  const switchY = (value: number): number => switchTop + switchHeight * (1 - Math.max(0, Math.min(1, value)));
  const posteriorY = (value: number): number => top + posteriorHeight * (1 - Math.max(0, Math.min(1, value)));
  const order = Array.from({ length: result.states.length }, (_value, index) => index).sort((a, b) => result.states[b]!.occupancy - result.states[a]!.occupancy);
  const intervals = "switchIntervals" in result ? result.switchIntervals : [];

  return <article className="figure-card fsart-tree-hmm-card">
    <div className="figure-card__heading"><div><strong>{title}</strong><span>Stacked bands are marginal topology-state posteriors; the lower trace is the posterior that adjacent sites occupy different trees.</span></div><button type="button" className="button button--secondary button--svg" onClick={() => svgRef.current !== null && downloadSvg(svgRef.current, title)}>Export SVG</button></div>
    <div className="tree-figure-controls fsart-figure-controls">
      <label><span>Figure title</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label><span>Width {width}px</span><input type="range" min="800" max="2600" step="40" value={width} onChange={(event) => setWidth(Number(event.target.value))} /></label>
      <label><span>Height {height}px</span><input type="range" min="380" max="900" step="20" value={height} onChange={(event) => setHeight(Number(event.target.value))} /></label>
      <label><span>Posterior style</span><select value={plotStyle} onChange={(event) => setPlotStyle(event.target.value as "bands" | "curves")}><option value="curves">Probability curves</option><option value="bands">Stacked probability bands</option></select></label>
      <label className="toggle"><input type="checkbox" checked={showPath} onChange={(event) => setShowPath(event.target.checked)} /><span>Viterbi path strip</span></label>
      {intervals.length > 0 && <label className="toggle"><input type="checkbox" checked={showIntervals} onChange={(event) => setShowIntervals(event.target.checked)} /><span>Switch intervals</span></label>}
    </div>
    <div className="figure-scroll"><svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-labelledby={titleId} style={{ display: "block", minWidth: `${width}px`, background: "#fff", fontFamily: FONT }}>
      <title id={titleId}>{title}</title>
      <text x={left} y="30" fill="#172321" fontSize="19" fontWeight="650">{title}</text>
      {showIntervals && intervals.map((interval) => <g key={interval.rank}><rect x={x(interval.intervalLow - 1)} y={top - 10} width={Math.max(2, x(interval.intervalHigh) - x(interval.intervalLow - 1))} height={switchTop + switchHeight - top + 10} fill="#e0913c" opacity="0.08" /><line x1={x(interval.breakpoint)} x2={x(interval.breakpoint)} y1={top - 10} y2={switchTop + switchHeight} stroke="#c56f25" strokeDasharray="4 4" /><text x={x(interval.breakpoint)} y={top - 16} textAnchor="middle" fill="#a75a1f" fontSize="9" fontWeight="700">{interval.rank}</text></g>)}
      {plotStyle === "bands" && Array.from({ length: result.sites }, (_value, site) => {
        let cumulative = 0;
        const pixelWidth = Math.max(0.8, x(site + 1) - x(site) + 0.2);
        return <g key={site}>{order.map((state) => {
          const probability = result.statePosterior[state * result.sites + site] ?? 0;
          const y = top + posteriorHeight * cumulative;
          cumulative += probability;
          return <rect key={state} x={x(site)} y={y} width={pixelWidth} height={Math.max(0, posteriorHeight * probability + 0.3)} fill={result.states[state]!.color} opacity="0.9" />;
        })}</g>;
      })}
      {plotStyle === "curves" && order.map((state) => <path key={state} d={posteriorCurve(result, state, x, posteriorY, Math.min(1800, Math.round(plotWidth)))} fill="none" stroke={result.states[state]!.color} strokeWidth="1.65" opacity="0.86"><title>{`${result.states[state]!.id} marginal posterior`}</title></path>)}
      {showPath && Array.from({ length: result.sites }, (_value, site) => <rect key={site} x={x(site)} y={top + posteriorHeight + 5} width={Math.max(0.8, x(site + 1) - x(site) + 0.2)} height="9" fill={result.states[result.viterbi?.statePath[site] ?? result.mapState[site] ?? 0]?.color ?? "#999"} />)}
      <line x1={left} x2={width - right} y1={top} y2={top} stroke="#293a36" /><line x1={left} x2={width - right} y1={top + posteriorHeight} y2={top + posteriorHeight} stroke="#293a36" />
      <path d={Array.from(result.switchPosterior, (value, index) => `${index === 0 ? "M" : "L"}${x(index + 1).toFixed(2)},${switchY(value).toFixed(2)}`).join(" ")} fill="none" stroke="#bd5e2d" strokeWidth="1.8" />
      <line x1={left} x2={width - right} y1={switchTop + switchHeight} y2={switchTop + switchHeight} stroke="#293a36" />
      {[0, 0.5, 1].map((value) => <g key={value}><line x1={left - 4} x2={left} y1={switchY(value)} y2={switchY(value)} stroke="#293a36" /><text x={left - 8} y={switchY(value) + 3} textAnchor="end" fill="#5c6a66" fontSize="9">{value.toFixed(1)}</text></g>)}
      {Array.from({ length: 9 }, (_value, index) => Math.round(result.sites * index / 8)).map((site) => <g key={site}><line x1={x(site)} x2={x(site)} y1={switchTop + switchHeight} y2={switchTop + switchHeight + 5} stroke="#293a36" /><text x={x(site)} y={switchTop + switchHeight + 18} textAnchor="middle" fill="#5c6a66" fontSize="9">{site.toLocaleString()}</text></g>)}
      <text transform={`translate(20 ${top + posteriorHeight / 2}) rotate(-90)`} textAnchor="middle" fill="#273633" fontSize="11">Tree posterior</text>
      <text transform={`translate(52 ${switchTop + switchHeight / 2}) rotate(-90)`} textAnchor="middle" fill="#273633" fontSize="11">P(switch)</text>
      <text x={(left + width - right) / 2} y={height - 8} textAnchor="middle" fill="#273633" fontSize="11">Aligned nucleotide site</text>
      {result.states.map((state, index) => <g key={state.id} transform={`translate(${left + index * 138} 50)`}><rect width="12" height="12" rx="2" fill={state.color} /><text x="17" y="10" fill="#40504c" fontSize="9">{`${state.id}: ${(100 * state.occupancy).toFixed(1)}%`}</text></g>)}
    </svg></div>
  </article>;
}

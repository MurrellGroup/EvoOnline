import { useId, useRef, useState } from "react";
import type { FsartAnalysisResult } from "@phylo-workbench/model-fsart/browser-source";
import { downloadSvg } from "../lib/svg-export.js";
import { PhylogramFigure } from "./PhylogramFigure.js";

const FONT = "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
const FALLBACK_COLORS = ["#176b87", "#d5673f", "#6e56cf", "#25856f", "#bd4668", "#8a6a1f"] as const;

function downloadText(text: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function FsartPartitionFigure({ result }: { readonly result: FsartAnalysisResult }) {
  const titleId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const [title, setTitle] = useState("Refined Viterbi tree reconstruction");
  const [width, setWidth] = useState(1200);
  const partition = result.partition;
  if (partition.status !== "complete") return <div className="figure-empty"><strong>Tree reconstruction unavailable.</strong><span>{partition.message ?? "FastTree family scoring was not completed."}</span></div>;
  const height = 250;
  const left = 74;
  const right = 28;
  const top = 76;
  const trackHeight = 66;
  const plotWidth = width - left - right;
  const x = (site: number): number => left + site / Math.max(1, result.diagnostics.sites) * plotWidth;
  const segmentColor = (tree: string, index: number): string => result.treeHmm.states.find((state) => state.tree === tree)?.color ?? FALLBACK_COLORS[index % FALLBACK_COLORS.length]!;

  return <>
    <article className="figure-card fsart-partition-card">
      <div className="figure-card__heading"><div><strong>{title}</strong><span>Faint ticks are consensus proposal boundaries. Filled runs are the final minimum-length Viterbi path after bounded tree refitting; proposals are not themselves accepted breakpoints.</span></div><button type="button" className="button button--secondary button--svg" onClick={() => svgRef.current !== null && downloadSvg(svgRef.current, title)}>Export SVG</button></div>
      <div className="tree-figure-controls fsart-partition-controls"><label><span>Figure title</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label><label><span>Width {width}px</span><input type="range" min="760" max="2600" step="40" value={width} onChange={(event) => setWidth(Number(event.target.value))} /></label></div>
      <div className="figure-scroll"><svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-labelledby={titleId} style={{ display: "block", minWidth: `${width}px`, background: "#fff", fontFamily: FONT }}>
        <title id={titleId}>{title}</title>
        <text x={left} y="30" fill="#172321" fontSize="18" fontWeight="650">{title}</text>
        <text x={left} y="51" fill="#65736f" fontSize="9">{`${partition.candidateTrees.length} FastTree family fits · ${result.treeHmm.subsetSearch?.evaluatedSubsets ?? 0} cached subset hypotheses · ${result.treeHmm.refinement?.converged ? "refinement converged" : "bounded refinement"}`}</text>
        {result.breakpoints.map((breakpoint) => <line key={breakpoint.id} x1={x(breakpoint.breakpoint)} x2={x(breakpoint.breakpoint)} y1={top - 8} y2={top + trackHeight + 8} stroke="#778985" strokeDasharray="2 4" opacity="0.34"><title>{`${breakpoint.id} consensus proposal after site ${breakpoint.breakpoint}`}</title></line>)}
        {partition.segments.map((segment, index) => {
          const color = segmentColor(segment.tree, index);
          const startX = x(segment.start - 1);
          const endX = x(segment.end);
          return <g key={segment.id}><rect x={startX} y={top} width={Math.max(2, endX - startX)} height={trackHeight} rx="3" fill={color} opacity="0.82"><title>{`${segment.id}: ${segment.start}–${segment.end}; log L ${segment.logLikelihood.toFixed(2)}`}</title></rect><text x={(startX + endX) / 2} y={top + 28} textAnchor="middle" fill="#fff" fontSize="10" fontWeight="750">{segment.id}</text><text x={(startX + endX) / 2} y={top + 45} textAnchor="middle" fill="#fff" fontSize="8">{`${segment.start}–${segment.end}`}</text></g>;
        })}
        {partition.acceptedBreakpoints.map((breakpoint, index) => <g key={breakpoint}><line x1={x(breakpoint)} x2={x(breakpoint)} y1={top - 15} y2={top + trackHeight + 15} stroke="#102f2a" strokeWidth="2" /><text x={x(breakpoint)} y={top - 20} textAnchor="middle" fill="#154d43" fontSize="9" fontWeight="750">{`V${index + 1}: ${breakpoint}`}</text></g>)}
        <line x1={left} x2={width - right} y1={top + trackHeight + 18} y2={top + trackHeight + 18} stroke="#30413d" />
        {Array.from({ length: 9 }, (_value, index) => Math.round(result.diagnostics.sites * index / 8)).map((site) => <g key={site}><line x1={x(site)} x2={x(site)} y1={top + trackHeight + 18} y2={top + trackHeight + 23} stroke="#30413d" /><text x={x(site)} y={top + trackHeight + 38} textAnchor="middle" fill="#5d6c68" fontSize="9">{site.toLocaleString()}</text></g>)}
        <text x={(left + width - right) / 2} y={height - 16} textAnchor="middle" fill="#273633" fontSize="11">Aligned nucleotide site</text>
      </svg></div>
    </article>
    <div className="fsart-segment-grid">{partition.segments.map((segment, index) => <details className="result-panel fsart-segment" key={segment.id} open={index === 0}><summary><span>{`Viterbi run ${index + 1}: ${segment.start}–${segment.end}`}</span><small>{`log L ${segment.logLikelihood.toFixed(2)} · ${segment.variableSites} variable sites`}</small></summary><div className="result-panel__body"><div className="result-toolbar"><span>{segment.end - segment.start + 1} aligned sites · selected topology</span><button type="button" className="button button--secondary" onClick={() => downloadText(segment.tree, `fsart-viterbi-run-${segment.start}-${segment.end}.nwk`)}>Newick</button></div><PhylogramFigure newick={segment.tree} tagged={false} /></div></details>)}</div>
  </>;
}

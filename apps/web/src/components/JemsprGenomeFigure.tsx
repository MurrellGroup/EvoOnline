import { useId, useRef, useState } from "react";
import type { JemsprNetworkResult } from "@phylo-workbench/model-jemspr/browser-source";
import { downloadSvg } from "../lib/svg-export.js";

const FONT = "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
const INK = "#172321";

export function JemsprGenomeFigure({ result, sites }: { readonly result: JemsprNetworkResult; readonly sites: number }) {
  const titleId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const [title, setTitle] = useState("JEMSPR coherent event history");
  const [width, setWidth] = useState(1280);
  const [laneHeight, setLaneHeight] = useState(24);
  const [labelSize, setLabelSize] = useState(10);
  const [showMasks, setShowMasks] = useState(true);
  const left = 126;
  const right = 34;
  const stripTop = 80;
  const eventsTop = 132;
  const height = Math.max(250, eventsTop + Math.max(1, result.templates.length) * laneHeight + 70);
  const x = (site: number): number => left + Math.max(0, Math.min(sites, site)) / Math.max(1, sites) * (width - left - right);
  const treeById = new Map(result.trees.map((tree) => [tree.id, tree]));
  const occurrencesByTemplate = new Map(result.templates.map((template) => [template.id, result.occurrences.filter((occurrence) => occurrence.templateId === template.id)]));

  return <article className="figure-card">
    <div className="figure-card__heading"><div><strong>{title}</strong><span>Tree blocks and persistent event-template intervals are decoded jointly; overlapping rectangles are simultaneously active reticulations.</span></div><button type="button" className="button button--secondary button--svg" onClick={() => svgRef.current !== null && downloadSvg(svgRef.current, title)}>Export SVG</button></div>
    <div className="tree-figure-controls">
      <label><span>Figure title</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label><span>Width {width}px</span><input type="range" min="800" max="2600" step="50" value={width} onChange={(event) => setWidth(Number(event.target.value))} /></label>
      <label><span>Event spacing {laneHeight}px</span><input type="range" min="18" max="42" step="1" value={laneHeight} onChange={(event) => setLaneHeight(Number(event.target.value))} /></label>
      <label><span>Label size {labelSize}px</span><input type="range" min="7" max="18" step="1" value={labelSize} onChange={(event) => setLabelSize(Number(event.target.value))} /></label>
      <label className="toggle"><input type="checkbox" checked={showMasks} onChange={(event) => setShowMasks(event.target.checked)} /><span>Mask labels</span></label>
    </div>
    <div className="figure-scroll"><svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-labelledby={titleId} style={{ display: "block", minWidth: `${Math.min(width, 850)}px`, background: "#fff", fontFamily: FONT }}>
      <title id={titleId}>{title}</title><rect width={width} height={height} fill="#fff" />
      <text x={left} y="30" fill={INK} fontSize="20" fontWeight="680">{title}</text>
      <text x={left} y="48" fill="#65736f" fontSize="9">Translucent endpoint bands are fixed-network directional min-marginal ranges; open-edge events are censored at an alignment boundary.</text>
      <text x={left - 12} y={stripTop + 16} textAnchor="end" fill={INK} fontSize={labelSize} fontWeight="700">Implied tree</text>
      {result.runs.map((run) => { const tree = treeById.get(run.treeId); return <g key={run.id}><rect x={x(run.start - 1)} y={stripTop} width={Math.max(2, x(run.end) - x(run.start - 1))} height="24" fill={tree?.color ?? "#6f7d79"} stroke="#fff" strokeWidth="1"><title>{`${run.start}–${run.end}: ${run.treeId}; mask ${run.mask}`}</title></rect>{x(run.end) - x(run.start - 1) > 50 && <text x={(x(run.start - 1) + x(run.end)) / 2} y={stripTop + 16} textAnchor="middle" fill="#fff" fontSize="8" fontWeight="750">{`${run.treeId}${showMasks ? ` · ${run.mask.toString(2).padStart(result.templates.length, "0")}` : ""}`}</text>}</g>; })}
      {result.templates.map((template, index) => {
        const y = eventsTop + index * laneHeight;
        return <g key={template.id}><text x={left - 12} y={y + 13} textAnchor="end" fill={INK} fontSize={labelSize} fontWeight="700">{template.id}</text><line x1={left} x2={width - right} y1={y + 9} y2={y + 9} stroke="#d8e0dd" strokeWidth="1" />{occurrencesByTemplate.get(template.id)?.map((occurrence) => <g key={occurrence.id}><rect x={x(occurrence.openingIntervalLow - 1)} y={y + 2} width={Math.max(2, x(occurrence.openingIntervalHigh) - x(occurrence.openingIntervalLow - 1))} height="14" fill="#f2a900" opacity="0.18"><title>{`Opening range ${occurrence.openingIntervalLow}–${occurrence.openingIntervalHigh}`}</title></rect><rect x={x(occurrence.closingIntervalLow - 1)} y={y + 2} width={Math.max(2, x(occurrence.closingIntervalHigh) - x(occurrence.closingIntervalLow - 1))} height="14" fill="#f2a900" opacity="0.18"><title>{`Closing range ${occurrence.closingIntervalLow}–${occurrence.closingIntervalHigh}`}</title></rect><rect x={x(occurrence.start - 1)} y={y + 1} width={Math.max(3, x(occurrence.end) - x(occurrence.start - 1))} height="16" rx="3" fill="#f2a900" opacity="0.86" stroke="#765900" strokeWidth="0.8"><title>{`${occurrence.id}: ${occurrence.start}–${occurrence.end}; overlap ${occurrence.maximumConcurrentEvents}; endpoint ranges ${occurrence.openingIntervalLow}–${occurrence.openingIntervalHigh} / ${occurrence.closingIntervalLow}–${occurrence.closingIntervalHigh}`}</title></rect>{occurrence.leftCensored && <path d={`M${x(occurrence.start - 1)},${y + 1} l-7,8 l7,8`} fill="#f2a900" stroke="#765900" />}{occurrence.rightCensored && <path d={`M${x(occurrence.end)},${y + 1} l7,8 l-7,8`} fill="#f2a900" stroke="#765900" />}{x(occurrence.end) - x(occurrence.start - 1) > 38 && <text x={(x(occurrence.start - 1) + x(occurrence.end)) / 2} y={y + 13} textAnchor="middle" fill="#302500" fontSize="8" fontWeight="750">{occurrence.id}</text>}</g>)}</g>;
      })}
      {result.breakpointGaps.map((entry) => <g key={entry.afterSite}><line x1={x(entry.afterSite)} x2={x(entry.afterSite)} y1={stripTop - 8} y2={height - 48} stroke="#c34545" strokeWidth="0.8" strokeDasharray="3 3" opacity="0.65" /><path d={`M${x(entry.afterSite) - 5},${stripTop - 10} l5,-7 l5,7 z`} fill="#c34545"><title>{`Boundary ${entry.intervalLow}–${entry.intervalHigh}; min-marginal gap ${entry.gap.toFixed(3)}`}</title></path><text x={x(entry.afterSite)} y={stripTop - 22} textAnchor="middle" fill="#8e3030" fontSize="7">Δ {entry.gap.toFixed(2)}</text></g>)}
      <line x1={left} x2={width - right} y1={height - 39} y2={height - 39} stroke={INK} />
      {[0, .25, .5, .75, 1].map((fraction) => { const site = Math.max(1, Math.round(sites * fraction)); return <g key={fraction}><line x1={x(site)} x2={x(site)} y1={height - 39} y2={height - 34} stroke={INK} /><text x={x(site)} y={height - 20} textAnchor="middle" fill="#5e6c68" fontSize="8">{site.toLocaleString()}</text></g>; })}
      <text x={(left + width - right) / 2} y={height - 5} textAnchor="middle" fill={INK} fontSize="10" fontWeight="650">Aligned nucleotide position</text>
    </svg></div>
  </article>;
}

import React, { useRef } from "react";
import type { SimulatedDataset } from "@phylo-workbench/model-simulator/browser-source";
import { downloadSvg } from "../../lib/svg-export.js";

const SEGMENT_COLORS = ["#167a70", "#d8644b", "#416eb5", "#b68128", "#7755c8", "#56a86c", "#d5538d", "#698a3d"];

export function RecombinationTruthFigure({ dataset, sites }: { readonly dataset: SimulatedDataset; readonly sites: number }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const visible = dataset.recombinationEvents.filter((event) => event.visibleAfterSubsampling);
  const width = 960;
  const left = 70;
  const right = 930;
  const plotWidth = right - left;
  const hotspotMax = Math.max(1, ...dataset.hotspotWeights);
  const eventRows = Math.max(1, dataset.recombinationEvents.length);
  const height = 150 + eventRows * 20;
  const x = (codon: number): number => left + plotWidth * (codon - 1) / Math.max(1, sites - 1);
  return <article className="figure-card sim-recomb-truth"><div className="figure-card__heading"><div><strong>Known recombination history</strong><span>{dataset.recombinationEvents.length} branch-interior events; {visible.length} alter the observed-tip genealogy after carrier-tree subsampling.</span></div><button type="button" className="button button--secondary" onClick={() => svgRef.current && downloadSvg(svgRef.current, "simulated recombination truth")}>Export SVG</button></div><div className="figure-scroll"><svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} style={{ minWidth: 720 }}>
    <text x={left} y="17" fontSize="9" fill="#40524d">Breakpoint intensity</text><path d={dataset.hotspotWeights.map((value, index) => `${index === 0 ? "M" : "L"}${x(index + 1)},${62 - 36 * value / hotspotMax}`).join(" ")} fill="none" stroke="#b68128" strokeWidth="1.5" /><line x1={left} x2={right} y1="64" y2="64" stroke="#aeb9b5" />
    <text x={left} y="86" fontSize="9" fill="#40524d">Local genealogy</text>{dataset.localTrees.map((region, index) => <g key={`${region.startCodon}-${region.endCodon}`}><rect x={x(region.startCodon)} y="92" width={Math.max(1, x(region.endCodon + 1) - x(region.startCodon))} height="15" fill={SEGMENT_COLORS[index % SEGMENT_COLORS.length]}><title>Codons {region.startCodon}–{region.endCodon}; events {region.activeEventIds.join(", ") || "none"}</title></rect><text x={(x(region.startCodon) + x(region.endCodon)) / 2} y="103" textAnchor="middle" fontSize="6" fill="#fff">T{index + 1}</text></g>)}
    {dataset.recombinationEvents.map((event, row) => <g key={event.id}><text x={left - 8} y={128 + row * 20} textAnchor="end" fontSize="7" fill={event.visibleAfterSubsampling ? "#344843" : "#9aa5a1"}>E{event.id}</text><line x1={left} x2={right} y1={125 + row * 20} y2={125 + row * 20} stroke="#edf0ed" />{event.intervals.map((interval, index) => <rect key={index} x={x(interval.startCodon)} y={119 + row * 20} width={Math.max(2, x(interval.endCodon + 1) - x(interval.startCodon))} height="12" rx="2" fill={event.visibleAfterSubsampling ? "#d8644b" : "#c4ccc8"}><title>Event {event.id}, age {event.age.toPrecision(4)}, codons {interval.startCodon}–{interval.endCodon}</title></rect>)}<text x={right + 5} y={128 + row * 20} fontSize="6" fill="#76847f">t={event.age.toPrecision(3)}</text></g>)}
    {[0, 0.25, 0.5, 0.75, 1].map((fraction) => <g key={fraction}><line x1={left + plotWidth * fraction} x2={left + plotWidth * fraction} y1={height - 22} y2={height - 16} stroke="#5f6e69" /><text x={left + plotWidth * fraction} y={height - 6} textAnchor="middle" fontSize="7">{Math.max(1, Math.round(1 + fraction * (sites - 1)))}</text></g>)}<text x={(left + right) / 2} y={height - 1} textAnchor="middle" fontSize="8">codon position</text>
  </svg></div></article>;
}

import React, { useId, useMemo, useRef, useState } from "react";
import type { SimulatedTree } from "@phylo-workbench/model-simulator/browser-source";
import { downloadSvg } from "../../lib/svg-export.js";

interface Layout { readonly x: number; readonly y: number }

export function treeTipOrder(tree: SimulatedTree): readonly number[] {
  const output: number[] = [];
  const visit = (id: number): void => { const node = tree.nodes[id]!; if (node.children.length === 0) output.push(id); else for (const child of node.children) visit(child); };
  visit(tree.root);
  return output;
}

export function timeTreeLayout(tree: SimulatedTree, left: number, right: number, top: number, rowHeight: number): ReadonlyMap<number, Layout> {
  const map = new Map<number, Layout>();
  let tipRow = 0;
  const x = (time: number): number => left + (tree.height - time) / Math.max(tree.height, 1e-12) * (right - left);
  const visit = (id: number): number => {
    const node = tree.nodes[id]!;
    const y = node.children.length === 0 ? top + tipRow++ * rowHeight : node.children.map(visit).reduce((sum, value) => sum + value, 0) / node.children.length;
    map.set(id, { x: x(node.time), y });
    return y;
  };
  visit(tree.root);
  return map;
}

export function TimeTreeFigure({ tree, initialTitle = "Sampled genealogy", compact = false }: { readonly tree: SimulatedTree; readonly initialTitle?: string; readonly compact?: boolean }) {
  const titleId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const [title, setTitle] = useState(initialTitle);
  const [showLabels, setShowLabels] = useState(!compact);
  const [rowHeight, setRowHeight] = useState(compact ? 10 : 17);
  const width = compact ? 560 : 980;
  const left = 58;
  const right = showLabels ? width - 190 : width - 32;
  const top = compact ? 24 : 50;
  const bottom = compact ? 30 : 44;
  const height = Math.max(compact ? 100 : 180, top + bottom + Math.max(1, tree.tips.length - 1) * rowHeight);
  const layout = useMemo(() => timeTreeLayout(tree, left, right, top, rowHeight), [tree, left, right, top, rowHeight]);
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  return <article className={`sim-time-tree ${compact ? "is-compact" : ""}`}>
    {!compact && <div className="sim-figure-heading"><label>Figure title <input value={title} onChange={(event) => setTitle(event.target.value)} /></label><label className="toggle"><input type="checkbox" checked={showLabels} onChange={(event) => setShowLabels(event.target.checked)} /><span>Tip labels</span></label><label>Tip spacing <input type="range" min="10" max="28" value={rowHeight} onChange={(event) => setRowHeight(Number(event.target.value))} /></label><button type="button" className="button button--secondary" onClick={() => svgRef.current !== null && downloadSvg(svgRef.current, title)}>Export SVG</button></div>}
    <div className="figure-scroll"><svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={titleId} style={{ minWidth: compact ? 460 : 720 }}><title id={titleId}>{title}</title>{!compact && <text x={left} y="25" fontSize="18" fontWeight="650" fill="#172321">{title}</text>}
      {tree.nodes.filter((node) => node.children.length > 1).map((node) => { const position = layout.get(node.id)!; const childYs = node.children.map((child) => layout.get(child)!.y); return <line key={`v-${node.id}`} x1={position.x} x2={position.x} y1={Math.min(...childYs)} y2={Math.max(...childYs)} stroke="#52635f" strokeWidth="1" />; })}
      {tree.nodes.filter((node) => node.parent !== null).map((node) => { const here = layout.get(node.id)!; const parent = layout.get(node.parent!)!; return <line key={`h-${node.id}`} x1={parent.x} x2={here.x} y1={here.y} y2={here.y} stroke="#263936" strokeWidth="1.35" />; })}
      {tree.tips.map((tip) => { const point = layout.get(tip)!; const node = tree.nodes[tip]!; return <g key={`tip-${tip}`}><circle cx={point.x} cy={point.y} r="1.7" fill="#167a70" />{node.time > 1e-10 && <line x1={point.x} x2={right} y1={point.y} y2={point.y} stroke="#b7c3be" strokeDasharray="2 3" />}{showLabels && <text x={right + 7} y={point.y + 3.2} fontSize={compact ? 6 : 9} fill="#354742">{node.name}</text>}</g>; })}
      <line x1={left} x2={right} y1={height - bottom + 8} y2={height - bottom + 8} stroke="#56655f" />{ticks.map((fraction) => { const x = left + fraction * (right - left); const age = tree.height * (1 - fraction); return <g key={fraction}><line x1={x} x2={x} y1={height - bottom + 4} y2={height - bottom + 12} stroke="#56655f" /><text x={x} y={height - bottom + 24} textAnchor="middle" fontSize="7" fill="#687873">{age.toPrecision(3)}</text></g>; })}<text x={(left + right) / 2} y={height - 4} textAnchor="middle" fontSize="8" fill="#52635f">time before most recent sample</text>
    </svg></div>
  </article>;
}

import { useId, useMemo, useRef, useState } from "react";
import { downloadSvg } from "../lib/svg-export.js";

const FONT = "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
const INK = "#172321";

interface JsonNode { readonly id: string; readonly kind: string; readonly leaf?: number; readonly parents: readonly string[]; readonly children: readonly string[] }
interface JsonReticulation { readonly bit: number; readonly reticulationNode: string; readonly backgroundParentNode: string; readonly alternateParentNode: string }
interface NetworkJson { readonly taxaNames: readonly string[]; readonly switchingNetwork: { readonly root: string; readonly nodes: readonly JsonNode[]; readonly reticulations: readonly JsonReticulation[] } }

export function JemsprNetworkDagFigure({ networkJson }: { readonly networkJson: string }) {
  const titleId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const [title, setTitle] = useState("JEMSPR switching network");
  const [width, setWidth] = useState(1120);
  const [rowHeight, setRowHeight] = useState(28);
  const [labelSize, setLabelSize] = useState(10);
  const [showNodeIds, setShowNodeIds] = useState(false);
  const parsed = useMemo(() => {
    try { return { value: JSON.parse(networkJson) as NetworkJson } as const; }
    catch (error) { return { error: error instanceof Error ? error.message : String(error) } as const; }
  }, [networkJson]);
  if ("error" in parsed) return <div className="figure-empty"><strong>Switching-network diagram unavailable.</strong><span>{parsed.error}</span></div>;
  const data = parsed.value;
  const nodes = data.switchingNetwork.nodes;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const depth = new Map<string, number>([[data.switchingNetwork.root, 0]]);
  for (let pass = 0; pass < nodes.length; pass += 1) for (const node of nodes) {
    const current = depth.get(node.id);
    if (current === undefined) continue;
    for (const child of node.children) depth.set(child, Math.max(depth.get(child) ?? 0, current + 1));
  }
  const maximumDepth = Math.max(1, ...depth.values());
  const descendantMemo = new Map<string, Set<number>>();
  const descendants = (id: string, visiting = new Set<string>()): Set<number> => {
    const memo = descendantMemo.get(id);
    if (memo !== undefined) return memo;
    if (visiting.has(id)) return new Set();
    const nextVisiting = new Set(visiting).add(id);
    const node = byId.get(id);
    const values = node?.leaf === undefined ? new Set<number>() : new Set([node.leaf]);
    for (const child of node?.children ?? []) for (const leaf of descendants(child, nextVisiting)) values.add(leaf);
    descendantMemo.set(id, values);
    return values;
  };
  const left = 48;
  const right = Math.min(330, Math.max(150, ...data.taxaNames.map((name) => name.length * labelSize * .6))) + 30;
  const top = 88;
  const height = Math.max(210, top + Math.max(1, data.taxaNames.length - 1) * rowHeight + 52);
  const x = (id: string): number => left + (depth.get(id) ?? 0) / maximumDepth * (width - left - right);
  const y = (id: string): number => {
    const leaves = [...descendants(id)];
    return top + (leaves.length === 0 ? 0 : leaves.reduce((sum, leaf) => sum + leaf, 0) / leaves.length) * rowHeight;
  };
  const alternateEdges = new Set(data.switchingNetwork.reticulations.map((event) => `${event.alternateParentNode}>${event.reticulationNode}`));
  const backgroundEdges = new Set(data.switchingNetwork.reticulations.map((event) => `${event.backgroundParentNode}>${event.reticulationNode}`));
  const reticByNode = new Map(data.switchingNetwork.reticulations.map((event) => [event.reticulationNode, event]));
  return <article className="figure-card">
    <div className="figure-card__heading"><div><strong>{title}</strong><span>Every reticulation has an ordered background parent and alternate parent; choosing one incoming edge per reticulation displays the decoded local trees.</span></div><button type="button" className="button button--secondary button--svg" onClick={() => svgRef.current !== null && downloadSvg(svgRef.current, title)}>Export SVG</button></div>
    <div className="tree-figure-controls"><label><span>Figure title</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label><label><span>Width {width}px</span><input type="range" min="700" max="2200" step="50" value={width} onChange={(event) => setWidth(Number(event.target.value))} /></label><label><span>Tip spacing {rowHeight}px</span><input type="range" min="16" max="48" value={rowHeight} onChange={(event) => setRowHeight(Number(event.target.value))} /></label><label><span>Label size {labelSize}px</span><input type="range" min="7" max="18" value={labelSize} onChange={(event) => setLabelSize(Number(event.target.value))} /></label><label className="toggle"><input type="checkbox" checked={showNodeIds} onChange={(event) => setShowNodeIds(event.target.checked)} /><span>Node IDs</span></label></div>
    <div className="figure-scroll figure-scroll--tall"><svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-labelledby={titleId} style={{ display: "block", minWidth: `${Math.min(width, 780)}px`, background: "#fff", fontFamily: FONT }}><title id={titleId}>{title}</title><rect width={width} height={height} fill="#fff" /><text x={left} y="28" fill={INK} fontSize="19" fontWeight="680">{title}</text><g transform={`translate(${left} 55)`} fontSize="9" fill={INK}><line x1="0" x2="28" stroke="#56645f" strokeWidth="1.5" /><text x="34" y="3">Tree edge</text><line x1="104" x2="132" stroke="#177f72" strokeWidth="2.5" /><text x="138" y="3">Background parent</text><line x1="265" x2="293" stroke="#d46d35" strokeWidth="2.5" strokeDasharray="5 3" /><text x="299" y="3">Alternate parent</text></g>
      {nodes.flatMap((node) => node.children.map((child) => { const key = `${node.id}>${child}`; const alternate = alternateEdges.has(key); const background = backgroundEdges.has(key); const x1 = x(node.id); const x2 = x(child); const y1 = y(node.id); const y2 = y(child); const control = (x1 + x2) / 2; return <path key={key} d={`M${x1},${y1} C${control},${y1} ${control},${y2} ${x2},${y2}`} fill="none" stroke={alternate ? "#d46d35" : background ? "#177f72" : "#56645f"} strokeWidth={alternate || background ? 2.4 : 1.25} strokeDasharray={alternate ? "5 3" : undefined} opacity={alternate ? .95 : .82}><title>{key}</title></path>; }))}
      {nodes.map((node) => { const reticulation = reticByNode.get(node.id); const cx = x(node.id); const cy = y(node.id); return <g key={node.id}>{node.kind === "reticulation" ? <><circle cx={cx} cy={cy} r="6" fill="#fff" stroke="#b56b1c" strokeWidth="2.2" /><text x={cx} y={cy + 3} textAnchor="middle" fill="#7c4108" fontSize="7" fontWeight="800">{`R${(reticulation?.bit ?? 0) + 1}`}</text></> : node.kind === "attachment" || (node.kind === "root" && node.parents.length > 0) ? <rect x={cx - 3.5} y={cy - 3.5} width="7" height="7" transform={`rotate(45 ${cx} ${cy})`} fill="#d46d35" /> : <circle cx={cx} cy={cy} r={node.kind === "leaf" ? 2 : 2.8} fill={node.kind === "root" ? INK : "#56645f"} />}{showNodeIds && node.kind !== "leaf" && <text x={cx + 6} y={cy - 5} fill="#6a7773" fontSize="7">{node.id}</text>}{node.leaf !== undefined && <text x={cx + 7} y={cy + labelSize * .34} fill={INK} fontSize={labelSize}>{data.taxaNames[node.leaf] ?? `taxon ${node.leaf + 1}`}</text>}</g>; })}
      <text x={left} y={height - 12} fill="#65736f" fontSize="8">Horizontal position is topological rank, not fitted time. Temporal status tests equality-contracted rank feasibility separately.</text>
    </svg></div>
  </article>;
}

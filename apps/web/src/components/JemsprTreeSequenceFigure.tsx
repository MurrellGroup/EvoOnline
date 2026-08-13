import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { JemsprMaskRun, JemsprNetworkResult, JemsprNetworkTree } from "@phylo-workbench/model-jemspr/browser-source";
import { downloadSvg } from "../lib/svg-export.js";
import { alignComparisonTrees, type ComparisonTreeLayout, type ComparisonTreeNode } from "../lib/tree-comparison.js";

const FONT = "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
const INK = "#172321";

interface PositionedNode { readonly x: number; readonly y: number; readonly node: ComparisonTreeNode }
interface PositionedTree { readonly nodes: readonly PositionedNode[]; readonly byName: ReadonlyMap<string, PositionedNode>; readonly byId: ReadonlyMap<string, PositionedNode> }

function positionTree(layout: ComparisonTreeLayout, rootX: number, tipX: number, top: number, rowHeight: number): PositionedTree {
  const ranks = new Map(layout.tipOrder.map((name, index) => [name, index]));
  const raw = new Map<ComparisonTreeNode, { depth: number; y: number }>();
  let maximumDepth = 0;
  const visit = (node: ComparisonTreeNode, depth: number): number => {
    maximumDepth = Math.max(maximumDepth, depth);
    const y = node.children.length === 0 ? ranks.get(node.name) ?? 0 : node.children.map((child) => visit(child, depth + 1)).reduce((sum, value, _index, values) => sum + value / values.length, 0);
    raw.set(node, { depth, y });
    return y;
  };
  visit(layout.root, 0);
  const nodes: PositionedNode[] = [];
  const byName = new Map<string, PositionedNode>();
  const byId = new Map<string, PositionedNode>();
  const collect = (node: ComparisonTreeNode): void => {
    const value = raw.get(node)!;
    const positioned = { x: rootX + (tipX - rootX) * value.depth / Math.max(1, maximumDepth), y: top + value.y * rowHeight, node };
    nodes.push(positioned);
    byId.set(node.id, positioned);
    if (node.children.length === 0) byName.set(node.name, positioned);
    for (const child of node.children) collect(child);
  };
  collect(layout.root);
  return { nodes, byName, byId };
}

function Branches({ tree, color }: { readonly tree: PositionedTree; readonly color: string }) {
  return <g>{tree.nodes.map(({ node, x, y }) => {
    if (node.children.length === 0) return <circle key={node.id} cx={x} cy={y} r="1.5" fill={color} />;
    const children = node.children.map((child) => tree.byId.get(child.id)!);
    return <g key={node.id}><line x1={x} x2={x} y1={Math.min(...children.map((child) => child.y))} y2={Math.max(...children.map((child) => child.y))} stroke={color} strokeWidth="1.2" />{children.map((child) => <line key={child.node.id} x1={x} x2={child.x} y1={child.y} y2={child.y} stroke={color} strokeWidth="1.2" />)}<circle cx={x} cy={y} r="1.3" fill={color} /></g>;
  })}</g>;
}

function PairView({ layouts, runs, trees, width, top, rowHeight, labelSize, showLabels, showConnections, highlightChanges }: {
  readonly layouts: readonly ComparisonTreeLayout[]; readonly runs: readonly JemsprMaskRun[]; readonly trees: readonly JemsprNetworkTree[]; readonly width: number; readonly top: number; readonly rowHeight: number; readonly labelSize: number; readonly showLabels: boolean; readonly showConnections: boolean; readonly highlightChanges: boolean;
}) {
  const center = width / 2;
  const gutter = Math.min(200, Math.max(90, ...layouts[0]!.tipOrder.map((name) => name.length * labelSize * .58)));
  const leftTip = center - gutter - 42;
  const rightTip = center + gutter + 42;
  const first = positionTree(layouts[0]!, 42, leftTip, top, rowHeight);
  const second = positionTree(layouts[1]!, width - 42, rightTip, top, rowHeight);
  return <g>
    <text x="42" y={top - 22} fill={trees[0]!.color} fontSize="11" fontWeight="750">{`${runs[0]!.start}–${runs[0]!.end} · ${trees[0]!.id}`}</text>
    <text x={width - 42} y={top - 22} textAnchor="end" fill={trees[1]!.color} fontSize="11" fontWeight="750">{`${runs[1]!.start}–${runs[1]!.end} · ${trees[1]!.id}`}</text>
    {showConnections && layouts[0]!.tipOrder.map((name) => { const a = first.byName.get(name)!; const b = second.byName.get(name)!; const changed = Math.abs(a.y - b.y) > .1; return <line key={name} x1={leftTip + (showLabels ? gutter + 8 : 8)} x2={rightTip - (showLabels ? gutter + 8 : 8)} y1={a.y} y2={b.y} stroke={changed && highlightChanges ? "#d46d35" : "#77837f"} strokeWidth={changed ? 1.2 : .8} strokeDasharray="3 3" opacity={changed ? .75 : .4}><title>{name}</title></line>; })}
    <Branches tree={first} color={trees[0]!.color} /><Branches tree={second} color={trees[1]!.color} />
    {showLabels && layouts[0]!.tipOrder.map((name) => <text key={`l-${name}`} x={leftTip + 5} y={first.byName.get(name)!.y + labelSize * .34} fill={INK} fontSize={labelSize}>{name}</text>)}
    {showLabels && layouts[1]!.tipOrder.map((name) => <text key={`r-${name}`} x={rightTip - 5} y={second.byName.get(name)!.y + labelSize * .34} textAnchor="end" fill={INK} fontSize={labelSize}>{name}</text>)}
  </g>;
}

function SequenceView({ layouts, runs, trees, width, left, right, top, rowHeight, labelSize, showLabels, everyLabel, showConnections, highlightChanges }: {
  readonly layouts: readonly ComparisonTreeLayout[]; readonly runs: readonly JemsprMaskRun[]; readonly trees: readonly JemsprNetworkTree[]; readonly width: number; readonly left: number; readonly right: number; readonly top: number; readonly rowHeight: number; readonly labelSize: number; readonly showLabels: boolean; readonly everyLabel: boolean; readonly showConnections: boolean; readonly highlightChanges: boolean;
}) {
  const panelWidth = (width - left - right) / Math.max(1, layouts.length);
  const positioned = layouts.map((layout, index) => positionTree(layout, left + index * panelWidth + 12, left + (index + 1) * panelWidth - 12, top, rowHeight));
  return <g>
    {positioned.slice(0, -1).map((tree, index) => showConnections && layouts[index]!.tipOrder.map((name) => { const a = tree.byName.get(name)!; const b = positioned[index + 1]!.byName.get(name)!; const changed = Math.abs(a.y - b.y) > .1; return <line key={`${index}-${name}`} x1={left + (index + 1) * panelWidth - 10} x2={left + (index + 1) * panelWidth + 10} y1={a.y} y2={b.y} stroke={changed && highlightChanges ? "#d46d35" : "#77837f"} strokeWidth={changed ? 1.1 : .7} opacity={changed ? .75 : .35}><title>{name}</title></line>; }))}
    {positioned.map((tree, index) => <g key={runs[index]!.id}><Branches tree={tree} color={trees[index]!.color} /><text x={left + index * panelWidth + panelWidth / 2} y={top - 22} textAnchor="middle" fill={trees[index]!.color} fontSize="9" fontWeight="750">{`${runs[index]!.start}–${runs[index]!.end}`}</text>{showLabels && (everyLabel || index === positioned.length - 1) && layouts[index]!.tipOrder.map((name) => <text key={name} x={tree.byName.get(name)!.x + 4} y={tree.byName.get(name)!.y + labelSize * .34} fill={INK} fontSize={labelSize}>{name}</text>)}</g>)}
  </g>;
}

export function JemsprTreeSequenceFigure({ result }: { readonly result: JemsprNetworkResult }) {
  const titleId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const [selected, setSelected] = useState<Set<number>>(() => new Set(result.runs.map((_run, index) => index)));
  const [title, setTitle] = useState("JEMSPR implied regional phylogenies");
  const [baseWidth, setBaseWidth] = useState(1280);
  const [rowHeight, setRowHeight] = useState(20);
  const [labelSize, setLabelSize] = useState(9);
  const [showLabels, setShowLabels] = useState(true);
  const [everyLabel, setEveryLabel] = useState(false);
  const [showConnections, setShowConnections] = useState(true);
  const [highlightChanges, setHighlightChanges] = useState(true);
  useEffect(() => setSelected((current) => new Set([...current].filter((index) => index < result.runs.length))), [result.runs.length]);
  const indexes = [...selected].sort((a, b) => a - b);
  const runs = indexes.map((index) => result.runs[index]!);
  const trees = runs.map((run) => result.trees[run.treeIndex]!);
  const aligned = useMemo(() => {
    try { return { layouts: alignComparisonTrees(trees.map((tree) => tree.tree)) } as const; }
    catch (error) { return { error: error instanceof Error ? error.message : String(error) } as const; }
  }, [trees.map((tree) => tree.tree).join("\u0001")]);
  const pair = runs.length === 2;
  const width = pair ? Math.max(1000, baseWidth) : Math.max(baseWidth, 130 + runs.length * 245);
  const taxa = "layouts" in aligned && aligned.layouts.length > 0 ? aligned.layouts[0]!.tipOrder.length : 1;
  const top = 120;
  const height = top + Math.max(120, (taxa - 1) * rowHeight) + 54;
  const maximumSite = Math.max(1, ...result.runs.map((run) => run.end));
  const stripX = (site: number): number => 42 + Math.max(0, Math.min(maximumSite, site)) / maximumSite * (width - 84);
  const toggle = (index: number): void => setSelected((current) => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next; });
  return <article className="figure-card">
    <div className="figure-card__heading"><div><strong>{title}</strong><span>Display-only rerooting and child ordering minimize matching-tip crossings; inferred rooted Newick trees, genomic assignments, and event masks remain unchanged.</span></div><button type="button" className="button button--secondary button--svg" disabled={!("layouts" in aligned) || runs.length === 0} onClick={() => svgRef.current !== null && downloadSvg(svgRef.current, title)}>Export SVG</button></div>
    <div className="tree-figure-controls"><label><span>Figure title</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label><label><span>Width {baseWidth}px</span><input type="range" min="900" max="3000" step="50" value={baseWidth} onChange={(event) => setBaseWidth(Number(event.target.value))} /></label><label><span>Tip spacing {rowHeight}px</span><input type="range" min="12" max="34" value={rowHeight} onChange={(event) => setRowHeight(Number(event.target.value))} /></label><label><span>Label size {labelSize}px</span><input type="range" min="7" max="18" value={labelSize} onChange={(event) => setLabelSize(Number(event.target.value))} /></label><label className="toggle"><input type="checkbox" checked={showLabels} onChange={(event) => setShowLabels(event.target.checked)} /><span>Tip labels</span></label>{!pair && <label className="toggle"><input type="checkbox" checked={everyLabel} onChange={(event) => setEveryLabel(event.target.checked)} /><span>Labels on every tree</span></label>}<label className="toggle"><input type="checkbox" checked={showConnections} onChange={(event) => setShowConnections(event.target.checked)} /><span>Matching-taxon links</span></label><label className="toggle"><input type="checkbox" checked={highlightChanges} onChange={(event) => setHighlightChanges(event.target.checked)} /><span>Highlight track changes</span></label></div>
    <div className="fsart-run-selector" role="group" aria-label="JEMSPR regions to compare"><button type="button" className="button button--secondary" onClick={() => setSelected(new Set(result.runs.map((_run, index) => index)))}>Select all regions</button><button type="button" className="button button--secondary" onClick={() => setSelected(new Set())}>Clear</button>{result.runs.map((run, index) => <label key={run.id} className={selected.has(index) ? "is-selected" : undefined}><input type="checkbox" checked={selected.has(index)} onChange={() => toggle(index)} /><i style={{ background: result.trees[run.treeIndex]?.color }} /><span>{`Region ${index + 1}: ${run.start}–${run.end}`}</span><small>{`${run.treeId} · mask ${run.mask.toString(2).padStart(result.templates.length, "0")}`}</small></label>)}</div>
    {runs.length === 0 && <div className="figure-empty"><strong>Select one or more inferred regions.</strong><span>Two regions produce a mirrored tanglegram; all regions produce a linked tree sequence.</span></div>}
    {"error" in aligned && runs.length > 0 && <div className="figure-empty"><strong>Tree comparison unavailable.</strong><span>{aligned.error}</span></div>}
    {"layouts" in aligned && runs.length > 0 && <div className="figure-scroll figure-scroll--tall"><svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-labelledby={titleId} style={{ display: "block", minWidth: `${Math.min(width, 900)}px`, background: "#fff", fontFamily: FONT }}><title id={titleId}>{title}</title><rect width={width} height={height} fill="#fff" /><text x="42" y="28" fill={INK} fontSize="18" fontWeight="680">{title}</text><text x="42" y="45" fill="#65736f" fontSize="9">Orange links indicate a changed optimized display row between adjacent implied trees; gray links retain the row.</text><text x="42" y="62" fill={INK} fontSize="8" fontWeight="700">Viterbi genomic assignment</text>{result.runs.map((run, index) => { const tree = result.trees[run.treeIndex]!; const active = selected.has(index); const x1 = stripX(run.start - 1); const x2 = stripX(run.end); return <g key={`strip-${run.id}`} opacity={active ? 1 : .23}><rect x={x1} y="68" width={Math.max(2, x2 - x1)} height="13" fill={tree.color} stroke={active ? INK : "#fff"} strokeWidth={active ? 1.1 : .6}><title>{`Region ${index + 1}: ${run.start}–${run.end}; ${tree.id}; mask ${run.mask}`}</title></rect>{x2 - x1 > 44 && <text x={(x1 + x2) / 2} y="78" textAnchor="middle" fill="#fff" fontSize="7" fontWeight="800">{index + 1}</text>}</g>; })}{pair ? <PairView layouts={aligned.layouts} runs={runs} trees={trees} width={width} top={top} rowHeight={rowHeight} labelSize={labelSize} showLabels={showLabels} showConnections={showConnections} highlightChanges={highlightChanges} /> : <SequenceView layouts={aligned.layouts} runs={runs} trees={trees} width={width} left={42} right={showLabels ? 150 : 28} top={top} rowHeight={rowHeight} labelSize={labelSize} showLabels={showLabels} everyLabel={everyLabel} showConnections={showConnections} highlightChanges={highlightChanges} />}</svg></div>}
  </article>;
}

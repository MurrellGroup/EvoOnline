import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { SprReconstructionResult, SprReconstructionRun, SprTopologyState } from "@phylo-workbench/model-mosaicspr/browser-source";
import { downloadSvg } from "../lib/svg-export.js";
import { alignComparisonTrees, type ComparisonTreeLayout, type ComparisonTreeNode } from "../lib/tree-comparison.js";

const FONT = "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
const INK = "#172321";

interface PositionedNode {
  readonly x: number;
  readonly y: number;
  readonly node: ComparisonTreeNode;
}

interface PositionedTree {
  readonly nodes: readonly PositionedNode[];
  readonly byName: ReadonlyMap<string, PositionedNode>;
  readonly byId: ReadonlyMap<string, PositionedNode>;
  readonly maximumDistance: number;
}

function positionedTree(layout: ComparisonTreeLayout, rootX: number, tipX: number, top: number, rowHeight: number, useBranchLengths: boolean): PositionedTree {
  const raw = new Map<ComparisonTreeNode, { distance: number; depth: number; y: number }>();
  const row = new Map(layout.tipOrder.map((name, index) => [name, index]));
  let maximumDistance = 0;
  let maximumDepth = 0;
  const visit = (node: ComparisonTreeNode, distance: number, depth: number): number => {
    maximumDistance = Math.max(maximumDistance, distance);
    maximumDepth = Math.max(maximumDepth, depth);
    const y = node.children.length === 0
      ? row.get(node.name) ?? 0
      : node.children.map((child) => visit(child, distance + child.branchLength, depth + 1))
        .reduce((sum, value, _index, values) => sum + value / values.length, 0);
    raw.set(node, { distance, depth, y });
    return y;
  };
  visit(layout.root, 0, 0);
  const denominator = useBranchLengths && maximumDistance > 0 ? maximumDistance : Math.max(1, maximumDepth);
  const nodes: PositionedNode[] = [];
  const byName = new Map<string, PositionedNode>();
  const byId = new Map<string, PositionedNode>();
  const collect = (node: ComparisonTreeNode): void => {
    const value = raw.get(node)!;
    const fraction = (useBranchLengths && maximumDistance > 0 ? value.distance : value.depth) / denominator;
    const positioned = { x: rootX + (tipX - rootX) * fraction, y: top + value.y * rowHeight, node };
    nodes.push(positioned);
    byId.set(node.id, positioned);
    if (node.children.length === 0) byName.set(node.name, positioned);
    for (const child of node.children) collect(child);
  };
  collect(layout.root);
  return { nodes, byName, byId, maximumDistance };
}

function TreeBranches({ tree, color, strokeWidth = 1.2 }: { readonly tree: PositionedTree; readonly color: string; readonly strokeWidth?: number }) {
  return <g>{tree.nodes.map(({ node, x, y }) => {
    if (node.children.length === 0) return <circle key={`tip-${node.id}`} cx={x} cy={y} r="1.5" fill={color} />;
    const children = node.children.map((child) => tree.byId.get(child.id)!);
    return <g key={node.id}>
      {children.length > 1 && <line x1={x} x2={x} y1={Math.min(...children.map((child) => child.y))} y2={Math.max(...children.map((child) => child.y))} stroke={color} strokeWidth={strokeWidth} />}
      {children.map((child) => <line key={child.node.id} x1={x} x2={child.x} y1={child.y} y2={child.y} stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />)}
      <circle cx={x} cy={y} r="1.4" fill={color} />
    </g>;
  })}</g>;
}

export function MosaicSprTreeComparisonFigure({ result, initialSelection = "all" }: {
  readonly result: SprReconstructionResult;
  readonly initialSelection?: "pair" | "all";
}) {
  const titleId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const runs = result.runs;
  const [selected, setSelected] = useState<Set<number>>(() => new Set(Array.from(
    { length: initialSelection === "all" ? runs.length : Math.min(2, runs.length) },
    (_value, index) => index,
  )));
  const [title, setTitle] = useState("MosaicSPR implied regional phylogenies");
  const [baseWidth, setBaseWidth] = useState(1280);
  const [rowHeight, setRowHeight] = useState(20);
  const [labelSize, setLabelSize] = useState(9);
  const [showLabels, setShowLabels] = useState(true);
  const [labelsOnEveryTree, setLabelsOnEveryTree] = useState(false);
  const [showConnections, setShowConnections] = useState(true);
  const [highlightChanges, setHighlightChanges] = useState(true);
  const [useBranchLengths, setUseBranchLengths] = useState(true);

  useEffect(() => {
    setSelected((current) => new Set(Array.from(current).filter((index) => index < runs.length)));
  }, [runs.length]);
  const selectedIndexes = Array.from(selected).sort((a, b) => a - b);
  const selectedRuns = selectedIndexes.map((index) => runs[index]!);
  const selectedStates = selectedRuns.map((run) => result.states[run.stateIndex]!);
  const aligned = useMemo(() => {
    try { return { layouts: alignComparisonTrees(selectedStates.map((state) => state.tree)) } as const; }
    catch (error) { return { error: error instanceof Error ? error.message : String(error) } as const; }
  }, [selectedStates.map((state) => state.tree).join("\u0001")]);
  if (runs.length === 0) return <div className="figure-empty"><strong>No implied regional trees.</strong><span>The selected history contains no genomic runs.</span></div>;

  const pairMode = selectedRuns.length === 2;
  const panelWidth = 255;
  const width = pairMode ? Math.max(baseWidth, 1000) : Math.max(baseWidth, 120 + selectedRuns.length * panelWidth);
  const taxa = "layouts" in aligned && aligned.layouts.length > 0 ? aligned.layouts[0]!.tipOrder.length : 0;
  const left = 70;
  const right = 30;
  const stripTop = 64;
  const treeTop = 146;
  const treeHeight = Math.max(120, Math.max(1, taxa - 1) * rowHeight);
  const height = treeTop + treeHeight + 76;
  const plotWidth = width - left - right;
  const sites = runs.at(-1)?.end ?? 1;
  const xSite = (site: number): number => left + Math.max(0, Math.min(sites, site)) / Math.max(1, sites) * plotWidth;
  const toggle = (index: number): void => setSelected((current) => {
    const next = new Set(current);
    if (next.has(index)) next.delete(index); else next.add(index);
    return next;
  });

  return <article className="figure-card fsart-linked-trees-card">
    <div className="figure-card__heading"><div><strong>{title}</strong><span>The regional trees are implied by replaying MosaicSPR's explicit edit paths—not independent unconstrained segment labels.</span></div><button type="button" className="button button--secondary button--svg" disabled={!("layouts" in aligned) || selectedRuns.length === 0} onClick={() => svgRef.current !== null && downloadSvg(svgRef.current, title)}>Export SVG</button></div>
    <div className="tree-figure-controls fsart-linked-tree-controls">
      <label><span>Figure title</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label><span>Width {baseWidth}px</span><input type="range" min="900" max="3000" step="50" value={baseWidth} onChange={(event) => setBaseWidth(Number(event.target.value))} /></label>
      <label><span>Tip spacing {rowHeight}px</span><input type="range" min="12" max="34" step="1" value={rowHeight} onChange={(event) => setRowHeight(Number(event.target.value))} /></label>
      <label><span>Label size {labelSize}px</span><input type="range" min="7" max="18" step="1" value={labelSize} onChange={(event) => setLabelSize(Number(event.target.value))} /></label>
      <label className="toggle"><input type="checkbox" checked={showLabels} onChange={(event) => setShowLabels(event.target.checked)} /><span>Tip labels</span></label>
      {!pairMode && <label className="toggle"><input type="checkbox" checked={labelsOnEveryTree} onChange={(event) => setLabelsOnEveryTree(event.target.checked)} /><span>Labels on every tree</span></label>}
      <label className="toggle"><input type="checkbox" checked={showConnections} onChange={(event) => setShowConnections(event.target.checked)} /><span>Matching-taxon links</span></label>
      <label className="toggle"><input type="checkbox" checked={highlightChanges} onChange={(event) => setHighlightChanges(event.target.checked)} /><span>Highlight track changes</span></label>
      <label className="toggle"><input type="checkbox" checked={useBranchLengths} onChange={(event) => setUseBranchLengths(event.target.checked)} /><span>Branch-length scale</span></label>
    </div>
    <div className="fsart-run-selector" role="group" aria-label="MosaicSPR regions to compare">
      <button type="button" className="button button--secondary" onClick={() => setSelected(new Set(runs.map((_run, index) => index)))}>Select all regions</button>
      <button type="button" className="button button--secondary" onClick={() => setSelected(new Set())}>Clear</button>
      {runs.map((run, index) => <label key={run.id} className={selected.has(index) ? "is-selected" : undefined}><input type="checkbox" checked={selected.has(index)} onChange={() => toggle(index)} /><i style={{ background: result.states[run.stateIndex]?.color }} /><span>{`Region ${index + 1}: ${run.start}–${run.end}`}</span><small>{`${run.stateId}${run.stateId === result.masterStateId ? " · master" : ""}`}</small></label>)}
    </div>
    {selectedRuns.length === 0 && <div className="figure-empty"><strong>Select one or more inferred regions.</strong><span>Two regions produce a mirrored tanglegram; “Select all regions” produces the alignment-wide linked-tree view.</span></div>}
    {"error" in aligned && selectedRuns.length > 0 && <div className="figure-empty"><strong>Tree comparison unavailable.</strong><span>{aligned.error}</span></div>}
    {"layouts" in aligned && selectedRuns.length > 0 && <div className="figure-scroll figure-scroll--tall"><svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-labelledby={titleId} style={{ display: "block", minWidth: `${Math.min(width, 900)}px`, background: "#fff", fontFamily: FONT }}>
      <title id={titleId}>{title}</title><rect width={width} height={height} fill="#fff" />
      <text x={left} y="28" fill={INK} fontSize="18" fontWeight="680">{title}</text>
      <text x={left} y="45" fill="#65736f" fontSize="9">Display roots and child orders are optimized for tip agreement; inferred topology, branch lengths, regions, and SPR scripts are unchanged.</text>
      {runs.map((run, index) => <g key={`strip-${run.id}`} onClick={() => toggle(index)} style={{ cursor: "pointer" }}><rect x={xSite(run.start - 1)} y={stripTop} width={Math.max(2, xSite(run.end) - xSite(run.start - 1))} height="22" fill={result.states[run.stateIndex]?.color ?? "#888"} opacity={selected.has(index) ? 0.96 : 0.36} stroke={selected.has(index) ? INK : "#fff"} strokeWidth="1.5"><title>{`Region ${index + 1}: ${run.start}–${run.end}; implied tree ${run.stateId}`}</title></rect>{xSite(run.end) - xSite(run.start - 1) > 45 && <text x={(xSite(run.start - 1) + xSite(run.end)) / 2} y={stripTop + 15} textAnchor="middle" fill="#fff" fontSize="8" fontWeight="750">{`${index + 1} · ${run.stateId}`}</text>}</g>)}
      {result.events.map((event) => <g key={`${event.breakpoint}-${event.fromStateId}`}><path d={`M${xSite(event.breakpoint) - 5},${stripTop - 7} l5,-7 l5,7 l-5,7 z`} fill="#f2a900" stroke="#684c00" strokeWidth="0.7" /><text x={xSite(event.breakpoint)} y={stripTop - 18} textAnchor="middle" fill={INK} fontSize="8" fontWeight="750">{`${event.sprDistance} SPR`}</text></g>)}
      <line x1={left} x2={width - right} y1={stripTop + 30} y2={stripTop + 30} stroke="#344440" />
      {[0, 0.25, 0.5, 0.75, 1].map((fraction) => { const site = Math.max(1, Math.round(fraction * sites)); return <g key={fraction}><line x1={xSite(site)} x2={xSite(site)} y1={stripTop + 30} y2={stripTop + 35} stroke="#344440" /><text x={xSite(site)} y={stripTop + 46} textAnchor="middle" fill="#65736f" fontSize="8">{site.toLocaleString()}</text></g>; })}
      {pairMode
        ? <PairTrees layouts={aligned.layouts} states={selectedStates} runs={selectedRuns} width={width} top={treeTop} treeHeight={treeHeight} rowHeight={rowHeight} labelSize={labelSize} showLabels={showLabels} showConnections={showConnections} highlightChanges={highlightChanges} useBranchLengths={useBranchLengths} />
        : <TreeSequence layouts={aligned.layouts} states={selectedStates} runs={selectedRuns} width={width} left={left} right={right} top={treeTop} treeHeight={treeHeight} rowHeight={rowHeight} labelSize={labelSize} showLabels={showLabels} labelsOnEveryTree={labelsOnEveryTree} showConnections={showConnections} highlightChanges={highlightChanges} useBranchLengths={useBranchLengths} />}
      <text x={left} y={height - 14} fill="#65736f" fontSize="8">Orange links mark taxa whose optimized display row changes between adjacent implied trees; gray links retain the same display row.</text>
    </svg></div>}
  </article>;
}

function PairTrees({ layouts, states, runs, width, top, treeHeight, rowHeight, labelSize, showLabels, showConnections, highlightChanges, useBranchLengths }: {
  readonly layouts: readonly ComparisonTreeLayout[]; readonly states: readonly SprTopologyState[]; readonly runs: readonly SprReconstructionRun[];
  readonly width: number; readonly top: number; readonly treeHeight: number; readonly rowHeight: number; readonly labelSize: number;
  readonly showLabels: boolean; readonly showConnections: boolean; readonly highlightChanges: boolean; readonly useBranchLengths: boolean;
}) {
  const center = width / 2;
  const maximumLabel = Math.min(180, Math.max(70, ...layouts[0]!.tipOrder.map((name) => name.length * labelSize * 0.58)));
  const leftTip = center - maximumLabel - 44;
  const rightTip = center + maximumLabel + 44;
  const first = positionedTree(layouts[0]!, 42, leftTip, top, rowHeight, useBranchLengths);
  const second = positionedTree(layouts[1]!, width - 42, rightTip, top, rowHeight, useBranchLengths);
  return <g>
    <text x="42" y={top - 22} fill={states[0]!.color} fontSize="11" fontWeight="750">{`Region ${runs[0]!.start}–${runs[0]!.end} · ${states[0]!.id}`}</text>
    <text x={width - 42} y={top - 22} textAnchor="end" fill={states[1]!.color} fontSize="11" fontWeight="750">{`Region ${runs[1]!.start}–${runs[1]!.end} · ${states[1]!.id}`}</text>
    {showConnections && layouts[0]!.tipOrder.map((name) => { const a = first.byName.get(name)!; const b = second.byName.get(name)!; const changed = Math.abs(a.y - b.y) > 0.1; return <line key={name} x1={leftTip + (showLabels ? maximumLabel + 8 : 8)} x2={rightTip - (showLabels ? maximumLabel + 8 : 8)} y1={a.y} y2={b.y} stroke={changed && highlightChanges ? "#d46d35" : "#6f7c78"} strokeWidth={changed && highlightChanges ? 1.25 : 0.8} strokeDasharray="3 3" opacity={changed ? 0.72 : 0.42}><title>{name}</title></line>; })}
    <TreeBranches tree={first} color={states[0]!.color} /><TreeBranches tree={second} color={states[1]!.color} />
    {showLabels && layouts[0]!.tipOrder.map((name) => <text key={`l-${name}`} x={leftTip + 5} y={first.byName.get(name)!.y + labelSize * 0.34} fill={INK} fontSize={labelSize}>{name}</text>)}
    {showLabels && layouts[1]!.tipOrder.map((name) => <text key={`r-${name}`} x={rightTip - 5} y={second.byName.get(name)!.y + labelSize * 0.34} textAnchor="end" fill={INK} fontSize={labelSize}>{name}</text>)}
    <text x="42" y={top + treeHeight + 21} fill="#687672" fontSize="8">{useBranchLengths ? first.maximumDistance.toPrecision(3) : "cladogram"}</text>
    <text x={width - 42} y={top + treeHeight + 21} textAnchor="end" fill="#687672" fontSize="8">{useBranchLengths ? second.maximumDistance.toPrecision(3) : "cladogram"}</text>
  </g>;
}

function TreeSequence({ layouts, states, runs, width, left, right, top, treeHeight, rowHeight, labelSize, showLabels, labelsOnEveryTree, showConnections, highlightChanges, useBranchLengths }: {
  readonly layouts: readonly ComparisonTreeLayout[]; readonly states: readonly SprTopologyState[]; readonly runs: readonly SprReconstructionRun[];
  readonly width: number; readonly left: number; readonly right: number; readonly top: number; readonly treeHeight: number; readonly rowHeight: number; readonly labelSize: number;
  readonly showLabels: boolean; readonly labelsOnEveryTree: boolean; readonly showConnections: boolean; readonly highlightChanges: boolean; readonly useBranchLengths: boolean;
}) {
  const panel = (width - left - right) / Math.max(1, layouts.length);
  const labelGutter = showLabels ? Math.min(110, Math.max(55, panel * 0.34)) : 8;
  const positioned = layouts.map((layout, index) => positionedTree(layout, left + index * panel + 5, left + (index + 1) * panel - labelGutter, top, rowHeight, useBranchLengths));
  return <g>
    {showConnections && positioned.slice(0, -1).flatMap((tree, index) => layouts[index]!.tipOrder.map((name) => { const from = tree.byName.get(name)!; const to = positioned[index + 1]!.byName.get(name)!; const changed = Math.abs(from.y - to.y) > 0.1; return <line key={`${index}-${name}`} x1={from.x + 2} x2={to.x + 2} y1={from.y} y2={to.y} stroke={changed && highlightChanges ? "#d46d35" : "#8b9693"} strokeWidth={changed && highlightChanges ? 1.3 : 0.75} opacity={changed ? 0.34 : 0.18}><title>{`${name}: implied tree ${index + 1} → ${index + 2}`}</title></line>; }))}
    {positioned.map((tree, index) => <g key={runs[index]!.id}>
      <text x={left + index * panel + 5} y={top - 22} fill={states[index]!.color} fontSize="9" fontWeight="750">{`Region ${runs[index]!.start}–${runs[index]!.end}`}</text>
      <text x={left + index * panel + 5} y={top - 10} fill="#687672" fontSize="7.5">{states[index]!.id}</text>
      <TreeBranches tree={tree} color={states[index]!.color} strokeWidth={1.05} />
      {showLabels && (labelsOnEveryTree || index === positioned.length - 1) && layouts[index]!.tipOrder.map((name) => <text key={name} x={tree.byName.get(name)!.x + 4} y={tree.byName.get(name)!.y + labelSize * 0.34} fill={INK} fontSize={labelSize}>{name}</text>)}
      <text x={left + index * panel + 5} y={top + treeHeight + 20} fill="#78837f" fontSize="7">{useBranchLengths ? tree.maximumDistance.toPrecision(3) : "cladogram"}</text>
    </g>)}
  </g>;
}

import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  TreeHmmExplorationResult,
  TreeHmmResult,
  TreeHmmViterbiRun,
} from "@phylo-workbench/model-fsart/browser-source";
import { downloadSvg } from "../lib/svg-export.js";
import {
  alignComparisonTrees,
  type ComparisonTreeLayout,
  type ComparisonTreeNode,
} from "../lib/tree-comparison.js";

const FONT = "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
const INK = "#172321";

type Inference = TreeHmmResult | TreeHmmExplorationResult;

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

function positionedTree(
  layout: ComparisonTreeLayout,
  rootX: number,
  tipX: number,
  top: number,
  rowHeight: number,
  useBranchLengths: boolean,
): PositionedTree {
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

function TreeBranches({ tree, color = "#44534f", strokeWidth = 1.25 }: {
  readonly tree: PositionedTree;
  readonly color?: string;
  readonly strokeWidth?: number;
}) {
  return <g>{tree.nodes.map(({ node, x, y }) => {
    if (node.children.length === 0) return <circle key={`tip-${node.id}`} cx={x} cy={y} r="1.5" fill={color} />;
    const children = node.children.map((child) => tree.byId.get(child.id)!);
    return <g key={node.id}>
      {children.length > 1 && <line x1={x} x2={x} y1={Math.min(...children.map((child) => child.y))} y2={Math.max(...children.map((child) => child.y))} stroke={color} strokeWidth={strokeWidth} />}
      {children.map((child) => <line key={child.node.id} x1={x} x2={child.x} y1={child.y} y2={child.y} stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />)}
      <circle cx={x} cy={y} r="1.5" fill={color} />
    </g>;
  })}</g>;
}

function inferredRuns(inference: Inference): readonly TreeHmmViterbiRun[] {
  if (inference.viterbi !== undefined) return inference.viterbi.runs;
  if (inference.mapState.length === 0) return [];
  const output: TreeHmmViterbiRun[] = [];
  let start = 0;
  let state = inference.mapState[0]!;
  for (let site = 1; site <= inference.sites; site += 1) {
    if (site < inference.sites && inference.mapState[site] === state) continue;
    output.push({ start: start + 1, end: site, state, treeId: inference.states[state]?.id ?? `T${state + 1}` });
    if (site < inference.sites) { start = site; state = inference.mapState[site]!; }
  }
  return output;
}

function sampledCurve(inference: Inference, state: number, x: (site: number) => number, y: (value: number) => number, maximumPoints: number): string {
  const stride = Math.max(1, Math.ceil(inference.sites / maximumPoints));
  const points: string[] = [];
  for (let start = 0; start < inference.sites; start += stride) {
    const end = Math.min(inference.sites, start + stride);
    let total = 0;
    for (let site = start; site < end; site += 1) total += inference.statePosterior[state * inference.sites + site] ?? 0;
    points.push(`${points.length === 0 ? "M" : "L"}${x((start + end) / 2).toFixed(2)},${y(total / (end - start)).toFixed(2)}`);
  }
  return points.join(" ");
}

export function FsartTreeComparisonFigure({ inference, titlePrefix = "Viterbi segment trees", initialSelection = "pair" }: {
  readonly inference: Inference;
  readonly titlePrefix?: string;
  /** Primarily useful for deterministic visual-regression renders; the application defaults to a pair. */
  readonly initialSelection?: "pair" | "all";
}) {
  const titleId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const runs = useMemo(() => inferredRuns(inference), [inference]);
  const [selected, setSelected] = useState<Set<number>>(() => new Set(Array.from(
    { length: initialSelection === "all" ? runs.length : Math.min(2, runs.length) },
    (_value, index) => index,
  )));
  const [title, setTitle] = useState(`${titlePrefix}: linked topology comparison`);
  const [baseWidth, setBaseWidth] = useState(1280);
  const [rowHeight, setRowHeight] = useState(20);
  const [labelSize, setLabelSize] = useState(9);
  const [showLabels, setShowLabels] = useState(true);
  const [labelsOnEveryTree, setLabelsOnEveryTree] = useState(false);
  const [showConnections, setShowConnections] = useState(true);
  const [highlightTrackChanges, setHighlightTrackChanges] = useState(true);
  const [useBranchLengths, setUseBranchLengths] = useState(true);

  useEffect(() => {
    setSelected((current) => {
      const valid = new Set(Array.from(current).filter((index) => index < runs.length));
      if (valid.size > 0) return valid;
      return new Set(Array.from({ length: Math.min(2, runs.length) }, (_value, index) => index));
    });
  }, [runs.length]);

  const selectedIndexes = Array.from(selected).sort((a, b) => a - b);
  const selectedRuns = selectedIndexes.map((index) => runs[index]!);
  const selectedStates = selectedRuns.map((run) => inference.states[run.state]!);
  const aligned = useMemo(() => {
    try {
      return { layouts: alignComparisonTrees(selectedStates.map((state) => state.tree)) } as const;
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) } as const;
    }
  }, [selectedStates.map((state) => state.tree).join("\u0001")]);
  if (runs.length === 0) return <div className="figure-empty"><strong>No Viterbi segment trees.</strong><span>The selected reconstruction contains no decodable runs.</span></div>;

  const pairMode = selectedRuns.length === 2;
  const panelWidth = 255;
  const width = pairMode ? Math.max(baseWidth, 1000) : Math.max(baseWidth, 120 + selectedRuns.length * panelWidth);
  const taxa = "layouts" in aligned && aligned.layouts.length > 0 ? aligned.layouts[0]!.tipOrder.length : 0;
  const posteriorTop = 68;
  const posteriorHeight = 92;
  const stripTop = posteriorTop + posteriorHeight + 7;
  const treeTop = stripTop + 82;
  const treeHeight = Math.max(120, Math.max(1, taxa - 1) * rowHeight);
  const height = treeTop + treeHeight + 78;
  const left = 70;
  const right = 30;
  const plotWidth = width - left - right;
  const xSite = (site: number): number => left + Math.max(0, Math.min(inference.sites, site)) / Math.max(1, inference.sites) * plotWidth;
  const yPosterior = (value: number): number => posteriorTop + posteriorHeight * (1 - Math.max(0, Math.min(1, value)));
  const toggle = (index: number): void => setSelected((current) => {
    const next = new Set(current);
    if (next.has(index)) next.delete(index); else next.add(index);
    return next;
  });

  return <article className="figure-card fsart-linked-trees-card">
    <div className="figure-card__heading"><div><strong>{title}</strong><span>Select exactly two runs for a mirrored tanglegram; select three or more for jointly ordered, same-direction trees with taxon track changes.</span></div><button type="button" className="button button--secondary button--svg" disabled={!("layouts" in aligned) || selectedRuns.length === 0} onClick={() => svgRef.current !== null && downloadSvg(svgRef.current, title)}>Export SVG</button></div>
    <div className="tree-figure-controls fsart-linked-tree-controls">
      <label><span>Figure title</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label><span>Width {baseWidth}px</span><input type="range" min="900" max="3000" step="50" value={baseWidth} onChange={(event) => setBaseWidth(Number(event.target.value))} /></label>
      <label><span>Tip spacing {rowHeight}px</span><input type="range" min="12" max="34" step="1" value={rowHeight} onChange={(event) => setRowHeight(Number(event.target.value))} /></label>
      <label><span>Label size {labelSize}px</span><input type="range" min="7" max="18" step="1" value={labelSize} onChange={(event) => setLabelSize(Number(event.target.value))} /></label>
      <label className="toggle"><input type="checkbox" checked={showLabels} onChange={(event) => setShowLabels(event.target.checked)} /><span>Tip labels</span></label>
      {!pairMode && <label className="toggle"><input type="checkbox" checked={labelsOnEveryTree} onChange={(event) => setLabelsOnEveryTree(event.target.checked)} /><span>Labels on every tree</span></label>}
      <label className="toggle"><input type="checkbox" checked={showConnections} onChange={(event) => setShowConnections(event.target.checked)} /><span>Matching-taxon links</span></label>
      <label className="toggle"><input type="checkbox" checked={highlightTrackChanges} onChange={(event) => setHighlightTrackChanges(event.target.checked)} /><span>Highlight track changes</span></label>
      <label className="toggle"><input type="checkbox" checked={useBranchLengths} onChange={(event) => setUseBranchLengths(event.target.checked)} /><span>Branch-length scale</span></label>
    </div>
    <div className="fsart-run-selector" role="group" aria-label="Viterbi segments to compare">
      <button type="button" className="button button--secondary" onClick={() => setSelected(new Set(runs.map((_run, index) => index)))}>Select all runs</button>
      <button type="button" className="button button--secondary" onClick={() => setSelected(new Set())}>Clear</button>
      {runs.map((run, index) => <label key={`${run.start}-${run.end}-${run.treeId}`} className={selected.has(index) ? "is-selected" : undefined}><input type="checkbox" checked={selected.has(index)} onChange={() => toggle(index)} /><i style={{ background: inference.states[run.state]?.color }} /><span>{`Run ${index + 1}: ${run.start}–${run.end}`}</span><small>{run.treeId}</small></label>)}
    </div>
    {selectedRuns.length === 0 && <div className="figure-empty"><strong>Select one or more Viterbi runs.</strong><span>Two runs produce a mirrored comparison; “Select all runs” produces the alignment-wide linked-tree view.</span></div>}
    {"error" in aligned && selectedRuns.length > 0 && <div className="figure-empty"><strong>Tree comparison unavailable.</strong><span>{aligned.error}</span></div>}
    {"layouts" in aligned && selectedRuns.length > 0 && <div className="figure-scroll figure-scroll--tall"><svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-labelledby={titleId} style={{ display: "block", minWidth: `${Math.min(width, 900)}px`, background: "#fff", fontFamily: FONT }}>
      <title id={titleId}>{title}</title>
      <rect width={width} height={height} fill="#fff" />
      <text x={left} y="29" fill={INK} fontSize="18" fontWeight="680">{title}</text>
      <text x={left} y="47" fill="#65736f" fontSize="9">Display roots and legal child orders are optimized jointly for tip agreement; topology and branch lengths are unchanged.</text>
      {[0, 0.5, 1].map((value) => <g key={value}><line x1={left - 4} x2={left} y1={yPosterior(value)} y2={yPosterior(value)} stroke="#44534f" /><text x={left - 8} y={yPosterior(value) + 3} textAnchor="end" fill="#687672" fontSize="8">{value.toFixed(1)}</text></g>)}
      {inference.states.map((state, stateIndex) => <path key={state.id} d={sampledCurve(inference, stateIndex, xSite, yPosterior, Math.min(1800, Math.round(plotWidth)))} fill="none" stroke={state.color} strokeWidth="1.35" opacity="0.8"><title>{`${state.id} marginal topology posterior`}</title></path>)}
      <line x1={left} x2={width - right} y1={posteriorTop + posteriorHeight} y2={posteriorTop + posteriorHeight} stroke="#344440" />
      {runs.map((run, index) => <g key={`strip-${index}`} onClick={() => toggle(index)} style={{ cursor: "pointer" }}><rect x={xSite(run.start - 1)} y={stripTop} width={Math.max(2, xSite(run.end) - xSite(run.start - 1))} height="16" fill={inference.states[run.state]?.color ?? "#888"} opacity={selected.has(index) ? 0.95 : 0.38} stroke={selected.has(index) ? INK : "none"} strokeWidth="1.5"><title>{`Run ${index + 1}: sites ${run.start}–${run.end}; click to ${selected.has(index) ? "remove" : "select"}`}</title></rect>{xSite(run.end) - xSite(run.start - 1) > 42 && <text x={(xSite(run.start - 1) + xSite(run.end)) / 2} y={stripTop + 11} textAnchor="middle" fill="#fff" fontSize="8" fontWeight="750">{index + 1}</text>}</g>)}
      <text transform={`translate(18 ${posteriorTop + posteriorHeight / 2}) rotate(-90)`} textAnchor="middle" fill="#40504c" fontSize="9">Tree posterior</text>
      <text x={left} y={stripTop + 34} fill="#65736f" fontSize="8">Viterbi assignment · click a segment to compare its final tree</text>
      {pairMode
        ? <PairTrees layouts={aligned.layouts} states={selectedStates} runs={selectedRuns} width={width} top={treeTop} treeHeight={treeHeight} rowHeight={rowHeight} labelSize={labelSize} showLabels={showLabels} showConnections={showConnections} highlightTrackChanges={highlightTrackChanges} useBranchLengths={useBranchLengths} />
        : <TreeSequence layouts={aligned.layouts} states={selectedStates} runs={selectedRuns} width={width} left={left} right={right} top={treeTop} treeHeight={treeHeight} rowHeight={rowHeight} labelSize={labelSize} showLabels={showLabels} labelsOnEveryTree={labelsOnEveryTree} showConnections={showConnections} highlightTrackChanges={highlightTrackChanges} useBranchLengths={useBranchLengths} xSite={xSite} stripTop={stripTop} />}
      <text x={left} y={height - 15} fill="#65736f" fontSize="8">Orange links mark taxa whose optimized display row changes between adjacent trees; gray horizontal links retain the same row.</text>
    </svg></div>}
  </article>;
}

function PairTrees({ layouts, states, runs, width, top, treeHeight, rowHeight, labelSize, showLabels, showConnections, highlightTrackChanges, useBranchLengths }: {
  readonly layouts: readonly ComparisonTreeLayout[];
  readonly states: readonly Inference["states"][number][];
  readonly runs: readonly TreeHmmViterbiRun[];
  readonly width: number;
  readonly top: number;
  readonly treeHeight: number;
  readonly rowHeight: number;
  readonly labelSize: number;
  readonly showLabels: boolean;
  readonly showConnections: boolean;
  readonly highlightTrackChanges: boolean;
  readonly useBranchLengths: boolean;
}) {
  const center = width / 2;
  const maximumLabel = Math.min(180, Math.max(70, ...layouts[0]!.tipOrder.map((name) => name.length * labelSize * 0.58)));
  const leftTip = center - maximumLabel - 44;
  const rightTip = center + maximumLabel + 44;
  const first = positionedTree(layouts[0]!, 42, leftTip, top, rowHeight, useBranchLengths);
  const second = positionedTree(layouts[1]!, width - 42, rightTip, top, rowHeight, useBranchLengths);
  return <g>
    <text x="42" y={top - 24} fill={states[0]!.color} fontSize="11" fontWeight="750">{`Run ${runs[0]!.start}–${runs[0]!.end} · ${states[0]!.id}`}</text>
    <text x={width - 42} y={top - 24} textAnchor="end" fill={states[1]!.color} fontSize="11" fontWeight="750">{`Run ${runs[1]!.start}–${runs[1]!.end} · ${states[1]!.id}`}</text>
    {showConnections && layouts[0]!.tipOrder.map((name) => {
      const leftNode = first.byName.get(name)!;
      const rightNode = second.byName.get(name)!;
      const changed = Math.abs(leftNode.y - rightNode.y) > 0.1;
      return <line key={name} x1={leftTip + (showLabels ? maximumLabel + 8 : 8)} x2={rightTip - (showLabels ? maximumLabel + 8 : 8)} y1={leftNode.y} y2={rightNode.y} stroke={changed && highlightTrackChanges ? "#d46d35" : "#6f7c78"} strokeWidth={changed && highlightTrackChanges ? 1.25 : 0.8} strokeDasharray="3 3" opacity={changed ? 0.72 : 0.42}><title>{changed ? `${name} changes display track` : `${name} remains on the same display track`}</title></line>;
    })}
    <TreeBranches tree={first} color={states[0]!.color} />
    <TreeBranches tree={second} color={states[1]!.color} />
    {showLabels && layouts[0]!.tipOrder.map((name) => <text key={`l-${name}`} x={leftTip + 5} y={first.byName.get(name)!.y + labelSize * 0.34} fill={INK} fontSize={labelSize}>{name}</text>)}
    {showLabels && layouts[1]!.tipOrder.map((name) => <text key={`r-${name}`} x={rightTip - 5} y={second.byName.get(name)!.y + labelSize * 0.34} textAnchor="end" fill={INK} fontSize={labelSize}>{name}</text>)}
    <text x="42" y={top + treeHeight + 23} fill="#687672" fontSize="8">{`root-to-tip max ${first.maximumDistance.toPrecision(3)}`}</text>
    <text x={width - 42} y={top + treeHeight + 23} textAnchor="end" fill="#687672" fontSize="8">{`root-to-tip max ${second.maximumDistance.toPrecision(3)}`}</text>
  </g>;
}

function TreeSequence({ layouts, states, runs, width, left, right, top, treeHeight, rowHeight, labelSize, showLabels, labelsOnEveryTree, showConnections, highlightTrackChanges, useBranchLengths, xSite, stripTop }: {
  readonly layouts: readonly ComparisonTreeLayout[];
  readonly states: readonly Inference["states"][number][];
  readonly runs: readonly TreeHmmViterbiRun[];
  readonly width: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly treeHeight: number;
  readonly rowHeight: number;
  readonly labelSize: number;
  readonly showLabels: boolean;
  readonly labelsOnEveryTree: boolean;
  readonly showConnections: boolean;
  readonly highlightTrackChanges: boolean;
  readonly useBranchLengths: boolean;
  readonly xSite: (site: number) => number;
  readonly stripTop: number;
}) {
  const usable = width - left - right;
  const panel = usable / Math.max(1, layouts.length);
  const labelGutter = showLabels ? Math.min(110, Math.max(55, panel * 0.34)) : 8;
  const positioned = layouts.map((layout, index) => positionedTree(
    layout,
    left + index * panel + 5,
    left + (index + 1) * panel - labelGutter,
    top,
    rowHeight,
    useBranchLengths,
  ));
  return <g>
    {runs.map((run, index) => <path key={`beam-${index}`} d={`M${xSite(run.start - 1)},${stripTop + 18} L${left + index * panel + 8},${top - 35} L${left + (index + 1) * panel - 8},${top - 35} L${xSite(run.end)},${stripTop + 18} Z`} fill={states[index]!.color} opacity="0.075" />)}
    {showConnections && positioned.slice(0, -1).flatMap((tree, index) => layouts[index]!.tipOrder.map((name) => {
      const from = tree.byName.get(name)!;
      const to = positioned[index + 1]!.byName.get(name)!;
      const changed = Math.abs(from.y - to.y) > 0.1;
      return <line key={`${index}-${name}`} x1={from.x + 2} x2={to.x + 2} y1={from.y} y2={to.y} stroke={changed && highlightTrackChanges ? "#d46d35" : "#8b9693"} strokeWidth={changed && highlightTrackChanges ? 1.3 : 0.75} opacity={changed ? 0.34 : 0.18}><title>{`${name}: tree ${index + 1} row ${layouts[index]!.tipOrder.indexOf(name) + 1} → tree ${index + 2} row ${layouts[index + 1]!.tipOrder.indexOf(name) + 1}`}</title></line>;
    }))}
    {positioned.map((tree, index) => <g key={index}>
      <text x={left + index * panel + 5} y={top - 22} fill={states[index]!.color} fontSize="9" fontWeight="750">{`Run ${index + 1} · ${runs[index]!.start}–${runs[index]!.end}`}</text>
      <text x={left + index * panel + 5} y={top - 10} fill="#687672" fontSize="7.5">{states[index]!.id}</text>
      <TreeBranches tree={tree} color={states[index]!.color} strokeWidth={1.05} />
      {showLabels && (labelsOnEveryTree || index === positioned.length - 1) && layouts[index]!.tipOrder.map((name) => <text key={name} x={tree.byName.get(name)!.x + 4} y={tree.byName.get(name)!.y + labelSize * 0.34} fill={INK} fontSize={labelSize}>{name}</text>)}
      <text x={left + index * panel + 5} y={top + treeHeight + 20} fill="#78837f" fontSize="7">{useBranchLengths ? tree.maximumDistance.toPrecision(3) : "cladogram"}</text>
    </g>)}
  </g>;
}

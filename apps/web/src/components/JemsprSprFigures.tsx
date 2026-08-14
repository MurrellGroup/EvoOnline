import React, { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { JemsprAnalysisResult } from "@phylo-workbench/model-jemspr/browser-source";
import { downloadSvg } from "../lib/svg-export.js";
import {
  exactDisplayLayout,
  displayMaskPath,
  layoutPolishedSprTree,
  maskPath,
  parseJemsprSwitchingNetwork,
  taxaCladeKey,
  type PolishedSprTreeLayout,
  type PolishedSprTreeLayoutEdge,
  type PolishedSprTreeLayoutNode,
  type SprTreeLayout,
  type SprTreeLayoutNode,
} from "../lib/jemspr-visual.js";

const FONT = "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
const INK = "#172321";
const EVENT = "#d46d35";
const DESTINATION = "#177f72";
const SPR_REGION_COLORS = ["#2d7c70", "#d46d35", "#5666cc", "#a44b7a", "#8a6a17", "#3987a8"] as const;

function fallbackNode(node: SprTreeLayoutNode, layout: SprTreeLayout): SprTreeLayoutNode {
  const tips = node.leaves.map((leaf) => layout.nodes.get(String(leaf))).filter((value): value is SprTreeLayoutNode => value !== undefined);
  if (tips.length === 0) return node;
  return { ...node, x: tips.reduce((sum, tip) => sum + tip.x, 0) / tips.length, y: tips.reduce((sum, tip) => sum + tip.y, 0) / tips.length };
}

function interpolateNode(key: string, from: SprTreeLayout, to: SprTreeLayout, fraction: number): SprTreeLayoutNode | undefined {
  const rawFrom = from.nodes.get(key);
  const rawTo = to.nodes.get(key);
  if (rawFrom === undefined && rawTo === undefined) return undefined;
  const first = rawFrom ?? fallbackNode(rawTo!, from);
  const second = rawTo ?? fallbackNode(rawFrom!, to);
  return { ...second, x: first.x + (second.x - first.x) * fraction, y: first.y + (second.y - first.y) * fraction };
}

function MorphTree({ from, to, fraction, taxaNames, showLabels, highlightedTaxa = [] }: {
  readonly from: SprTreeLayout;
  readonly to: SprTreeLayout;
  readonly fraction: number;
  readonly taxaNames: readonly string[];
  readonly showLabels: boolean;
  readonly highlightedTaxa?: readonly number[];
}) {
  const nodeKeys = new Set([...from.nodes.keys(), ...to.nodes.keys()]);
  const positioned = new Map([...nodeKeys].map((key) => [key, interpolateNode(key, from, to, fraction)!]));
  const fromEdges = new Set(from.edges.map((edge) => edge.key));
  const toEdges = new Set(to.edges.map((edge) => edge.key));
  const renderEdges = (layout: SprTreeLayout, opacity: number, suffix: string) => layout.edges.map((edge) => {
    const parent = positioned.get(edge.parent)!;
    const child = positioned.get(edge.child)!;
    return <path key={`${suffix}-${edge.key}`} d={`M${parent.x},${parent.y} V${child.y} H${child.x}`} fill="none" stroke={INK} strokeWidth="1.5" opacity={opacity} />;
  });
  const stableEdges = from.edges.filter((edge) => toEdges.has(edge.key));
  return <g>
    {renderEdges({ ...from, edges: from.edges.filter((edge) => !toEdges.has(edge.key)) }, 1 - fraction, "old")}
    {renderEdges({ ...to, edges: to.edges.filter((edge) => !fromEdges.has(edge.key)) }, fraction, "new")}
    {stableEdges.map((edge) => { const parent = positioned.get(edge.parent)!; const child = positioned.get(edge.child)!; return <path key={edge.key} d={`M${parent.x},${parent.y} V${child.y} H${child.x}`} fill="none" stroke={INK} strokeWidth="1.5" />; })}
    {[...positioned.values()].map((node) => node.leaf === undefined ? <circle key={node.key} cx={node.x} cy={node.y} r="2" fill={INK} opacity={from.nodes.has(node.key) && to.nodes.has(node.key) ? 1 : .35 + .65 * (to.nodes.has(node.key) ? fraction : 1 - fraction)} /> : <g key={node.key}><circle cx={node.x} cy={node.y} r={highlightedTaxa.includes(node.leaf) ? 4 : 2.5} fill={highlightedTaxa.includes(node.leaf) ? EVENT : INK} />{showLabels && <text x={node.x + 7} y={node.y + 3.5} fill={highlightedTaxa.includes(node.leaf) ? EVENT : INK} fontSize="10" fontWeight={highlightedTaxa.includes(node.leaf) ? 750 : 450}>{taxaNames[node.leaf] ?? `taxon ${node.leaf + 1}`}</text>}</g>)}
  </g>;
}

type JemsprMove = JemsprAnalysisResult["network"]["templates"][number]["move"];

interface PolishedMoveScene {
  readonly layout: PolishedSprTreeLayout;
  readonly movingKeys: ReadonlySet<string>;
  readonly movingRoot: PolishedSprTreeLayoutNode;
  readonly sourceEdge: PolishedSprTreeLayoutEdge | undefined;
  readonly targetNode: PolishedSprTreeLayoutNode;
  readonly targetRootX: number;
  readonly targetRootY: number;
  readonly targetAnchorX: number;
  readonly targetAnchorY: number;
  readonly travelControlX: number;
}

interface PolishedSceneGeometry {
  readonly width: number;
  readonly height: number;
  readonly padding: number;
  readonly targetRootLimit: number;
  readonly travelRight: number;
  readonly travelLift: number;
}

const DEFAULT_POLISHED_GEOMETRY: PolishedSceneGeometry = {
  width: 790,
  height: 420,
  padding: 48,
  targetRootLimit: 810,
  travelRight: 1010,
  travelLift: 55,
};

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function nodeContaining(layout: PolishedSprTreeLayout, leaves: ReadonlySet<number>): PolishedSprTreeLayoutNode | undefined {
  return [...layout.nodes.values()]
    .filter((node) => [...leaves].every((leaf) => node.leaves.includes(leaf)))
    .sort((a, b) => a.leaves.length - b.leaves.length)[0];
}

function edgeInto(layout: PolishedSprTreeLayout, child: string): PolishedSprTreeLayoutEdge | undefined {
  return layout.edges.find((edge) => edge.child === child);
}

/**
 * Keep the source phylogram fixed and insert an empty set of tip slots beside
 * the regraft target. The pruned subtree therefore has room at both endpoints;
 * all of its internal coordinates differ only by one rigid translation.
 */
function buildPolishedMoveScene(from: PolishedSprTreeLayout, to: PolishedSprTreeLayout, taxaNames: readonly string[], move: JemsprMove, turningOn: boolean, geometry: PolishedSceneGeometry = DEFAULT_POLISHED_GEOMETRY): PolishedMoveScene | undefined {
  const movingIndexes = move.prunedTaxa.map((name) => taxaNames.indexOf(name)).filter((index) => index >= 0);
  const movingLeaves = new Set(movingIndexes);
  const movingKey = taxaCladeKey(move.prunedTaxa, taxaNames);
  if (movingKey === undefined || movingIndexes.length === 0) return undefined;
  const rawMovingRoot = from.nodes.get(movingKey);
  const finalMovingRoot = to.nodes.get(movingKey);
  if (rawMovingRoot === undefined || finalMovingRoot === undefined) return undefined;

  const targetNames = turningOn ? move.destinationTaxa : move.sourceSiblingTaxa;
  const targetIndexes = targetNames.map((name) => taxaNames.indexOf(name)).filter((index) => index >= 0);
  const targetLeaves = new Set(targetIndexes);
  const targetNodeRaw = (turningOn && move.destinationIsRoot) ? from.nodes.get(from.root) : nodeContaining(from, targetLeaves);
  const finalTarget = (turningOn && move.destinationIsRoot) ? to.nodes.get(to.root) : nodeContaining(to, targetLeaves);
  if (targetNodeRaw === undefined || finalTarget === undefined) return undefined;

  const tipOrder = [...from.nodes.values()].filter((node): node is PolishedSprTreeLayoutNode & { readonly leaf: number } => node.leaf !== undefined).sort((a, b) => a.y - b.y).map((node) => node.leaf);
  const finalMovingY = mean(movingIndexes.map((leaf) => to.nodes.get(String(leaf))?.y ?? finalMovingRoot.y));
  const finalTargetY = mean(targetIndexes.map((leaf) => to.nodes.get(String(leaf))?.y ?? finalTarget.y));
  const insertBefore = turningOn && move.destinationIsRoot ? finalMovingRoot.y < finalTarget.y : finalMovingY < finalTargetY;
  const targetRanks = targetIndexes.map((leaf) => tipOrder.indexOf(leaf)).filter((rank) => rank >= 0);
  const insertion = targetRanks.length === 0
    ? (insertBefore ? 0 : tipOrder.length)
    : (insertBefore ? Math.min(...targetRanks) : Math.max(...targetRanks) + 1);
  const slots = Math.max(2, tipOrder.length + movingIndexes.length);
  const yForSlot = (slot: number): number => geometry.padding + slot / Math.max(1, slots - 1) * (geometry.height - 2 * geometry.padding);
  const sourceLeafY = new Map<number, number>();
  tipOrder.forEach((leaf, rank) => sourceLeafY.set(leaf, yForSlot(rank + (rank >= insertion ? movingIndexes.length : 0))));
  const movingOrder = movingIndexes.slice().sort((a, b) => tipOrder.indexOf(a) - tipOrder.indexOf(b));
  const landingLeafY = new Map(movingOrder.map((leaf, rank) => [leaf, yForSlot(insertion + rank)]));

  const nodes = new Map<string, PolishedSprTreeLayoutNode>();
  for (const node of from.nodes.values()) {
    const y = mean(node.leaves.map((leaf) => sourceLeafY.get(leaf) ?? node.y));
    nodes.set(node.key, { ...node, y });
  }
  const layout: PolishedSprTreeLayout = { ...from, nodes };
  const movingRoot = nodes.get(movingKey)!;
  const targetNode = nodes.get(targetNodeRaw.key)!;
  const sourceMean = mean(movingOrder.map((leaf) => sourceLeafY.get(leaf)!));
  const landingMean = mean(movingOrder.map((leaf) => landingLeafY.get(leaf)!));
  const targetRootY = movingRoot.y + landingMean - sourceMean;

  const finalMovingEdge = edgeInto(to, movingKey);
  const finalTargetEdge = edgeInto(to, finalTarget.key);
  const sourceTargetEdge = edgeInto(layout, targetNode.key);
  const targetParent = sourceTargetEdge === undefined ? undefined : layout.nodes.get(sourceTargetEdge.parent);
  const fittedTargetChildLength = finalTargetEdge?.length ?? sourceTargetEdge?.length ?? 0;
  const rawAnchor = targetNode.x - fittedTargetChildLength * layout.pixelsPerUnit;
  const targetAnchorX = sourceTargetEdge === undefined
    ? targetNode.x
    : Math.max((targetParent?.x ?? 0) + 2, Math.min(targetNode.x - 2, rawAnchor));
  const fittedMovingLength = finalMovingEdge?.length ?? 0;
  const targetRootX = Math.max(targetAnchorX + 3, Math.min(geometry.targetRootLimit, targetAnchorX + fittedMovingLength * layout.pixelsPerUnit));
  const movingKeys = new Set([...layout.nodes.values()].filter((node) => node.leaves.length > 0 && node.leaves.every((leaf) => movingLeaves.has(leaf))).map((node) => node.key));
  const movingRightOffset = Math.max(0, ...[...movingKeys].map((key) => (layout.nodes.get(key)?.x ?? movingRoot.x) - movingRoot.x));
  const rightmostRoot = Math.max(movingRoot.x, targetRootX);
  const travelControlX = Math.max(rightmostRoot + geometry.travelLift * .65, Math.min(geometry.travelRight - movingRightOffset, rightmostRoot + geometry.travelLift * 2.8));
  return {
    layout,
    movingKeys,
    movingRoot,
    sourceEdge: edgeInto(layout, movingKey),
    targetNode,
    targetRootX,
    targetRootY,
    targetAnchorX,
    targetAnchorY: targetNode.y,
    travelControlX,
  };
}

function branchPath(parent: PolishedSprTreeLayoutNode, child: PolishedSprTreeLayoutNode): string {
  return `M${parent.x},${parent.y} V${child.y} H${child.x}`;
}

function scaleBar(layout: PolishedSprTreeLayout) {
  const target = Math.max(1e-9, layout.maximumDistance / 5);
  const exponent = 10 ** Math.floor(Math.log10(target));
  const scaled = target / exponent;
  const amount = (scaled >= 5 ? 5 : scaled >= 2 ? 2 : 1) * exponent;
  return { amount, pixels: amount * layout.pixelsPerUnit };
}

function clamp01(value: number): number { return Math.max(0, Math.min(1, value)); }
function smoothstep(value: number): number { const x = clamp01(value); return x * x * (3 - 2 * x); }

function CompactPolishedTree({ layout, taxaNames, showLabels, color = INK }: { readonly layout: PolishedSprTreeLayout; readonly taxaNames: readonly string[]; readonly showLabels: boolean; readonly color?: string }) {
  return <g>
    {layout.edges.map((edge) => { const parent = layout.nodes.get(edge.parent)!; const child = layout.nodes.get(edge.child)!; return <path key={edge.key} d={branchPath(parent, child)} fill="none" stroke={color} strokeWidth="1.05" strokeLinecap="round" />; })}
    {[...layout.nodes.values()].map((node) => node.leaf === undefined
      ? <circle key={node.key} cx={node.x} cy={node.y} r="1.35" fill={color} />
      : <g key={node.key}><circle cx={node.x} cy={node.y} r="1.75" fill={color} />{showLabels && <text x={node.x + 4} y={node.y + 2.4} fill={color} fontSize="6.8">{taxaNames[node.leaf] ?? `taxon ${node.leaf + 1}`}</text>}</g>)}
  </g>;
}

function CompactPolishedSprMove({ from, to, fraction, taxaNames, showLabels, move, turningOn, geometry }: { readonly from: PolishedSprTreeLayout; readonly to: PolishedSprTreeLayout; readonly fraction: number; readonly taxaNames: readonly string[]; readonly showLabels: boolean; readonly move: JemsprMove; readonly turningOn: boolean; readonly geometry: PolishedSceneGeometry }) {
  const scene = useMemo(() => buildPolishedMoveScene(from, to, taxaNames, move, turningOn, geometry), [from, to, taxaNames, move, turningOn, geometry]);
  if (scene === undefined) return <CompactPolishedTree layout={from} taxaNames={taxaNames} showLabels={showLabels} />;
  const travel = smoothstep((fraction - 0.12) / 0.68);
  const oneMinus = 1 - travel;
  const source = scene.movingRoot;
  const destination = { x: scene.targetRootX, y: scene.targetRootY };
  const x = oneMinus * oneMinus * source.x + 2 * oneMinus * travel * scene.travelControlX + travel * travel * destination.x;
  const controlY = Math.min(source.y, destination.y) - Math.min(geometry.travelLift, Math.abs(source.y - destination.y) * 0.2 + geometry.travelLift * .4);
  const y = oneMinus * oneMinus * source.y + 2 * oneMinus * travel * controlY + travel * travel * destination.y;
  const dx = x - source.x;
  const dy = y - source.y;
  const sourceOpacity = 1 - clamp01(fraction / 0.12);
  const destinationOpacity = clamp01((fraction - 0.80) / 0.16);
  const internalEdges = scene.layout.edges.filter((edge) => scene.movingKeys.has(edge.parent) && scene.movingKeys.has(edge.child));
  const backgroundEdges = scene.layout.edges.filter((edge) => !scene.movingKeys.has(edge.parent) && !scene.movingKeys.has(edge.child));
  const sourceParent = scene.sourceEdge === undefined ? undefined : scene.layout.nodes.get(scene.sourceEdge.parent);
  return <g>
    <title>{`${turningOn ? "Apply" : "Reverse"} SPR; moving ${move.prunedTaxa.join(", ")}`}</title>
    {backgroundEdges.map((edge) => { const parent = scene.layout.nodes.get(edge.parent)!; const child = scene.layout.nodes.get(edge.child)!; return <path key={edge.key} d={branchPath(parent, child)} fill="none" stroke={edge.child === scene.targetNode.key ? DESTINATION : INK} strokeWidth={edge.child === scene.targetNode.key ? "1.65" : "1.05"} strokeLinecap="round" />; })}
    {sourceParent !== undefined && <path d={branchPath(sourceParent, source)} fill="none" stroke={EVENT} strokeWidth="1.75" opacity={sourceOpacity} />}
    <path d={`M${scene.targetAnchorX},${scene.targetAnchorY} V${scene.targetRootY} H${scene.targetRootX}`} fill="none" stroke={DESTINATION} strokeWidth="1.8" opacity={destinationOpacity} />
    <circle cx={scene.targetAnchorX} cy={scene.targetAnchorY} r="2.8" fill="#fff" stroke={DESTINATION} strokeWidth="1.2" strokeDasharray="1.5 1.5" opacity={Math.max(0.28, destinationOpacity)} />
    {[...scene.layout.nodes.values()].filter((node) => !scene.movingKeys.has(node.key)).map((node) => node.leaf === undefined ? <circle key={node.key} cx={node.x} cy={node.y} r="1.35" fill={INK} /> : <g key={node.key}><circle cx={node.x} cy={node.y} r="1.75" fill={INK} />{showLabels && <text x={node.x + 4} y={node.y + 2.4} fill={INK} fontSize="6.8">{taxaNames[node.leaf] ?? `taxon ${node.leaf + 1}`}</text>}</g>)}
    {sourceParent !== undefined && fraction >= 0.06 && fraction <= 0.90 && <g transform={`translate(${(sourceParent.x + source.x) / 2} ${source.y}) rotate(-18)`}><line x1="-3.2" x2="3.2" y1="-2.7" y2="2.7" stroke={EVENT} strokeWidth="1.5" /><line x1="-3.2" x2="3.2" y1="2.7" y2="-2.7" stroke={EVENT} strokeWidth="1.5" /></g>}
    <g transform={`translate(${dx} ${dy})`}>
      {internalEdges.map((edge) => { const parent = scene.layout.nodes.get(edge.parent)!; const child = scene.layout.nodes.get(edge.child)!; return <path key={edge.key} d={branchPath(parent, child)} fill="none" stroke={EVENT} strokeWidth="1.9" strokeLinecap="round" />; })}
      {[...scene.movingKeys].map((key) => scene.layout.nodes.get(key)!).map((node) => node.leaf === undefined ? <circle key={node.key} cx={node.x} cy={node.y} r="1.7" fill={EVENT} /> : <g key={node.key}><circle cx={node.x} cy={node.y} r="2.25" fill={EVENT} />{showLabels && <text x={node.x + 4} y={node.y + 2.4} fill={EVENT} fontSize="6.8" fontWeight="700">{taxaNames[node.leaf] ?? `taxon ${node.leaf + 1}`}</text>}</g>)}
    </g>
  </g>;
}

type AnimationDirection = "forward" | "reverse" | "hold";

function loopFrame(unit: number, moves: number, maximumMoves: number): { readonly position: number; readonly direction: AnimationDirection } {
  if (moves === 0 || maximumMoves === 0) return { position: 0, direction: "hold" };
  const masterHold = .55;
  const localHold = .8;
  const cycle = masterHold + maximumMoves + localHold + maximumMoves + masterHold;
  let cursor = ((unit % cycle) + cycle) % cycle;
  if (cursor < masterHold) return { position: 0, direction: "hold" };
  cursor -= masterHold;
  if (cursor < maximumMoves) return cursor < moves ? { position: cursor, direction: "forward" } : { position: moves, direction: "hold" };
  cursor -= maximumMoves;
  if (cursor < localHold) return { position: moves, direction: "hold" };
  cursor -= localHold;
  if (cursor < maximumMoves) return cursor < moves ? { position: moves - cursor, direction: "reverse" } : { position: 0, direction: "hold" };
  return { position: 0, direction: "hold" };
}

function treeFrame(path: readonly number[], layouts: readonly (PolishedSprTreeLayout | undefined)[], frame: { readonly position: number; readonly direction: AnimationDirection }, templates: JemsprAnalysisResult["network"]["templates"], taxaNames: readonly string[], showLabels: boolean, geometry: PolishedSceneGeometry): { readonly graphic: ReactNode; readonly status: string } {
  const moves = Math.max(0, path.length - 1);
  if (moves === 0) return { graphic: layouts[0] === undefined ? undefined : <CompactPolishedTree layout={layouts[0]} taxaNames={taxaNames} showLabels={showLabels} />, status: "Master tree" };
  const rounded = Math.round(frame.position);
  if (frame.direction === "hold" || Math.abs(frame.position - rounded) < 1e-5) {
    const index = Math.max(0, Math.min(moves, rounded));
    const layout = layouts[index];
    return { graphic: layout === undefined ? undefined : <CompactPolishedTree layout={layout} taxaNames={taxaNames} showLabels={showLabels} />, status: index === 0 ? "Master tree" : "Local tree" };
  }
  const fromIndex = frame.direction === "forward" ? Math.floor(frame.position) : Math.ceil(frame.position);
  const toIndex = frame.direction === "forward" ? fromIndex + 1 : fromIndex - 1;
  const fraction = frame.direction === "forward" ? frame.position - fromIndex : fromIndex - frame.position;
  const from = layouts[fromIndex];
  const to = layouts[toIndex];
  const fromMask = path[fromIndex];
  const toMask = path[toIndex];
  if (from === undefined || to === undefined || fromMask === undefined || toMask === undefined) return { graphic: undefined, status: "Display unavailable" };
  const changed = fromMask ^ toMask;
  const bit = changed === 0 ? -1 : Math.round(Math.log2(changed));
  const template = templates.find((candidate) => candidate.bit === bit);
  if (template === undefined) return { graphic: <CompactPolishedTree layout={from} taxaNames={taxaNames} showLabels={showLabels} />, status: "Display transition" };
  const turningOn = (toMask & (1 << bit)) !== 0;
  return {
    graphic: <CompactPolishedSprMove from={from} to={to} fraction={fraction} taxaNames={taxaNames} showLabels={showLabels} move={template.move} turningOn={turningOn} geometry={geometry} />,
    status: `${turningOn ? "Apply" : "Reverse"} R${bit + 1}`,
  };
}

export function JemsprSprAnimationFigure({ result }: { readonly result: JemsprAnalysisResult }) {
  const titleId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const parsed = useMemo(() => parseJemsprSwitchingNetwork(result.networkJson), [result.networkJson]);
  const linked = result.likelihood.status === "complete" ? result.likelihood : undefined;
  const runs = linked?.runs ?? [];
  const [speed, setSpeed] = useState(1);
  const [playing, setPlaying] = useState(true);
  const [cycleUnit, setCycleUnit] = useState(0);
  const [showLabels, setShowLabels] = useState(false);
  const polishedTrees = useMemo(() => {
    const byMask = new Map<number, string>();
    if (linked !== undefined) {
      for (const tree of linked.trees) byMask.set(tree.mask, tree.tree);
      byMask.set(0, linked.masterTree);
    }
    return byMask;
  }, [linked]);
  const paths = useMemo(() => runs.map((run) => displayMaskPath(parsed.network, run.mask)), [runs, parsed.network]);
  const maximumMoves = Math.max(0, ...paths.map((path) => path.length - 1));
  useEffect(() => {
    if (!playing || maximumMoves === 0) return;
    let previous = performance.now();
    let frame = 0;
    const tick = (now: number): void => {
      const delta = (now - previous) / (1500 / speed);
      previous = now;
      setCycleUnit((current) => current + delta);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, maximumMoves, speed]);
  useEffect(() => { setCycleUnit(0); }, [runs.map((run) => `${run.start}-${run.end}-${run.mask}`).join("|")]);
  const strip = useMemo(() => {
    const taxa = Math.max(1, parsed.taxaNames.length);
    const treeHeight = Math.max(108, Math.min(250, 28 + taxa * 7.2));
    const minimumSegment = showLabels ? 320 : 244;
    const totalSites = Math.max(1, result.sites, ...runs.map((run) => run.end));
    const segmentWidths = runs.map((run) => Math.max(minimumSegment, (run.end - run.start + 1) / totalSites * 960));
    const left = 26;
    const starts: number[] = [];
    let cursor = left;
    for (const segmentWidth of segmentWidths) { starts.push(cursor); cursor += segmentWidth; }
    const width = Math.max(760, cursor + 26);
    const treeTop = 110;
    const height = treeTop + treeHeight + 42;
    const panelWidth = showLabels ? 300 : 224;
    const layoutWidth = showLabels ? 210 : 204;
    const geometry: PolishedSceneGeometry = { width: layoutWidth, height: treeHeight, padding: 10, targetRootLimit: layoutWidth + 3, travelRight: panelWidth - 18, travelLift: Math.max(20, Math.min(42, treeHeight * .23)) };
    const ceiling = Math.max(1e-9, ...[...polishedTrees.values()].map((tree) => layoutPolishedSprTree(tree, parsed.taxaNames, 100, 100, 10).maximumDistance));
    const layouts = paths.map((path) => path.map((mask) => {
      const tree = polishedTrees.get(mask);
      return tree === undefined ? undefined : layoutPolishedSprTree(tree, parsed.taxaNames, layoutWidth, treeHeight, geometry.padding, ceiling);
    }));
    const firstLayout = layouts.flat().find((layout): layout is PolishedSprTreeLayout => layout !== undefined);
    return { treeHeight, segmentWidths, left, starts, width, treeTop, height, panelWidth, geometry, layouts, sharedScale: firstLayout === undefined ? undefined : scaleBar(firstLayout) };
  }, [parsed.taxaNames, paths, polishedTrees, result.sites, runs, showLabels]);
  if (linked === undefined) return <article className="figure-card"><div className="figure-card__heading"><div><strong>Animated genomic SPR strip</strong><span>All regional trees cycle from one polished master phylogram.</span></div></div><div className="figure-empty"><strong>Linked-ML trees are required for this animation.</strong><span>{result.likelihood.status === "skipped" ? result.likelihood.reason : "Run JEMSPR with linked branch-length likelihood enabled."} EvoOnline deliberately does not substitute an unpolished parsimony cladogram.</span></div></article>;
  const { treeHeight, segmentWidths, left, starts, width, treeTop, height, panelWidth, geometry, layouts, sharedScale } = strip;
  return <article className="figure-card">
    <div className="figure-card__heading"><div><strong>Animated genomic SPR strip</strong><span>Likelihood-refined alignment regions sit directly above compact local phylograms. Every panel loops master → ordered SPRs → local tree → master; during a move, only the cut clade moves.</span></div><button type="button" className="button button--secondary button--svg" onClick={() => svgRef.current !== null && downloadSvg(svgRef.current, "JEMSPR-genomic-SPR-animation-frame")}>Export SVG</button></div>
    <div className="tree-figure-controls jemspr-spr-loop-controls"><label><span>Animation speed {speed.toFixed(2)}×</span><input type="range" min="0.25" max="3" step="0.25" value={speed} onChange={(event) => setSpeed(Number(event.target.value))} /></label><label className="toggle"><input type="checkbox" checked={showLabels} onChange={(event) => setShowLabels(event.target.checked)} /><span>Tip labels</span></label><button type="button" className="button button--primary" disabled={maximumMoves === 0} onClick={() => setPlaying((value) => !value)}>{playing ? "Pause loop" : "Play loop"}</button><button type="button" className="button button--secondary" onClick={() => { setPlaying(false); setCycleUnit(0); }}>Reset to master</button><span className="jemspr-spr-loop-hint">Native horizontal scrolling · orange = moving clade · green = regraft target</span></div>
    <div className="jemspr-spr-strip-scroll"><svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-labelledby={titleId} style={{ display: "block", background: "#fff", fontFamily: FONT }}>
      <title id={titleId}>JEMSPR alignment-linked regional trees animated from the linked-ML master by ordered SPR moves</title><rect width={width} height={height} fill="#fff" />
      <text x={left} y="23" fill={INK} fontSize="13" fontWeight="720">Likelihood-refined alignment layout</text><text x={left} y="39" fill="#65736f" fontSize="8">Regions are widened only when needed to keep their trees legible; coordinates remain the inferred nucleotide coordinates.</text>
      {runs.map((run, index) => {
        const segmentX = starts[index]!;
        const segmentWidth = segmentWidths[index]!;
        const color = result.network.trees.find((tree) => tree.masks.includes(run.mask))?.color ?? SPR_REGION_COLORS[index % SPR_REGION_COLORS.length]!;
        const current = loopFrame(cycleUnit, Math.max(0, paths[index]!.length - 1), maximumMoves);
        const rendered = treeFrame(paths[index]!, layouts[index]!, current, result.network.templates, parsed.taxaNames, showLabels, geometry);
        const localPanelWidth = Math.min(panelWidth, segmentWidth - 14);
        const panelX = segmentX + (segmentWidth - localPanelWidth) / 2;
        const missing = paths[index]!.find((mask, pathIndex) => layouts[index]![pathIndex] === undefined);
        return <g key={`${run.start}-${run.end}-${run.mask}`}>
          <rect x={segmentX} y="50" width={segmentWidth} height="16" fill={color} stroke="#fff" strokeWidth="1"><title>{`Region ${index + 1}: ${run.start}–${run.end}; mask ${run.mask}`}</title></rect>
          <text x={segmentX + segmentWidth / 2} y="61.5" textAnchor="middle" fill="#fff" fontSize="7.2" fontWeight="800">{`R${index + 1} · ${run.start}–${run.end}`}</text>
          <line x1={segmentX + segmentWidth / 2} x2={segmentX + segmentWidth / 2} y1="66" y2="76" stroke={color} strokeWidth="1.2" />
          <rect x={panelX} y="76" width={localPanelWidth} height={treeHeight + 48} rx="6" fill="#fbfcfb" stroke={color} strokeWidth="1.15" />
          <text x={panelX + 8} y="89" fill={color} fontSize="8" fontWeight="800">{`Region ${index + 1} · mask ${run.mask.toString(2).padStart(result.network.templates.length, "0")}`}</text>
          <text x={panelX + 8} y="101" fill="#63736f" fontSize="7">{missing === undefined ? rendered.status : `Linked-ML display ${missing} unavailable`}</text>
          <g transform={`translate(${panelX + 8} ${treeTop})`}>{missing === undefined ? rendered.graphic : undefined}</g>
        </g>;
      })}
      {sharedScale !== undefined && <g transform={`translate(${left} ${height - 18})`}><line x1="0" x2={sharedScale.pixels} y1="0" y2="0" stroke={INK} strokeWidth="1.1" /><line x1="0" x2="0" y1="-3" y2="3" stroke={INK} /><line x1={sharedScale.pixels} x2={sharedScale.pixels} y1="-3" y2="3" stroke={INK} /><text x={sharedScale.pixels + 7} y="3" fill="#65736f" fontSize="7.5">{`${sharedScale.amount.toPrecision(2)} substitutions/site · shared linked-ML scale`}</text></g>}
    </svg></div>
  </article>;
}

function StaticTree({ layout, taxaNames, x, y, scale = .46 }: { readonly layout: SprTreeLayout; readonly taxaNames: readonly string[]; readonly x: number; readonly y: number; readonly scale?: number }) {
  return <g transform={`translate(${x} ${y}) scale(${scale})`}><MorphTree from={layout} to={layout} fraction={1} taxaNames={taxaNames} showLabels={false} /></g>;
}

export function JemsprSprStoryboardFigure({ result }: { readonly result: JemsprAnalysisResult }) {
  const titleId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const parsed = useMemo(() => parseJemsprSwitchingNetwork(result.networkJson), [result.networkJson]);
  const [event, setEvent] = useState(0);
  const template = result.network.templates[Math.min(event, Math.max(0, result.network.templates.length - 1))];
  const compiled = parsed.network.reticulations.find((candidate) => candidate.bit === template?.bit);
  const beforeMask = compiled?.sourceContextMask ?? 0;
  const afterMask = template === undefined ? beforeMask : beforeMask | (1 << template.bit);
  const before = exactDisplayLayout(parsed.network, beforeMask);
  const after = exactDisplayLayout(parsed.network, afterMask);
  return <article className="figure-card"><div className="figure-card__heading"><div><strong>SPR move storyboard</strong><span>Exact source-context display before and after each compiled event, with the persistent pruned clade and regraft target written explicitly.</span></div><button type="button" className="button button--secondary button--svg" onClick={() => svgRef.current !== null && downloadSvg(svgRef.current, "JEMSPR-SPR-storyboard")}>Export SVG</button></div><div className="tree-figure-controls"><label><span>Event template</span><select value={event} onChange={(value) => setEvent(Number(value.target.value))}>{result.network.templates.map((item, index) => <option value={index} key={item.id}>{`${item.id}: prune ${item.move.prunedTaxa.join("+")}`}</option>)}</select></label></div>{template === undefined ? <div className="figure-empty"><strong>No retained SPR templates.</strong><span>The selected network is the latent master alone.</span></div> : <div className="figure-scroll"><svg ref={svgRef} viewBox="0 0 1120 300" width="1120" height="300" role="img" aria-labelledby={titleId} style={{ display: "block", background: "#fff", fontFamily: FONT }}><title id={titleId}>JEMSPR SPR move storyboard</title><rect width="1120" height="300" fill="#fff" /><text x="36" y="28" fill={INK} fontSize="18" fontWeight="700">{template.id}: exact rooted-SPR transformation</text><text x="36" y="50" fill={EVENT} fontSize="10" fontWeight="700">Prune {template.move.prunedTaxa.join(", ")}</text><text x="360" y="50" fill={DESTINATION} fontSize="10" fontWeight="700">Regraft {template.move.destinationIsRoot ? "above the root" : `beside ${template.move.destinationTaxa.join(", ")}`}</text><text x="90" y="77" fill={INK} fontSize="11" fontWeight="700">Source context · {beforeMask.toString(2).padStart(result.network.templates.length, "0")}</text><text x="750" y="77" fill={INK} fontSize="11" fontWeight="700">After event · {afterMask.toString(2).padStart(result.network.templates.length, "0")}</text><StaticTree layout={before} taxaNames={parsed.taxaNames} x={20} y={65} /><StaticTree layout={after} taxaNames={parsed.taxaNames} x={670} y={65} /><path d="M515,166 C545,120 575,120 605,166" fill="none" stroke={EVENT} strokeWidth="4" /><path d="M595,155 L607,166 L592,171" fill="none" stroke={EVENT} strokeWidth="4" /></svg></div>}</article>;
}

export function JemsprDisplayGraphFigure({ result }: { readonly result: JemsprAnalysisResult }) {
  const titleId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const bitCount = result.network.templates.length;
  const occupied = new Set(result.network.runs.map((run) => run.mask));
  const masks = bitCount <= 5 ? Array.from({ length: 1 << bitCount }, (_value, mask) => mask) : [...new Set([0, ...occupied, ...result.network.runs.flatMap((run) => maskPath(run.mask, bitCount))])].sort((a, b) => a - b);
  const byMask = new Map(masks.map((mask, index) => [mask, index]));
  const columns = Math.min(8, Math.max(1, masks.length));
  const rows = Math.ceil(masks.length / columns);
  const width = 1080;
  const height = 105 + rows * 88;
  const position = (index: number) => ({ x: 65 + (index % columns) * ((width - 130) / Math.max(1, columns - 1)), y: 90 + Math.floor(index / columns) * 88 });
  const edges: Array<{ from: number; to: number; bit: number }> = [];
  for (const mask of masks) for (let bit = 0; bit < bitCount; bit += 1) {
    const other = mask ^ (1 << bit);
    if (mask < other && byMask.has(other)) edges.push({ from: mask, to: other, bit });
  }
  return <article className="figure-card"><div className="figure-card__heading"><div><strong>SPR display-state graph</strong><span>Nodes are exact trees displayed by event masks; each edge toggles one persistent SPR template. Genomically occupied displays are filled.</span></div><button type="button" className="button button--secondary button--svg" onClick={() => svgRef.current !== null && downloadSvg(svgRef.current, "JEMSPR-display-state-graph")}>Export SVG</button></div><div className="figure-scroll"><svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-labelledby={titleId} style={{ display: "block", background: "#fff", fontFamily: FONT }}><title id={titleId}>JEMSPR SPR display-state graph</title><rect width={width} height={height} fill="#fff" /><text x="32" y="27" fill={INK} fontSize="18" fontWeight="700">Exact display trees connected by single SPR events</text><text x="32" y="47" fill="#65736f" fontSize="10">Master = mask 0 · filled = used along the genomic path · outline = valid but unoccupied intermediate</text>{edges.map((edge) => { const a = position(byMask.get(edge.from)!); const b = position(byMask.get(edge.to)!); return <g key={`${edge.from}-${edge.to}`}><line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#a6b0ad" strokeWidth="1.3" /><text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 4} textAnchor="middle" fill={EVENT} fontSize="8" fontWeight="750">R{edge.bit + 1}</text></g>; })}{masks.map((mask, index) => { const point = position(index); const span = result.network.runs.filter((run) => run.mask === mask).reduce((sum, run) => sum + run.end - run.start + 1, 0); const isOccupied = occupied.has(mask); return <g key={mask}><circle cx={point.x} cy={point.y} r={mask === 0 ? 25 : 21} fill={isOccupied ? DESTINATION : "#fff"} stroke={mask === 0 ? EVENT : DESTINATION} strokeWidth={mask === 0 ? 3 : 1.6} /><text x={point.x} y={point.y - 1} textAnchor="middle" fill={isOccupied ? "#fff" : INK} fontSize="9" fontWeight="800">{mask === 0 ? "MASTER" : mask.toString(2).padStart(bitCount, "0")}</text><text x={point.x} y={point.y + 11} textAnchor="middle" fill={isOccupied ? "#dff6f1" : "#65736f"} fontSize="7">{span > 0 ? `${span} sites` : "unoccupied"}</text></g>; })}</svg></div></article>;
}

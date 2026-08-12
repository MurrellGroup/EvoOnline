import { useId, useMemo, useRef, useState } from "react";
import { parseNewick, type ParsedTree, type TreeNode } from "@phylo-workbench/model-diffubar/browser-source";
import type { CladeShiftRunResult } from "../types.js";
import { downloadSvg } from "../lib/svg-export.js";
import { CommittedNumberInput } from "./CommittedNumberInput.js";

const FONT = "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
const INK = "#172321";
type Metric = "site-direction" | "site-posterior" | "expected" | "burden-direction" | "maximum";
interface Position { readonly x: number; readonly y: number }

function channels(hex: string): readonly [number, number, number] {
  return [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16)];
}

function mix(left: string, right: string, fraction: number): string {
  const a = channels(left);
  const b = channels(right);
  const t = Math.max(0, Math.min(1, fraction));
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * t)},${Math.round(a[1] + (b[1] - a[1]) * t)},${Math.round(a[2] + (b[2] - a[2]) * t)})`;
}

function layout(tree: ParsedTree) {
  const raw = new Map<TreeNode, Position>();
  let tip = 0;
  let maximum = 0;
  const visit = (node: TreeNode, distance: number): number => {
    maximum = Math.max(maximum, distance);
    const y = node.children.length === 0 ? tip++ : node.children.map((child) => visit(child, distance + child.branchLength)).reduce((sum, value, _index, all) => sum + value / all.length, 0);
    raw.set(node, { x: distance, y });
    return y;
  };
  visit(tree.root, 0);
  const denominator = Math.max(1e-12, maximum);
  return { positions: new Map([...raw].map(([node, point]) => [node, { x: point.x / denominator, y: point.y }])), maximum };
}

export function CladeShiftTreeFigure({
  result,
  selectedSite,
  onSelectSite,
  selectedBranch,
  onSelectBranch,
}: {
  readonly result: CladeShiftRunResult;
  readonly selectedSite: number;
  readonly onSelectSite: (site: number) => void;
  readonly selectedBranch: number;
  readonly onSelectBranch: (branch: number) => void;
}) {
  const titleId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const [title, setTitle] = useState("Where did the persistent shift begin?");
  const [metric, setMetric] = useState<Metric>("site-direction");
  const [showTips, setShowTips] = useState(true);
  const [showInternal, setShowInternal] = useState(false);
  const [showValues, setShowValues] = useState(false);
  const [width, setWidth] = useState(1_100);
  const [rowHeight, setRowHeight] = useState(24);
  const [labelSize, setLabelSize] = useState(11);
  const [lineWidth, setLineWidth] = useState(2.5);
  const parsed = useMemo(() => {
    try { return { tree: parseNewick(result.tree) } as const; }
    catch (error) { return { error: error instanceof Error ? error.message : String(error) } as const; }
  }, [result.tree]);
  const byNode = useMemo(() => new Map(result.branches.map((branch) => [branch.nodeId, branch])), [result.branches]);
  const value = (branch: CladeShiftRunResult["branches"][number]): number => {
    const index = (branch.branch - 1) * result.posterior.siteCount + selectedSite - 1;
    if (metric === "site-direction") return result.posterior.branchIntensification[index]! - result.posterior.branchRelaxation[index]!;
    if (metric === "site-posterior") return result.posterior.branchPosterior[index]!;
    if (metric === "expected") return branch.expectedShiftedSites;
    if (metric === "burden-direction") return branch.expectedIntensifiedSites - branch.expectedRelaxedSites;
    return branch.maximumSitePosterior;
  };
  const values = result.branches.map(value).filter(Number.isFinite);
  const diverging = metric === "site-direction" || metric === "burden-direction";
  const bound = diverging ? Math.max(1e-9, ...values.map(Math.abs)) : Math.max(1e-9, ...values);
  const color = (branch: CladeShiftRunResult["branches"][number] | undefined): string => {
    if (branch === undefined || !branch.eligible) return "#c5cdca";
    const score = value(branch);
    if (diverging) return score < 0 ? mix("#4267d5", "#e3e7e5", 1 + score / bound) : mix("#e3e7e5", "#df4652", score / bound);
    return mix("#dce3e0", "#087f6f", score / bound);
  };
  const metricLabel = {
    "site-direction": `Codon ${selectedSite}: initiating-branch posterior direction`,
    "site-posterior": `Codon ${selectedSite}: P(branch initiated shift)`,
    expected: "Expected shifted-site count",
    "burden-direction": "Expected intensified minus relaxed sites",
    maximum: "Maximum site posterior on branch",
  }[metric];

  if ("error" in parsed) return <div className="figure-empty"><strong>Tree preview unavailable.</strong><span>{parsed.error}</span></div>;
  const tree = parsed.tree;
  const treeLayout = layout(tree);
  const left = 34;
  const top = 86;
  const bottom = 48;
  const labelGutter = showTips ? Math.min(340, Math.max(150, width * 0.25)) : 30;
  const plotWidth = Math.max(220, width - left - labelGutter);
  const height = Math.max(220, top + bottom + Math.max(1, tree.tips.length - 1) * rowHeight);
  const x = (node: TreeNode): number => left + treeLayout.positions.get(node)!.x * plotWidth;
  const y = (node: TreeNode): number => top + treeLayout.positions.get(node)!.y * rowHeight;

  return <article className="figure-card clade-shift-tree-card">
    <div className="figure-card__heading"><div><strong>{title}</strong><span>Each colored edge is a candidate change point; its descendant subtree inherits the shifted selection intensity.</span></div><button type="button" className="button button--secondary button--svg" onClick={() => svgRef.current !== null && downloadSvg(svgRef.current, title)}>Export SVG</button></div>
    <div className="tree-figure-controls bsrel-tree-controls">
      <label><span>Figure title</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label><span>Branch color</span><select value={metric} onChange={(event) => setMetric(event.target.value as Metric)}><option value="site-direction">Selected-site direction</option><option value="site-posterior">Selected-site branch posterior</option><option value="expected">Expected shifted sites</option><option value="burden-direction">Gene-wide direction burden</option><option value="maximum">Maximum site posterior</option></select></label>
      <label><span>Selected codon</span><CommittedNumberInput value={selectedSite} onCommit={onSelectSite} min={1} max={result.posterior.siteCount} /></label>
      <label><span>Width {width}px</span><input type="range" min="650" max="1900" step="50" value={width} onChange={(event) => setWidth(Number(event.target.value))} /></label>
      <label><span>Tip spacing {rowHeight}px</span><input type="range" min="14" max="44" value={rowHeight} onChange={(event) => setRowHeight(Number(event.target.value))} /></label>
      <label><span>Label size {labelSize}px</span><input type="range" min="8" max="20" value={labelSize} onChange={(event) => setLabelSize(Number(event.target.value))} /></label>
      <label><span>Line width {lineWidth}px</span><input type="range" min="1" max="7" step="0.25" value={lineWidth} onChange={(event) => setLineWidth(Number(event.target.value))} /></label>
      <label className="toggle"><input type="checkbox" checked={showTips} onChange={(event) => setShowTips(event.target.checked)} /><span>Tip labels</span></label>
      <label className="toggle"><input type="checkbox" checked={showInternal} onChange={(event) => setShowInternal(event.target.checked)} /><span>Internal labels</span></label>
      <label className="toggle"><input type="checkbox" checked={showValues} onChange={(event) => setShowValues(event.target.checked)} /><span>Branch values</span></label>
    </div>
    <div className="figure-scroll figure-scroll--tall"><svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-labelledby={titleId} style={{ display: "block", minWidth: `${Math.min(width, 760)}px`, width: "100%", height: "auto", background: "#fff", fontFamily: FONT }}>
      <title id={titleId}>{title}</title>
      <text x={left} y="28" fill={INK} fontSize="20" fontWeight="650">{title}</text>
      <g transform={`translate(${left} 49)`} fontSize="9" fill="#566762"><text x="0" y="8">{metricLabel}</text>{diverging && <><rect x="300" y="0" width="70" height="9" fill="#4267d5" /><rect x="370" y="0" width="45" height="9" fill="#e3e7e5" /><rect x="415" y="0" width="70" height="9" fill="#df4652" /><text x="492" y="8">intensified</text></>}{!diverging && <><rect x="300" y="0" width="185" height="9" fill="#087f6f" opacity="0.75" /><text x="492" y="8">higher</text></>}</g>
      {tree.nodes.filter((node) => node.children.length > 0).map((node) => { const childYs = node.children.map(y); return childYs.length < 2 ? null : <line key={`v-${node.id}`} x1={x(node)} x2={x(node)} y1={Math.min(...childYs)} y2={Math.max(...childYs)} stroke="#87948f" strokeWidth="1" />; })}
      {tree.nodes.filter((node) => node !== tree.root).map((node) => {
        const branch = byNode.get(node.id);
        const selected = branch?.branch === selectedBranch;
        return <g key={`b-${node.id}`} onClick={() => branch !== undefined && onSelectBranch(branch.branch)} style={{ cursor: branch === undefined ? "default" : "pointer" }}><title>{branch === undefined ? node.name : `${branch.name} · ${metricLabel}: ${value(branch).toPrecision(4)} · ${branch.descendantTips} descendant tips`}</title><line x1={x(node.parent!)} x2={x(node)} y1={y(node)} y2={y(node)} stroke={color(branch)} strokeWidth={lineWidth + (selected ? 3 : 0)} strokeLinecap="round" />{showValues && branch !== undefined && <text x={(x(node.parent!) + x(node)) / 2} y={y(node) - 4} textAnchor="middle" fill="#52615d" fontSize={Math.max(7, labelSize - 3)}>{value(branch).toPrecision(3)}</text>}</g>;
      })}
      {tree.nodes.map((node) => <circle key={`n-${node.id}`} cx={x(node)} cy={y(node)} r={node === tree.root ? 2.4 : 1.8} fill={node === tree.root ? INK : color(byNode.get(node.id))} />)}
      {showTips && tree.tips.map((tip) => <text key={`tip-${tip.id}`} x={x(tip) + 7} y={y(tip) + labelSize * 0.34} fill={INK} fontSize={labelSize}>{tip.name}</text>)}
      {showInternal && tree.nodes.filter((node) => node.children.length > 0 && node.name.length > 0).map((node) => <text key={`int-${node.id}`} x={x(node) + 5} y={y(node) - 5} fill="#52615d" fontSize={Math.max(8, labelSize - 1)}>{node.name}</text>)}
      <text x={left} y={height - 12} fill="#6d7976" fontSize="9">Root-to-tip distance max {treeLayout.maximum.toPrecision(4)} · gray branches were excluded by the minimum-clade-size rule</text>
    </svg></div>
  </article>;
}

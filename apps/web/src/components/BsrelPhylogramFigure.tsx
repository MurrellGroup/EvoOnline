import { useId, useMemo, useRef, useState } from "react";
import { parseNewick, type ParsedTree, type TreeNode } from "@phylo-workbench/model-diffubar/browser-source";
import type { BsrelRunResult } from "../types.js";
import { downloadSvg } from "../lib/svg-export.js";

const INK = "#172321";
const MUTED = "#8b9894";
const FONT = "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";

type ColorMetric = "holm" | "lrt" | "omega-positive" | "positive-weight" | "mean-omega" | "branch-length";

interface Position { readonly x: number; readonly y: number }

function hexChannels(hex: string): readonly [number, number, number] {
  return [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16)];
}

function mixColor(left: string, right: string, amount: number): string {
  const a = hexChannels(left);
  const b = hexChannels(right);
  const t = Math.max(0, Math.min(1, amount));
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * t)},${Math.round(a[1] + (b[1] - a[1]) * t)},${Math.round(a[2] + (b[2] - a[2]) * t)})`;
}

function layoutTree(tree: ParsedTree, lengths: ReadonlyMap<number, number>): { readonly positions: ReadonlyMap<TreeNode, Position>; readonly maximumDistance: number } {
  const raw = new Map<TreeNode, Position>();
  let row = 0;
  let maximumDistance = 0;
  const visit = (node: TreeNode, distance: number): number => {
    maximumDistance = Math.max(maximumDistance, distance);
    const y = node.children.length === 0
      ? row++
      : node.children.map((child) => visit(child, distance + (lengths.get(child.id) ?? child.branchLength)))
        .reduce((sum, value, _index, values) => sum + value / values.length, 0);
    raw.set(node, { x: distance, y });
    return y;
  };
  visit(tree.root, 0);
  const denominator = Math.max(maximumDistance, 1e-12);
  return {
    positions: new Map([...raw].map(([node, position]) => [node, { x: position.x / denominator, y: position.y }])),
    maximumDistance,
  };
}

function metricLabel(metric: ColorMetric): string {
  return {
    holm: "−log₁₀ Holm p",
    lrt: "Likelihood-ratio statistic",
    "omega-positive": "Positive-class ω",
    "positive-weight": "Positive-class site fraction",
    "mean-omega": "Mean ω",
    "branch-length": "Fitted branch length",
  }[metric];
}

function branchMetric(branch: BsrelRunResult["branches"][number], metric: ColorMetric): number | null {
  if (metric === "holm") return branch.pValueHolm === null ? null : -Math.log10(Math.max(1e-12, branch.pValueHolm));
  if (metric === "lrt") return branch.likelihoodRatio;
  if (metric === "omega-positive") return Math.log10(Math.max(1, branch.omegaPositive));
  if (metric === "positive-weight") return branch.weightPositive;
  if (metric === "mean-omega") return Math.log2(Math.max(1e-4, branch.meanOmega));
  return Math.log10(Math.max(1e-8, branch.fittedLength));
}

function formatBranchValue(branch: BsrelRunResult["branches"][number], metric: ColorMetric): string {
  if (metric === "holm") return branch.pValueHolm === null ? "not tested" : `Holm p=${branch.pValueHolm.toPrecision(3)}`;
  if (metric === "lrt") return branch.likelihoodRatio === null ? "not tested" : `LRT=${branch.likelihoodRatio.toFixed(2)}`;
  if (metric === "omega-positive") return `ω+=${branch.omegaPositive.toPrecision(3)}`;
  if (metric === "positive-weight") return `q+=${branch.weightPositive.toFixed(3)}`;
  if (metric === "mean-omega") return `mean ω=${branch.meanOmega.toPrecision(3)}`;
  return `length=${branch.fittedLength.toPrecision(3)}`;
}

export function BsrelPhylogramFigure({
  newick,
  branches,
  threshold,
  selectedBranch,
  onSelectBranch,
}: {
  readonly newick: string;
  readonly branches: BsrelRunResult["branches"];
  readonly threshold: number;
  readonly selectedBranch: number | null;
  readonly onSelectBranch: (branch: number) => void;
}) {
  const titleId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const [title, setTitle] = useState("BS-REL branch-wise episodic selection");
  const [metric, setMetric] = useState<ColorMetric>("holm");
  const [showTipLabels, setShowTipLabels] = useState(true);
  const [showInternalLabels, setShowInternalLabels] = useState(false);
  const [showValues, setShowValues] = useState(false);
  const [width, setWidth] = useState(1_100);
  const [rowHeight, setRowHeight] = useState(24);
  const [labelSize, setLabelSize] = useState(11);
  const [branchWidth, setBranchWidth] = useState(2);
  const gradientId = `${titleId.replaceAll(":", "")}-legend`;
  const parsed = useMemo(() => {
    try { return { tree: parseNewick(newick) } as const; }
    catch (error) { return { error: error instanceof Error ? error.message : String(error) } as const; }
  }, [newick]);
  const resultByNode = useMemo(() => new Map(branches.map((branch) => [branch.nodeId, branch])), [branches]);
  const lengths = useMemo(() => new Map(branches.map((branch) => [branch.nodeId, branch.fittedLength])), [branches]);
  const metricRange = useMemo(() => {
    const values = branches.map((branch) => branchMetric(branch, metric)).filter((value): value is number => value !== null && Number.isFinite(value));
    if (metric === "mean-omega") return { minimum: -4, maximum: 4 };
    const minimum = metric === "branch-length" ? Math.min(...values, 0) : 0;
    const maximum = Math.max(metric === "holm" ? 3 : 1e-9, ...values);
    return { minimum, maximum: maximum > minimum ? maximum : minimum + 1 };
  }, [branches, metric]);

  if ("error" in parsed) return <div className="figure-empty"><strong>Tree preview unavailable.</strong><span>{parsed.error}</span></div>;
  const tree = parsed.tree;
  const layout = layoutTree(tree, lengths);
  const left = 34;
  const top = 82;
  const bottom = 50;
  const labelGutter = showTipLabels ? Math.min(340, Math.max(150, width * 0.25)) : 28;
  const plotWidth = Math.max(200, width - left - labelGutter);
  const height = Math.max(210, top + bottom + Math.max(1, tree.tips.length - 1) * rowHeight);
  const x = (node: TreeNode): number => left + layout.positions.get(node)!.x * plotWidth;
  const y = (node: TreeNode): number => top + layout.positions.get(node)!.y * rowHeight;
  const color = (branch: BsrelRunResult["branches"][number] | undefined): string => {
    if (branch === undefined) return MUTED;
    const value = branchMetric(branch, metric);
    if (value === null) return "#b7c0bd";
    if (metric === "mean-omega") {
      if (value < 0) return mixColor("#2457c5", "#d8dddb", (value + 4) / 4);
      return mixColor("#d8dddb", "#d9343f", value / 4);
    }
    const scaled = (value - metricRange.minimum) / (metricRange.maximum - metricRange.minimum);
    return mixColor("#b9c5c1", metric === "branch-length" ? "#087f6f" : "#e33b45", Math.sqrt(Math.max(0, scaled)));
  };

  return (
    <article className="figure-card bsrel-tree-card">
      <div className="figure-card__heading">
        <div><strong>{title}</strong><span>Horizontal distance uses fitted branch lengths; click any edge to select its table row.</span></div>
        <button type="button" className="button button--secondary button--svg" onClick={() => svgRef.current !== null && downloadSvg(svgRef.current, title)}>Export SVG</button>
      </div>
      <div className="tree-figure-controls bsrel-tree-controls">
        <label><span>Figure title</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label><span>Branch color</span><select value={metric} onChange={(event) => setMetric(event.target.value as ColorMetric)}>
          <option value="holm">Holm p-value</option><option value="lrt">LRT</option><option value="omega-positive">Positive ω</option>
          <option value="positive-weight">Positive site fraction</option><option value="mean-omega">Mean ω</option><option value="branch-length">Fitted branch length</option>
        </select></label>
        <label><span>Width {width}px</span><input type="range" min="650" max="1900" step="50" value={width} onChange={(event) => setWidth(Number(event.target.value))} /></label>
        <label><span>Tip spacing {rowHeight}px</span><input type="range" min="14" max="44" value={rowHeight} onChange={(event) => setRowHeight(Number(event.target.value))} /></label>
        <label><span>Label size {labelSize}px</span><input type="range" min="8" max="20" value={labelSize} onChange={(event) => setLabelSize(Number(event.target.value))} /></label>
        <label><span>Line width {branchWidth}px</span><input type="range" min="1" max="6" step="0.25" value={branchWidth} onChange={(event) => setBranchWidth(Number(event.target.value))} /></label>
        <label className="toggle"><input type="checkbox" checked={showTipLabels} onChange={(event) => setShowTipLabels(event.target.checked)} /><span>Tip labels</span></label>
        <label className="toggle"><input type="checkbox" checked={showInternalLabels} onChange={(event) => setShowInternalLabels(event.target.checked)} /><span>Internal labels</span></label>
        <label className="toggle"><input type="checkbox" checked={showValues} onChange={(event) => setShowValues(event.target.checked)} /><span>Branch values</span></label>
      </div>
      <div className="figure-scroll figure-scroll--tall">
        <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-labelledby={titleId}
          style={{ display: "block", minWidth: `${Math.min(width, 760)}px`, width: "100%", height: "auto", background: "#fff", fontFamily: FONT }}>
          <title id={titleId}>{title}</title>
          <defs><linearGradient id={gradientId} x1="0" x2="1"><stop offset="0" stopColor={metric === "mean-omega" ? "#2457c5" : "#b9c5c1"} /><stop offset="0.5" stopColor={metric === "mean-omega" ? "#d8dddb" : mixColor("#b9c5c1", metric === "branch-length" ? "#087f6f" : "#e33b45", 0.5)} /><stop offset="1" stopColor={metric === "branch-length" ? "#087f6f" : "#e33b45"} /></linearGradient></defs>
          <text x={left} y="28" fill={INK} fontSize="20" fontWeight="650">{title}</text>
          <g transform={`translate(${left} 47)`} fontSize="9" fill="#566762">
            <text x="0" y="8">{metricLabel(metric)}</text><rect x="145" y="0" width="150" height="9" rx="4" fill={`url(#${gradientId})`} />
            <text x="301" y="8">{metric === "holm" ? `significant ≤ ${threshold.toPrecision(2)}` : "high"}</text>
          </g>
          {tree.nodes.filter((node) => node.children.length > 0).map((node) => {
            const childYs = node.children.map(y);
            return childYs.length < 2 ? null : <line key={`v-${node.id}`} x1={x(node)} x2={x(node)} y1={Math.min(...childYs)} y2={Math.max(...childYs)} stroke="#87948f" strokeWidth="1" />;
          })}
          {tree.nodes.filter((node) => node !== tree.root).map((node) => {
            const branch = resultByNode.get(node.id);
            const significant = branch?.pValueHolm !== null && branch?.pValueHolm !== undefined && branch.pValueHolm <= threshold;
            const selected = branch?.branch === selectedBranch;
            return <g key={`b-${node.id}`} onClick={() => branch !== undefined && onSelectBranch(branch.branch)} style={{ cursor: branch === undefined ? "default" : "pointer" }}>
              <title>{branch === undefined ? node.name : `${branch.name} · ${formatBranchValue(branch, metric)} · length=${branch.fittedLength.toPrecision(4)}`}</title>
              <line x1={x(node.parent!)} x2={x(node)} y1={y(node)} y2={y(node)} stroke={color(branch)} strokeWidth={branchWidth + (significant ? 2 : 0) + (selected ? 2 : 0)} strokeLinecap="round" />
              {showValues && branch !== undefined && <text x={(x(node.parent!) + x(node)) / 2} y={y(node) - 4} textAnchor="middle" fill="#52615d" fontSize={Math.max(7, labelSize - 3)}>{formatBranchValue(branch, metric)}</text>}
            </g>;
          })}
          {tree.nodes.map((node) => <circle key={`n-${node.id}`} cx={x(node)} cy={y(node)} r={node === tree.root ? 2.4 : 1.8} fill={node === tree.root ? INK : color(resultByNode.get(node.id))} />)}
          {showTipLabels && tree.tips.map((tip) => <text key={`tip-${tip.id}`} x={x(tip) + 7} y={y(tip) + labelSize * 0.34} fill={INK} fontSize={labelSize}>{tip.name}</text>)}
          {showInternalLabels && tree.nodes.filter((node) => node.children.length > 0 && node.name.length > 0).map((node) => <text key={`int-${node.id}`} x={x(node) + 5} y={y(node) - 5} fill="#52615d" fontSize={Math.max(8, labelSize - 1)}>{node.name}</text>)}
          <text x={left} y={height - 12} fill="#6d7976" fontSize="9">Fitted root-to-tip distance max {layout.maximumDistance.toPrecision(4)} · thicker branches pass the current Holm threshold</text>
        </svg>
      </div>
    </article>
  );
}

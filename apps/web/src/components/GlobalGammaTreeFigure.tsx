import { useEffect, useId, useMemo, useRef, useState } from "react";
import { parseNewick, type ParsedTree, type TreeNode } from "@phylo-workbench/model-diffubar/browser-source";
import type { GlobalGammaRunResult } from "../types.js";
import { downloadSvg } from "../lib/svg-export.js";
import { CommittedNumberInput } from "./CommittedNumberInput.js";

const INK = "#172321";
const FONT = "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";

type Metric = "activation" | "capped" | "expected" | "any" | "site-tail" | "site-local" | "length";
interface Position { readonly x: number; readonly y: number }

function channels(hex: string): readonly [number, number, number] {
  return [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16)];
}

function mix(left: string, right: string, amount: number): string {
  const a = channels(left);
  const b = channels(right);
  const t = Math.max(0, Math.min(1, amount));
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * t)},${Math.round(a[1] + (b[1] - a[1]) * t)},${Math.round(a[2] + (b[2] - a[2]) * t)})`;
}

function layoutTree(tree: ParsedTree, lengths: ReadonlyMap<number, number>) {
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

function metricLabel(metric: Metric, site: number): string {
  return {
    activation: "log₁₀ activation empirical BF",
    capped: "log₁₀ exact capped-edge evidence ratio",
    expected: "Expected positive-site count",
    any: "P(any positive site)",
    "site-tail": `P(ω > 1) at codon ${site}`,
    "site-local": `Local cap log evidence at codon ${site}`,
    length: "log₁₀ branch length",
  }[metric];
}

function valueFor(result: GlobalGammaRunResult, branch: GlobalGammaRunResult["branches"][number], metric: Metric, site: number): number {
  const index = (branch.branch - 1) * result.posterior.siteCount + site - 1;
  if (metric === "activation") return branch.activationLogBayesFactor / Math.LN10;
  if (metric === "capped") return branch.cappedLogEvidence / Math.LN10;
  if (metric === "expected") return branch.expectedPositiveSites;
  if (metric === "any") return branch.anySitePositivePosterior;
  if (metric === "site-tail") return result.posterior.tailPosterior[index] ?? 0;
  if (metric === "site-local") return result.posterior.localLogEvidence[index] ?? 0;
  return Math.log10(Math.max(1e-10, branch.branchLength));
}

function formatValue(result: GlobalGammaRunResult, branch: GlobalGammaRunResult["branches"][number], metric: Metric, site: number): string {
  const value = valueFor(result, branch, metric, site);
  if (metric === "activation" || metric === "capped") return `${value.toFixed(2)} log10`;
  if (metric === "any" || metric === "site-tail") return value.toFixed(3);
  if (metric === "site-local") return `${value.toFixed(3)} ln`;
  if (metric === "expected") return value.toFixed(2);
  return branch.branchLength.toPrecision(4);
}

export function GlobalGammaTreeFigure({
  result,
  selectedSite,
  onSelectSite,
  selectedBranch,
  onSelectBranch,
}: {
  readonly result: GlobalGammaRunResult;
  readonly selectedSite: number;
  readonly onSelectSite: (site: number) => void;
  readonly selectedBranch: number | null;
  readonly onSelectBranch: (branch: number) => void;
}) {
  const titleId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const [title, setTitle] = useState("Global-Gamma branch evidence");
  const [metric, setMetric] = useState<Metric>("activation");
  const [showTipLabels, setShowTipLabels] = useState(true);
  const [showInternalLabels, setShowInternalLabels] = useState(false);
  const [showValues, setShowValues] = useState(false);
  const [width, setWidth] = useState(1_100);
  const [rowHeight, setRowHeight] = useState(24);
  const [labelSize, setLabelSize] = useState(11);
  const [branchWidth, setBranchWidth] = useState(2.25);
  const previousSite = useRef(selectedSite);
  useEffect(() => {
    if (previousSite.current !== selectedSite) setMetric("site-tail");
    previousSite.current = selectedSite;
  }, [selectedSite]);
  const gradientId = `${titleId.replaceAll(":", "")}-gamma-legend`;
  const parsed = useMemo(() => {
    try { return { tree: parseNewick(result.tree) } as const; }
    catch (error) { return { error: error instanceof Error ? error.message : String(error) } as const; }
  }, [result.tree]);
  const byNode = useMemo(() => new Map(result.branches.map((branch) => [branch.nodeId, branch])), [result.branches]);
  const lengths = useMemo(() => new Map(result.branches.map((branch) => [branch.nodeId, branch.branchLength])), [result.branches]);
  const range = useMemo(() => {
    const values = result.branches.map((branch) => valueFor(result, branch, metric, selectedSite)).filter(Number.isFinite).sort((a, b) => a - b);
    const diverging = metric === "activation" || metric === "capped" || metric === "site-local";
    if (diverging) {
      const absolute = values.map(Math.abs).sort((a, b) => a - b);
      const robust = absolute[Math.min(absolute.length - 1, Math.floor(absolute.length * 0.95))] ?? 1;
      return { minimum: -Math.max(1e-9, robust), maximum: Math.max(1e-9, robust), diverging };
    }
    const minimum = metric === "length" ? (values[0] ?? 0) : 0;
    const maximum = values[Math.min(values.length - 1, Math.floor(values.length * 0.95))] ?? 1;
    return { minimum, maximum: Math.max(minimum + 1e-9, maximum), diverging };
  }, [metric, result, selectedSite]);

  if ("error" in parsed) return <div className="figure-empty"><strong>Tree preview unavailable.</strong><span>{parsed.error}</span></div>;
  const tree = parsed.tree;
  const layout = layoutTree(tree, lengths);
  const left = 34;
  const top = 84;
  const bottom = 48;
  const labelGutter = showTipLabels ? Math.min(340, Math.max(150, width * 0.25)) : 30;
  const plotWidth = Math.max(220, width - left - labelGutter);
  const height = Math.max(220, top + bottom + Math.max(1, tree.tips.length - 1) * rowHeight);
  const x = (node: TreeNode): number => left + layout.positions.get(node)!.x * plotWidth;
  const y = (node: TreeNode): number => top + layout.positions.get(node)!.y * rowHeight;
  const color = (branch: GlobalGammaRunResult["branches"][number] | undefined): string => {
    if (branch === undefined) return "#aeb9b5";
    const value = valueFor(result, branch, metric, selectedSite);
    if (range.diverging) {
      if (value < 0) return mix("#2f63c7", "#d8dedb", (value - range.minimum) / -range.minimum);
      return mix("#d8dedb", "#d93843", value / range.maximum);
    }
    return mix("#c7d1cd", metric === "length" ? "#087f6f" : "#d93843", (value - range.minimum) / (range.maximum - range.minimum));
  };

  return <article className="figure-card global-gamma-tree-card">
    <div className="figure-card__heading"><div><strong>{title}</strong><span>Click an edge to inspect its site-wise posterior track; selected-site modes recolor the same tree.</span></div><button type="button" className="button button--secondary button--svg" onClick={() => svgRef.current !== null && downloadSvg(svgRef.current, title)}>Export SVG</button></div>
    <div className="tree-figure-controls bsrel-tree-controls">
      <label><span>Figure title</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label><span>Branch color</span><select value={metric} onChange={(event) => setMetric(event.target.value as Metric)}>
        <option value="activation">Activation empirical BF</option><option value="capped">Exact capped-edge evidence</option>
        <option value="expected">Expected positive sites</option><option value="any">P(any positive site)</option>
        <option value="site-tail">Selected-site tail posterior</option><option value="site-local">Selected-site local evidence</option><option value="length">Branch length</option>
      </select></label>
      <label><span>Selected codon</span><CommittedNumberInput value={selectedSite} onCommit={onSelectSite} min={1} max={result.posterior.siteCount} /></label>
      <label><span>Width {width}px</span><input type="range" min="650" max="1900" step="50" value={width} onChange={(event) => setWidth(Number(event.target.value))} /></label>
      <label><span>Tip spacing {rowHeight}px</span><input type="range" min="14" max="44" value={rowHeight} onChange={(event) => setRowHeight(Number(event.target.value))} /></label>
      <label><span>Label size {labelSize}px</span><input type="range" min="8" max="20" value={labelSize} onChange={(event) => setLabelSize(Number(event.target.value))} /></label>
      <label><span>Line width {branchWidth}px</span><input type="range" min="1" max="7" step="0.25" value={branchWidth} onChange={(event) => setBranchWidth(Number(event.target.value))} /></label>
      <label className="toggle"><input type="checkbox" checked={showTipLabels} onChange={(event) => setShowTipLabels(event.target.checked)} /><span>Tip labels</span></label>
      <label className="toggle"><input type="checkbox" checked={showInternalLabels} onChange={(event) => setShowInternalLabels(event.target.checked)} /><span>Internal labels</span></label>
      <label className="toggle"><input type="checkbox" checked={showValues} onChange={(event) => setShowValues(event.target.checked)} /><span>Branch values</span></label>
    </div>
    <div className="figure-scroll figure-scroll--tall"><svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-labelledby={titleId} style={{ display: "block", minWidth: `${Math.min(width, 760)}px`, width: "100%", height: "auto", background: "#fff", fontFamily: FONT }}>
      <title id={titleId}>{title}</title>
      <defs><linearGradient id={gradientId} x1="0" x2="1"><stop offset="0" stopColor={range.diverging ? "#2f63c7" : "#c7d1cd"} /><stop offset="0.5" stopColor={range.diverging ? "#d8dedb" : "#dc9a91"} /><stop offset="1" stopColor={metric === "length" ? "#087f6f" : "#d93843"} /></linearGradient></defs>
      <text x={left} y="28" fill={INK} fontSize="20" fontWeight="650">{title}</text>
      <g transform={`translate(${left} 48)`} fontSize="9" fill="#566762"><text x="0" y="8">{metricLabel(metric, selectedSite)}</text><rect x="210" y="0" width="150" height="9" rx="4" fill={`url(#${gradientId})`} /><text x="367" y="8">high</text></g>
      {tree.nodes.filter((node) => node.children.length > 0).map((node) => {
        const childYs = node.children.map(y);
        return childYs.length < 2 ? null : <line key={`v-${node.id}`} x1={x(node)} x2={x(node)} y1={Math.min(...childYs)} y2={Math.max(...childYs)} stroke="#87948f" strokeWidth="1" />;
      })}
      {tree.nodes.filter((node) => node !== tree.root).map((node) => {
        const branch = byNode.get(node.id);
        const selected = branch?.branch === selectedBranch;
        return <g key={`b-${node.id}`} onClick={() => branch !== undefined && onSelectBranch(branch.branch)} style={{ cursor: branch === undefined ? "default" : "pointer" }}>
          <title>{branch === undefined ? node.name : `${branch.name} · ${metricLabel(metric, selectedSite)}=${formatValue(result, branch, metric, selectedSite)}`}</title>
          <line x1={x(node.parent!)} x2={x(node)} y1={y(node)} y2={y(node)} stroke={color(branch)} strokeWidth={branchWidth + (selected ? 3 : 0)} strokeLinecap="round" />
          {showValues && branch !== undefined && <text x={(x(node.parent!) + x(node)) / 2} y={y(node) - 4} textAnchor="middle" fill="#52615d" fontSize={Math.max(7, labelSize - 3)}>{formatValue(result, branch, metric, selectedSite)}</text>}
        </g>;
      })}
      {tree.nodes.map((node) => <circle key={`n-${node.id}`} cx={x(node)} cy={y(node)} r={node === tree.root ? 2.4 : 1.8} fill={node === tree.root ? INK : color(byNode.get(node.id))} />)}
      {showTipLabels && tree.tips.map((tip) => <text key={`tip-${tip.id}`} x={x(tip) + 7} y={y(tip) + labelSize * 0.34} fill={INK} fontSize={labelSize}>{tip.name}</text>)}
      {showInternalLabels && tree.nodes.filter((node) => node.children.length > 0 && node.name.length > 0).map((node) => <text key={`int-${node.id}`} x={x(node) + 5} y={y(node) - 5} fill="#52615d" fontSize={Math.max(8, labelSize - 1)}>{node.name}</text>)}
      <text x={left} y={height - 12} fill="#6d7976" fontSize="9">Root-to-tip distance max {layout.maximumDistance.toPrecision(4)} · branch lengths are fixed after the global codon fit</text>
    </svg></div>
  </article>;
}

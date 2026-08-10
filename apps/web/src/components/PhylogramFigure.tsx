import { useId, useMemo, useRef, useState } from "react";
import {
  parseNewick,
  parseTaggedNewick,
  type ParsedTree,
  type TreeNode,
} from "@phylo-workbench/model-diffubar/browser-source";
import { downloadSvg } from "../lib/svg-export.js";

const RED = "#ff4b4f";
const BLUE = "#4f46f5";
const BACKGROUND = "#7b8783";
const INK = "#172321";
const FONT = "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";

interface NodePosition {
  readonly x: number;
  readonly y: number;
  readonly depth: number;
}

function layoutTree(tree: ParsedTree): { readonly positions: ReadonlyMap<TreeNode, NodePosition>; readonly maximumDistance: number } {
  const raw = new Map<TreeNode, { distance: number; y: number; depth: number }>();
  let tipRow = 0;
  let maximumDistance = 0;
  let maximumDepth = 0;
  const visit = (node: TreeNode, distance: number, depth: number): number => {
    maximumDistance = Math.max(maximumDistance, distance);
    maximumDepth = Math.max(maximumDepth, depth);
    let y: number;
    if (node.children.length === 0) {
      y = tipRow++;
    } else {
      const childRows = node.children.map((child) => visit(child, distance + child.branchLength, depth + 1));
      y = childRows.reduce((sum, value) => sum + value, 0) / childRows.length;
    }
    raw.set(node, { distance, y, depth });
    return y;
  };
  visit(tree.root, 0, 0);
  const useDistance = maximumDistance > 0;
  const denominator = useDistance ? maximumDistance : Math.max(1, maximumDepth);
  const positions = new Map<TreeNode, NodePosition>();
  for (const [node, position] of raw) {
    positions.set(node, {
      x: (useDistance ? position.distance : position.depth) / denominator,
      y: position.y,
      depth: position.depth,
    });
  }
  return { positions, maximumDistance };
}

export function PhylogramFigure({ newick, tagged = true }: { readonly newick: string; readonly tagged?: boolean }) {
  const titleId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const [showLabels, setShowLabels] = useState(true);
  const [showInternalLabels, setShowInternalLabels] = useState(false);
  const [width, setWidth] = useState(1_000);
  const [rowHeight, setRowHeight] = useState(22);
  const [labelSize, setLabelSize] = useState(11);
  const [title, setTitle] = useState(tagged ? "Tagged input phylogeny" : "Input phylogeny");
  const parsed = useMemo(() => {
    try {
      return { tree: tagged ? parseTaggedNewick(newick) : parseNewick(newick) } as const;
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) } as const;
    }
  }, [newick, tagged]);

  if ("error" in parsed) return <div className="figure-empty"><strong>Tree preview unavailable.</strong><span>{parsed.error}</span></div>;
  const tree = parsed.tree;
  const layout = layoutTree(tree);
  const left = 28;
  const top = tagged ? 78 : 52;
  const bottom = 36;
  const labelGutter = showLabels ? Math.min(300, Math.max(140, width * 0.24)) : 24;
  const plotWidth = Math.max(180, width - left - labelGutter);
  const height = Math.max(180, top + bottom + Math.max(1, tree.tips.length - 1) * rowHeight);
  const x = (node: TreeNode): number => left + layout.positions.get(node)!.x * plotWidth;
  const y = (node: TreeNode): number => top + layout.positions.get(node)!.y * rowHeight;
  const branchColor = (node: TreeNode): string => tagged
    ? node.branchClass === 0 ? RED : node.branchClass === 1 ? BLUE : BACKGROUND
    : BACKGROUND;

  return (
    <article className="figure-card">
      <div className="figure-card__heading">
        <div><strong>{title}</strong><span>Branch lengths set horizontal distance; tagged edges retain their G1/G2 colors.</span></div>
        <button type="button" className="button button--secondary button--svg" onClick={() => svgRef.current !== null && downloadSvg(svgRef.current, title)}>Export SVG</button>
      </div>
      <div className="tree-figure-controls">
        <label><span>Figure title</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label><span>Width {width}px</span><input type="range" min="600" max="1800" step="50" value={width} onChange={(event) => setWidth(Number(event.target.value))} /></label>
        <label><span>Tip spacing {rowHeight}px</span><input type="range" min="14" max="42" step="1" value={rowHeight} onChange={(event) => setRowHeight(Number(event.target.value))} /></label>
        <label><span>Label size {labelSize}px</span><input type="range" min="8" max="22" step="1" value={labelSize} onChange={(event) => setLabelSize(Number(event.target.value))} /></label>
        <label className="toggle"><input type="checkbox" checked={showLabels} onChange={(event) => setShowLabels(event.target.checked)} /><span>Tip labels</span></label>
        <label className="toggle"><input type="checkbox" checked={showInternalLabels} onChange={(event) => setShowInternalLabels(event.target.checked)} /><span>Internal labels</span></label>
      </div>
      <div className="figure-scroll figure-scroll--tall">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${width} ${height}`}
          width={width}
          height={height}
          role="img"
          aria-labelledby={titleId}
          style={{ display: "block", minWidth: `${Math.min(width, 760)}px`, width: "100%", height: "auto", background: "#fff", fontFamily: FONT }}
        >
          <title id={titleId}>{title}</title>
          <text x={left} y="28" fill={INK} fontSize="20" fontWeight="650">{title}</text>
          {tagged && (
            <g transform={`translate(${left} 51)`} fontSize="11" fill={INK}>
              <line x1="0" x2="34" y1="0" y2="0" stroke={RED} strokeWidth="4" /><text x="42" y="4">G1</text>
              <line x1="86" x2="120" y1="0" y2="0" stroke={BLUE} strokeWidth="4" /><text x="128" y="4">G2</text>
              <line x1="172" x2="206" y1="0" y2="0" stroke={BACKGROUND} strokeWidth="4" /><text x="214" y="4">Background</text>
            </g>
          )}
          {tree.nodes.filter((node) => node.children.length > 0).map((node) => {
            const childYs = node.children.map(y);
            return childYs.length < 2 ? null : (
              <line key={`vertical-${node.id}`} x1={x(node)} x2={x(node)} y1={Math.min(...childYs)} y2={Math.max(...childYs)} stroke="#495652" strokeWidth="1.3" />
            );
          })}
          {tree.nodes.filter((node) => node !== tree.root).map((node) => (
            <line
              key={`branch-${node.id}`}
              x1={x(node.parent!)}
              x2={x(node)}
              y1={y(node)}
              y2={y(node)}
              stroke={branchColor(node)}
              strokeWidth={tagged && node.branchClass < 2 ? 3 : 1.6}
              strokeLinecap="round"
            />
          ))}
          {tree.nodes.map((node) => (
            <circle key={`node-${node.id}`} cx={x(node)} cy={y(node)} r={node.children.length === 0 ? 1.8 : 2.2} fill={node === tree.root ? INK : branchColor(node)} />
          ))}
          {showLabels && tree.tips.map((tip) => (
            <text key={`tip-${tip.id}`} x={x(tip) + 7} y={y(tip) + labelSize * 0.34} fill={INK} fontSize={labelSize}>{tip.name}</text>
          ))}
          {showInternalLabels && tree.nodes.filter((node) => node.children.length > 0 && node.name.length > 0).map((node) => (
            <text key={`internal-${node.id}`} x={x(node) + 5} y={y(node) - 5} fill="#52615d" fontSize={Math.max(8, labelSize - 1)}>{node.name}</text>
          ))}
          <text x={left} y={height - 10} fill="#6d7976" fontSize="9">
            {layout.maximumDistance > 0 ? `Root-to-tip distance scale · ${tree.tips.length} tips` : `Cladogram · ${tree.tips.length} tips`}
          </text>
        </svg>
      </div>
    </article>
  );
}

import React, { useEffect, useMemo, useRef, useState } from "react";
import type { SimulatedDataset } from "@phylo-workbench/model-simulator/browser-source";
import { getGeneticCode } from "@phylo-workbench/model-diffubar/browser-source";
import { timeTreeLayout, treeTipOrder } from "./TimeTreeFigure.js";

const AA_COLORS: Readonly<Record<string, string>> = { A: "#80b918", C: "#d4a017", D: "#e64b50", E: "#e64b50", F: "#7256c5", G: "#8b9692", H: "#4a78d0", I: "#35a26f", K: "#376fd0", L: "#35a26f", M: "#35a26f", N: "#d365a6", P: "#b77237", Q: "#d365a6", R: "#376fd0", S: "#2aa384", T: "#2aa384", V: "#35a26f", W: "#7256c5", Y: "#7256c5", X: "#74817d", "-": "#c7ceca" };
const NUC_COLORS: Readonly<Record<string, string>> = { A: "#44a36f", C: "#4476d5", G: "#d5a22f", T: "#e75b5b", U: "#e75b5b", N: "#84908c", "-": "#c7ceca" };

function translate(sequence: string, codeId: number): string { const code = getGeneticCode(codeId); let output = ""; for (let index = 0; index + 2 < sequence.length; index += 3) output += code.aminoAcids[sequence.slice(index, index + 3)] ?? "X"; return output; }
function consensus(sequences: readonly string[]): string { if (sequences.length === 0) return ""; let output = ""; for (let site = 0; site < sequences[0]!.length; site += 1) { const counts = new Map<string, number>(); for (const sequence of sequences) counts.set(sequence[site]!, (counts.get(sequence[site]!) ?? 0) + 1); output += [...counts].sort((a, b) => b[1] - a[1])[0]![0]; } return output; }

export function TreeAlignmentViewer({ dataset, geneticCodeId }: { readonly dataset: SimulatedDataset; readonly geneticCodeId: number }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<"aa" | "nucleotide">("aa");
  const [highlight, setHighlight] = useState(false);
  const [scale, setScale] = useState(12);
  const [viewport, setViewport] = useState({ left: 0, width: 800 });
  const rawSequences = dataset.sequences ?? [];
  const sequences = useMemo(() => mode === "aa" ? rawSequences.map((sequence) => translate(sequence, geneticCodeId)) : rawSequences, [rawSequences, mode, geneticCodeId]);
  const sequenceByName = useMemo(() => new Map(dataset.names.map((name, index) => [name, sequences[index]!])), [dataset.names, sequences]);
  const names = useMemo(() => treeTipOrder(dataset.tree).map((tip) => dataset.tree.nodes[tip]!.name!).filter((name) => sequenceByName.has(name)), [dataset.tree, sequenceByName]);
  const shownNames = names.slice(0, 500);
  const ordered = shownNames.map((name) => sequenceByName.get(name)!);
  const common = useMemo(() => consensus(ordered), [ordered]);
  const columns = ordered[0]?.length ?? 0;
  useEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const update = (): void => setViewport({ left: element.scrollLeft, width: element.clientWidth });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    element.addEventListener("scroll", update, { passive: true });
    return () => { observer.disconnect(); element.removeEventListener("scroll", update); };
  }, []);
  const start = Math.max(0, Math.floor(viewport.left / scale) - 3);
  const end = Math.min(columns, Math.ceil((viewport.left + viewport.width) / scale) + 3);
  const rowHeight = 17;
  const top = 25;
  const treeWidth = 290;
  const layout = useMemo(() => timeTreeLayout(dataset.tree, 10, 190, top, rowHeight), [dataset.tree]);
  const yByName = new Map<string, number>();
  for (const tip of dataset.tree.tips) yByName.set(dataset.tree.nodes[tip]!.name!, layout.get(tip)!.y);
  const height = top + shownNames.length * rowHeight + 24;
  if (rawSequences.length === 0) return <div className="figure-empty"><strong>No sequences were requested.</strong><span>Enable “Simulate alignments” and run again to open the coupled tree/alignment viewer.</span></div>;
  return <article className="sim-tree-alignment"><div className="sim-figure-heading"><div><strong>Time tree + aligned tip sequences</strong><span>Dotted extensions connect heterochronous samples to the shared alignment edge.</span></div><label><span>Display</span><select value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}><option value="aa">Amino acids</option><option value="nucleotide">Nucleotides</option></select></label><label className="toggle"><input type="checkbox" checked={highlight} onChange={(event) => setHighlight(event.target.checked)} /><span>Fade consensus matches</span></label><label><span>Horizontal scale {scale}px</span><input type="range" min="7" max="22" value={scale} onChange={(event) => setScale(Number(event.target.value))} /></label></div>
    {names.length > shownNames.length && <p className="sim-viewer-warning">Showing the first {shownNames.length} of {names.length} tips in the interactive viewer; every tip remains in exports.</p>}
    <div className="sim-tree-alignment__body"><svg viewBox={`0 0 ${treeWidth} ${height}`} width={treeWidth} height={height} className="sim-tree-alignment__tree">
      {dataset.tree.nodes.filter((node) => node.children.length > 1).map((node) => { const childYs = node.children.map((child) => layout.get(child)!.y); const x = layout.get(node.id)!.x; return <line key={`v-${node.id}`} x1={x} x2={x} y1={Math.min(...childYs)} y2={Math.max(...childYs)} stroke="#64736e" />; })}
      {dataset.tree.nodes.filter((node) => node.parent !== null).map((node) => { const here = layout.get(node.id)!; const parent = layout.get(node.parent!)!; return <line key={`h-${node.id}`} x1={parent.x} x2={here.x} y1={here.y} y2={here.y} stroke="#344843" />; })}
      {shownNames.map((name) => { const tip = dataset.tree.tips.find((id) => dataset.tree.nodes[id]!.name === name)!; const point = layout.get(tip)!; return <g key={name}><line x1={point.x} x2="198" y1={point.y} y2={point.y} stroke="#aab7b2" strokeDasharray="2 2" /><text x="202" y={point.y + 3} fontSize="7.5" fill="#344843">{name}</text></g>; })}
      <text x="10" y="12" fontSize="7" fill="#6e7c78">older</text><text x="190" y="12" textAnchor="end" fontSize="7" fill="#6e7c78">most recent</text>
    </svg><div ref={scrollRef} className="sim-tree-alignment__scroll" style={{ height }}><div className="sim-alignment-track" style={{ width: Math.max(viewport.width, columns * scale), height }}>
      <div className="sim-alignment-ruler" style={{ width: columns * scale }}>{Array.from({ length: Math.ceil(columns / (mode === "aa" ? 10 : 30)) }, (_, index) => { const position = index * (mode === "aa" ? 10 : 30); return <span key={position} style={{ left: position * scale }}>{position + 1}</span>; })}</div>
      {shownNames.map((name) => { const sequence = sequenceByName.get(name)!; const y = yByName.get(name)! - 7; return <div key={name} className="sim-sequence-row" style={{ top: y, left: start * scale, height: rowHeight }}>{sequence.slice(start, end).split("").map((letter, offset) => <span key={start + offset} className={highlight && common[start + offset] === letter ? "is-consensus" : ""} style={{ width: scale, color: (mode === "aa" ? AA_COLORS : NUC_COLORS)[letter] ?? "#6f7c78" }}>{letter}</span>)}</div>; })}
    </div></div></div></article>;
}

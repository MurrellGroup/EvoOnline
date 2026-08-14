import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { JemsprAnalysisResult } from "@phylo-workbench/model-jemspr/browser-source";
import { downloadSvg } from "../lib/svg-export.js";
import {
  exactDisplayLayout,
  displayMaskPath,
  maskPath,
  parseJemsprSwitchingNetwork,
  type SprTreeLayout,
  type SprTreeLayoutNode,
} from "../lib/jemspr-visual.js";

const FONT = "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
const INK = "#172321";
const EVENT = "#d46d35";
const DESTINATION = "#177f72";

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

export function JemsprSprAnimationFigure({ result }: { readonly result: JemsprAnalysisResult }) {
  const titleId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const parsed = useMemo(() => parseJemsprSwitchingNetwork(result.networkJson), [result.networkJson]);
  const runs = result.likelihood.status === "complete" ? result.likelihood.runs : result.network.runs;
  const [region, setRegion] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [showLabels, setShowLabels] = useState(true);
  const selected = runs[Math.min(region, Math.max(0, runs.length - 1))];
  const path = displayMaskPath(parsed.network, selected?.mask ?? 0);
  const layouts = useMemo(() => path.map((mask) => exactDisplayLayout(parsed.network, mask)), [parsed.network, path.join(",")]);
  const maximumPosition = Math.max(0, layouts.length - 1);
  useEffect(() => { setPlaying(false); setPosition(0); }, [region]);
  useEffect(() => {
    if (!playing || maximumPosition === 0) return;
    let previous = performance.now();
    let frame = 0;
    const tick = (now: number): void => {
      const delta = (now - previous) / (1800 / speed);
      previous = now;
      setPosition((current) => {
        const next = current + delta;
        if (next >= maximumPosition) { setPlaying(false); return maximumPosition; }
        return next;
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, maximumPosition, speed]);
  const step = Math.min(Math.floor(position), Math.max(0, layouts.length - 2));
  const fraction = maximumPosition === 0 ? 0 : Math.min(1, position - step);
  const from = layouts[step] ?? layouts[0];
  const to = layouts[Math.min(step + 1, layouts.length - 1)] ?? from;
  const enteringBit = path[Math.min(step + 1, path.length - 1)]! ^ path[step]!;
  const eventBit = enteringBit === 0 ? -1 : Math.round(Math.log2(enteringBit));
  const highlightedTaxa = eventBit < 0 ? [] : result.network.templates.find((template) => template.bit === eventBit)?.move.prunedTaxa.map((name) => parsed.taxaNames.indexOf(name)).filter((index) => index >= 0) ?? [];
  const currentMask = path[Math.min(Math.round(position), path.length - 1)] ?? 0;
  const turningOn = eventBit >= 0 && (path[Math.min(step + 1, path.length - 1)]! & (1 << eventBit)) !== 0;
  return <article className="figure-card">
    <div className="figure-card__heading"><div><strong>Animated construction of a regional tree</strong><span>The all-background master morphs through each active rooted-SPR event. Stable clades and tips interpolate continuously; new/removed edges cross-fade.</span></div><button type="button" className="button button--secondary button--svg" onClick={() => svgRef.current !== null && downloadSvg(svgRef.current, "JEMSPR-SPR-animation-frame")}>Export SVG</button></div>
    <div className="tree-figure-controls"><label><span>Genomic region</span><select value={region} onChange={(event) => setRegion(Number(event.target.value))}>{runs.map((run, index) => <option key={`${run.start}-${run.end}-${run.mask}`} value={index}>{`${index + 1}: ${run.start}–${run.end} · mask ${run.mask.toString(2).padStart(result.network.templates.length, "0")}`}</option>)}</select></label><label><span>Animation speed {speed.toFixed(2)}×</span><input type="range" min="0.25" max="3" step="0.25" value={speed} onChange={(event) => setSpeed(Number(event.target.value))} /></label><label className="toggle"><input type="checkbox" checked={showLabels} onChange={(event) => setShowLabels(event.target.checked)} /><span>Tip labels</span></label><button type="button" className="button button--primary" disabled={maximumPosition === 0} onClick={() => { if (position >= maximumPosition) setPosition(0); setPlaying((value) => !value); }}>{playing ? "Pause" : position >= maximumPosition ? "Replay" : "Play SPR sequence"}</button><button type="button" className="button button--secondary" disabled={maximumPosition === 0} onClick={() => { setPlaying(false); setPosition((value) => Math.min(maximumPosition, Math.floor(value) + 1)); }}>Next move</button><button type="button" className="button button--quiet" onClick={() => { setPlaying(false); setPosition(0); }}>Master</button></div>
    <div className="spr-animation-track" aria-label="SPR animation position">{path.map((mask, index) => { const bit = index === 0 ? -1 : Math.round(Math.log2(mask ^ path[index - 1]!)); const enabled = bit >= 0 && (mask & (1 << bit)) !== 0; return <button key={`${mask}-${index}`} type="button" className={Math.abs(position - index) < .5 ? "is-active" : ""} onClick={() => { setPlaying(false); setPosition(index); }}><span>{index === 0 ? "Master" : `${enabled ? "Apply" : "Reverse"} SPR ${bit + 1}`}</span><small>{mask.toString(2).padStart(result.network.templates.length, "0")}</small></button>; })}</div>
    <div className="figure-scroll"><svg ref={svgRef} viewBox="0 0 1060 500" width="1060" height="500" role="img" aria-labelledby={titleId} style={{ display: "block", background: "#fff", fontFamily: FONT }}><title id={titleId}>Animated JEMSPR rooted-SPR construction</title><rect width="1060" height="500" fill="#fff" /><text x="38" y="28" fill={INK} fontSize="18" fontWeight="700">{selected === undefined ? "No regional path" : `Region ${selected.start}–${selected.end}: master → mask ${selected.mask.toString(2).padStart(result.network.templates.length, "0")}`}</text><text x="38" y="47" fill="#65736f" fontSize="10">{eventBit < 0 ? "All-background latent master" : `${turningOn ? "Applying" : "Reversing"} SPR ${eventBit + 1}: orange taxa travel with the pruned subtree · frame mask ${currentMask}`}</text>{from !== undefined && to !== undefined && <g transform="translate(18 32)"><MorphTree from={from} to={to} fraction={fraction} taxaNames={parsed.taxaNames} showLabels={showLabels} highlightedTaxa={highlightedTaxa} /></g>}</svg></div>
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

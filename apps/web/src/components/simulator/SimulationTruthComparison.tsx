import React, { useEffect, useMemo, useRef, useState } from "react";
import type { SimulatorAnalysisResult } from "@phylo-workbench/model-simulator/browser-source";
import type { SavedAnalysis } from "../../lib/analysis-store.js";
import { downloadSvg } from "../../lib/svg-export.js";
import {
  availableInferenceVariables,
  availableTruthVariables,
  buildSimulationComparisonRows,
  comparisonConfusionMatrix,
  pearsonCorrelation,
  suggestedThreshold,
  type ComparisonVariable,
  type SimulationComparisonRow,
} from "../../lib/simulation-comparison.js";
import { CommittedNumberInput } from "../CommittedNumberInput.js";

type PlotKind = "scatter" | "profile" | "confusion";
type Direction = "at-least" | "at-most";

const COLORS = ["#167a70", "#d8644b", "#6f62ef", "#b68128", "#416eb5", "#a65782", "#4f8eaa", "#73816f"];

function extent(values: readonly number[]): [number, number] {
  let minimum = Math.min(...values);
  let maximum = Math.max(...values);
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return [0, 1];
  if (minimum === maximum) {
    const padding = Math.max(0.5, Math.abs(minimum) * 0.08);
    minimum -= padding;
    maximum += padding;
  } else {
    const padding = (maximum - minimum) * 0.06;
    minimum -= padding;
    maximum += padding;
  }
  return [minimum, maximum];
}

function format(value: number): string {
  const magnitude = Math.abs(value);
  if ((magnitude > 0 && magnitude < 0.001) || magnitude >= 10_000) return value.toExponential(2);
  return value.toFixed(magnitude < 10 ? 3 : 1).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function ticks(minimum: number, maximum: number, count = 5): readonly number[] {
  return Array.from({ length: count }, (_, index) => minimum + (maximum - minimum) * index / Math.max(1, count - 1));
}

function titleFor(plot: PlotKind, truth: ComparisonVariable, inference: ComparisonVariable): string {
  if (plot === "confusion") return `${inference.label} against ${truth.label}`;
  if (plot === "profile") return `${truth.label} and ${inference.label} by site`;
  return `${inference.label} versus ${truth.label}`;
}

function ScatterPlot({ rows, truth, inference, title }: { readonly rows: readonly SimulationComparisonRow[]; readonly truth: ComparisonVariable; readonly inference: ComparisonVariable; readonly title: string }) {
  const points = rows.map((row) => ({ row, x: row.truth[truth.id], y: row.inference[inference.id] })).filter((point): point is { row: SimulationComparisonRow; x: number; y: number } => Number.isFinite(point.x) && Number.isFinite(point.y));
  const [xMin, xMax] = extent(points.map((point) => point.x));
  const [yMin, yMax] = extent(points.map((point) => point.y));
  const left = 88; const right = 1014; const top = 72; const bottom = 454;
  const x = (value: number) => left + (value - xMin) / (xMax - xMin) * (right - left);
  const y = (value: number) => bottom - (value - yMin) / (yMax - yMin) * (bottom - top);
  const comparable = /dN\/dS|ω/i.test(truth.label) && /dN\/dS|ω/i.test(inference.label);
  const identityLow = Math.max(xMin, yMin);
  const identityHigh = Math.min(xMax, yMax);
  const correlation = pearsonCorrelation(rows, truth.id, inference.id);
  return <>
    <text x="52" y="35" fontSize="18" fontWeight="700" fill="#18302b">{title}</text>
    <text x="52" y="55" fontSize="9" fill="#687772">{points.length.toLocaleString()} site estimates · Pearson r={correlation.toFixed(3)} · color identifies simulated replicate</text>
    <rect x={left} y={top} width={right - left} height={bottom - top} fill="#fbfcfb" stroke="#dce3df" />
    {ticks(xMin, xMax).map((tick) => <g key={`x-${tick}`}><line x1={x(tick)} x2={x(tick)} y1={top} y2={bottom} stroke="#ebefec" /><text x={x(tick)} y={bottom + 19} textAnchor="middle" fontSize="8" fill="#65736f">{format(tick)}</text></g>)}
    {ticks(yMin, yMax).map((tick) => <g key={`y-${tick}`}><line x1={left} x2={right} y1={y(tick)} y2={y(tick)} stroke="#ebefec" /><text x={left - 10} y={y(tick) + 3} textAnchor="end" fontSize="8" fill="#65736f">{format(tick)}</text></g>)}
    {comparable && identityHigh > identityLow && <line x1={x(identityLow)} y1={y(identityLow)} x2={x(identityHigh)} y2={y(identityHigh)} stroke="#7b8782" strokeDasharray="5 4" strokeWidth="1.2" />}
    {points.map((point, index) => <circle key={`${point.row.analysisId}-${point.row.site}-${index}`} cx={x(point.x)} cy={y(point.y)} r="2.5" fill={COLORS[point.row.datasetIndex % COLORS.length]} fillOpacity="0.58"><title>{`Dataset ${point.row.datasetIndex + 1}, site ${point.row.site}: true ${format(point.x)}, inferred ${format(point.y)}`}</title></circle>)}
    <text x={(left + right) / 2} y="507" textAnchor="middle" fontSize="11" fontWeight="700" fill="#29413c">{truth.label}</text>
    <text transform={`translate(22 ${(top + bottom) / 2}) rotate(-90)`} textAnchor="middle" fontSize="11" fontWeight="700" fill="#29413c">{inference.label}</text>
  </>;
}

function ProfilePlot({ rows, truth, inference, title }: { readonly rows: readonly SimulationComparisonRow[]; readonly truth: ComparisonVariable; readonly inference: ComparisonVariable; readonly title: string }) {
  const points = rows.filter((row) => Number.isFinite(row.truth[truth.id]) && Number.isFinite(row.inference[inference.id]));
  const grouped = new Map<string, SimulationComparisonRow[]>();
  for (const row of points) { const group = grouped.get(row.analysisId) ?? []; group.push(row); grouped.set(row.analysisId, group); }
  const allValues = points.flatMap((row) => [row.truth[truth.id]!, row.inference[inference.id]!]);
  const [yMin, yMax] = extent(allValues);
  const maxSite = Math.max(1, ...points.map((row) => row.site));
  const left = 88; const right = 1014; const top = 72; const bottom = 454;
  const x = (value: number) => left + (value - 1) / Math.max(1, maxSite - 1) * (right - left);
  const y = (value: number) => bottom - (value - yMin) / (yMax - yMin) * (bottom - top);
  const path = (group: readonly SimulationComparisonRow[], side: "truth" | "inference", key: string) => [...group].sort((a, b) => a.site - b.site).map((row, index) => `${index === 0 ? "M" : "L"}${x(row.site)},${y(row[side][key]!)}`).join(" ");
  return <>
    <text x="52" y="35" fontSize="18" fontWeight="700" fill="#18302b">{title}</text>
    <text x="52" y="55" fontSize="9" fill="#687772">Solid = truth · dashed = inference · color identifies simulated replicate</text>
    <rect x={left} y={top} width={right - left} height={bottom - top} fill="#fbfcfb" stroke="#dce3df" />
    {ticks(1, maxSite).map((tick) => <g key={`x-${tick}`}><line x1={x(tick)} x2={x(tick)} y1={top} y2={bottom} stroke="#ebefec" /><text x={x(tick)} y={bottom + 19} textAnchor="middle" fontSize="8" fill="#65736f">{Math.round(tick)}</text></g>)}
    {ticks(yMin, yMax).map((tick) => <g key={`y-${tick}`}><line x1={left} x2={right} y1={y(tick)} y2={y(tick)} stroke="#ebefec" /><text x={left - 10} y={y(tick) + 3} textAnchor="end" fontSize="8" fill="#65736f">{format(tick)}</text></g>)}
    {[...grouped.values()].map((group) => { const color = COLORS[group[0]!.datasetIndex % COLORS.length]; return <g key={group[0]!.analysisId}><path d={path(group, "truth", truth.id)} fill="none" stroke={color} strokeWidth="1.5" strokeOpacity="0.68" /><path d={path(group, "inference", inference.id)} fill="none" stroke={color} strokeWidth="1.5" strokeOpacity="0.88" strokeDasharray="5 3" /></g>; })}
    <text x={(left + right) / 2} y="507" textAnchor="middle" fontSize="11" fontWeight="700" fill="#29413c">Codon site</text>
    <text transform={`translate(22 ${(top + bottom) / 2}) rotate(-90)`} textAnchor="middle" fontSize="11" fontWeight="700" fill="#29413c">Selected quantities</text>
  </>;
}

function ConfusionPlot({ rows, truth, inference, title, truthThreshold, inferenceThreshold, truthDirection, inferenceDirection }: { readonly rows: readonly SimulationComparisonRow[]; readonly truth: ComparisonVariable; readonly inference: ComparisonVariable; readonly title: string; readonly truthThreshold: number; readonly inferenceThreshold: number; readonly truthDirection: Direction; readonly inferenceDirection: Direction }) {
  const matrix = comparisonConfusionMatrix(rows, truth.id, inference.id, truthThreshold, inferenceThreshold, truthDirection, inferenceDirection);
  const cells = [
    { x: 310, y: 105, label: "True positive", value: matrix.truePositive, fill: "#a9d9c6" },
    { x: 610, y: 105, label: "False negative", value: matrix.falseNegative, fill: "#f1c68a" },
    { x: 310, y: 275, label: "False positive", value: matrix.falsePositive, fill: "#efa3a3" },
    { x: 610, y: 275, label: "True negative", value: matrix.trueNegative, fill: "#b7cee4" },
  ];
  const total = cells.reduce((sum, cell) => sum + cell.value, 0);
  return <>
    <text x="52" y="35" fontSize="18" fontWeight="700" fill="#18302b">{title}</text>
    <text x="52" y="55" fontSize="9" fill="#687772">Truth {truthDirection === "at-least" ? "≥" : "≤"} {format(truthThreshold)} · detection {inferenceDirection === "at-least" ? "≥" : "≤"} {format(inferenceThreshold)} · n={total.toLocaleString()}</text>
    <text x="253" y="91" textAnchor="end" fontSize="10" fontWeight="700" fill="#29413c">True selected</text><text x="253" y="261" textAnchor="end" fontSize="10" fontWeight="700" fill="#29413c">True other</text>
    <text x="460" y="92" textAnchor="middle" fontSize="10" fontWeight="700" fill="#29413c">Detected</text><text x="760" y="92" textAnchor="middle" fontSize="10" fontWeight="700" fill="#29413c">Not detected</text>
    {cells.map((cell) => <g key={cell.label}><rect x={cell.x} y={cell.y} width="270" height="145" rx="7" fill={cell.fill} stroke="#87958f" /><text x={cell.x + 135} y={cell.y + 61} textAnchor="middle" fontSize="34" fontWeight="750" fill="#18302b">{cell.value}</text><text x={cell.x + 135} y={cell.y + 89} textAnchor="middle" fontSize="10" fontWeight="700" fill="#29413c">{cell.label}</text><text x={cell.x + 135} y={cell.y + 111} textAnchor="middle" fontSize="9" fill="#53645f">{total > 0 ? `${(100 * cell.value / total).toFixed(1)}%` : "0%"}</text></g>)}
    <text x="310" y="455" fontSize="10" fill="#53645f">Sensitivity <tspan fontWeight="750">{matrix.sensitivity.toFixed(3)}</tspan></text><text x="475" y="455" fontSize="10" fill="#53645f">Specificity <tspan fontWeight="750">{matrix.specificity.toFixed(3)}</tspan></text><text x="640" y="455" fontSize="10" fill="#53645f">Precision <tspan fontWeight="750">{matrix.precision.toFixed(3)}</tspan></text><text x="805" y="455" fontSize="10" fill="#53645f">Accuracy <tspan fontWeight="750">{matrix.accuracy.toFixed(3)}</tspan></text>
  </>;
}

export function SimulationTruthComparison({ simulation, analyses, selectedDatasetId }: { readonly simulation: SimulatorAnalysisResult; readonly analyses: readonly SavedAnalysis[]; readonly selectedDatasetId?: string }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const allRows = useMemo(() => buildSimulationComparisonRows(simulation, analyses), [simulation, analyses]);
  const methods = useMemo(() => [...new Set(allRows.map((row) => row.methodId))].sort(), [allRows]);
  const [methodState, setMethod] = useState(methods[0] ?? "fubar");
  const method = methods.includes(methodState) ? methodState : methods[0] ?? "";
  const [scope, setScope] = useState<string>(selectedDatasetId ?? "all");
  useEffect(() => { if (selectedDatasetId !== undefined) setScope(selectedDatasetId); }, [selectedDatasetId]);
  const scopedDataset = scope === "all" || simulation.datasets.some((dataset) => dataset.id === scope) ? scope : "all";
  const methodRows = allRows.filter((row) => row.methodId === method);
  const rows = methodRows.filter((row) => scopedDataset === "all" || row.datasetId === scopedDataset);
  const truthVariables = availableTruthVariables(methodRows);
  const inferenceVariables = availableInferenceVariables(methodRows, method);
  const defaultTruth = truthVariables.find((variable) => variable.id === "dnds") ?? truthVariables.find((variable) => variable.id === "scuffOmegaStar") ?? truthVariables[0];
  const defaultInference = inferenceVariables.find((variable) => variable.id === "meanDnds") ?? inferenceVariables[0];
  const [truthState, setTruth] = useState(defaultTruth?.id ?? "");
  const [inferenceState, setInference] = useState(defaultInference?.id ?? "");
  const truth = truthVariables.find((variable) => variable.id === truthState) ?? defaultTruth;
  const inference = inferenceVariables.find((variable) => variable.id === inferenceState) ?? defaultInference;
  const [plot, setPlot] = useState<PlotKind>("scatter");
  const [truthThreshold, setTruthThreshold] = useState(1);
  const [inferenceThreshold, setInferenceThreshold] = useState(0.95);
  const [truthDirection, setTruthDirection] = useState<Direction>("at-least");
  const [inferenceDirection, setInferenceDirection] = useState<Direction>("at-least");
  const generatedTitle = truth === undefined || inference === undefined ? "Simulation truth comparison" : titleFor(plot, truth, inference);
  const [customTitle, setCustomTitle] = useState("");
  const title = customTitle.trim() || generatedTitle;
  if (allRows.length === 0 || truth === undefined || inference === undefined) return <div className="figure-empty"><strong>No linked inference results yet.</strong><span>Run FUBAR, FAME, or FLAVOR from the simulator batch panel. EvoOnline will retain the dataset identity and expose site-level truth comparisons here.</span></div>;
  const changeTruth = (id: string): void => {
    setTruth(id);
    const variable = truthVariables.find((candidate) => candidate.id === id);
    if (variable !== undefined) { const suggestion = suggestedThreshold(variable); setTruthThreshold(suggestion.value); setTruthDirection(suggestion.direction); }
  };
  const changeInference = (id: string): void => {
    setInference(id);
    const variable = inferenceVariables.find((candidate) => candidate.id === id);
    if (variable !== undefined) { const suggestion = suggestedThreshold(variable); setInferenceThreshold(suggestion.value); setInferenceDirection(suggestion.direction); }
  };
  const changeMethod = (id: string): void => {
    const nextRows = allRows.filter((row) => row.methodId === id);
    const nextTruth = availableTruthVariables(nextRows).find((variable) => variable.id === "dnds") ?? availableTruthVariables(nextRows)[0];
    const nextInference = availableInferenceVariables(nextRows, id).find((variable) => variable.id === "meanDnds") ?? availableInferenceVariables(nextRows, id)[0];
    setMethod(id);
    if (nextTruth !== undefined) changeTruth(nextTruth.id);
    if (nextInference !== undefined) changeInference(nextInference.id);
  };
  return <div className="sim-comparison-studio">
    <div className="sim-comparison-controls">
      <label><span>Plot</span><select value={plot} onChange={(event) => setPlot(event.target.value as PlotKind)}><option value="scatter">Truth vs inference</option><option value="profile">Site profile</option><option value="confusion">Confusion matrix</option></select></label>
      <label><span>Method</span><select value={method} onChange={(event) => changeMethod(event.target.value)}>{methods.map((entry) => <option key={entry} value={entry}>{entry.toUpperCase()}</option>)}</select></label>
      <label><span>Datasets</span><select value={scopedDataset} onChange={(event) => setScope(event.target.value)}><option value="all">All simulated datasets</option>{simulation.datasets.map((dataset, index) => <option key={dataset.id} value={dataset.id}>Dataset {index + 1}</option>)}</select></label>
      <label><span>Truth quantity</span><select value={truth.id} onChange={(event) => changeTruth(event.target.value)}>{truthVariables.map((variable) => <option key={variable.id} value={variable.id}>{variable.label}</option>)}</select></label>
      <label><span>Inference quantity</span><select value={inference.id} onChange={(event) => changeInference(event.target.value)}>{inferenceVariables.map((variable) => <option key={variable.id} value={variable.id}>{variable.label}</option>)}</select></label>
      <label className="sim-comparison-title"><span>Figure title</span><input value={customTitle} placeholder={generatedTitle} onChange={(event) => setCustomTitle(event.target.value)} /></label>
      <button type="button" className="button button--secondary" onClick={() => svgRef.current !== null && downloadSvg(svgRef.current, title)}>Export SVG</button>
    </div>
    {plot === "confusion" && <div className="sim-comparison-thresholds"><label><span>Truth is selected when</span><select value={truthDirection} onChange={(event) => setTruthDirection(event.target.value as Direction)}><option value="at-least">≥</option><option value="at-most">≤</option></select><CommittedNumberInput value={truthThreshold} integer={false} onCommit={setTruthThreshold} /></label><label><span>Inference calls selected when</span><select value={inferenceDirection} onChange={(event) => setInferenceDirection(event.target.value as Direction)}><option value="at-least">≥</option><option value="at-most">≤</option></select><CommittedNumberInput value={inferenceThreshold} integer={false} onCommit={setInferenceThreshold} /></label></div>}
    <div className="figure-scroll"><svg ref={svgRef} viewBox="0 0 1060 525" width="1060" height="525" role="img" aria-label={title} style={{ display: "block", background: "#fff", fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" }}><rect width="1060" height="525" fill="#fff" />{plot === "scatter" ? <ScatterPlot rows={rows} truth={truth} inference={inference} title={title} /> : plot === "profile" ? <ProfilePlot rows={rows} truth={truth} inference={inference} title={title} /> : <ConfusionPlot rows={rows} truth={truth} inference={inference} title={title} truthThreshold={truthThreshold} inferenceThreshold={inferenceThreshold} truthDirection={truthDirection} inferenceDirection={inferenceDirection} />}</svg></div>
    <p className="figure-note">Every point retains its simulated dataset and codon-site identity. Ω(σ) is the independent-redraw SCUFF expectation; it is deliberately distinct from the sampled diagnostic trace mean.</p>
  </div>;
}

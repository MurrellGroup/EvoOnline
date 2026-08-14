import React, { useMemo, useState } from "react";
import type { SimulatedDataset, SimulatorAnalysisResult } from "@phylo-workbench/model-simulator/browser-source";
import { createStoredZip, downloadBlob, downloadText, type DownloadFile } from "../../lib/file-download.js";
import type { SavedAnalysis } from "../../lib/analysis-store.js";
import { RecombinationTruthFigure } from "./RecombinationTruthFigure.js";
import { ScuffDiagnostics } from "./ScuffDiagnostics.js";
import { SimulationTruthComparison } from "./SimulationTruthComparison.js";
import { TimeTreeFigure } from "./TimeTreeFigure.js";
import { TreeAlignmentViewer } from "./TreeAlignmentViewer.js";

export type SimulatorBatchMethod = "fubar" | "fame" | "flavor";
export interface SimulatorResultActions {
  readonly onLoadDataset?: (dataset: SimulatedDataset) => void | Promise<void>;
  readonly onBatchDatasets?: (method: SimulatorBatchMethod, datasets: readonly SimulatedDataset[], result: SimulatorAnalysisResult) => void | Promise<void>;
  readonly inferenceAnalyses?: readonly SavedAnalysis[];
}

function format(value: number): string { return value < 0.001 || value >= 1000 ? value.toExponential(3) : value.toFixed(3); }

function localTreeTable(dataset: SimulatedDataset): string {
  return ["start_codon\tend_codon\tactive_event_ids\tnewick", ...dataset.localTrees.map((region) => `${region.startCodon}\t${region.endCodon}\t${region.activeEventIds.join(",")}\t${region.tree.newick}`)].join("\n");
}

function truthJson(dataset: SimulatedDataset): string {
  return JSON.stringify({ id: dataset.id, seed: dataset.seed, diagnostics: dataset.diagnostics, recombinationEvents: dataset.recombinationEvents, localTrees: dataset.localTrees.map((region) => ({ startCodon: region.startCodon, endCodon: region.endCodon, activeEventIds: region.activeEventIds, newick: region.tree.newick, timeNewick: region.tree.timeNewick })), siteParameters: dataset.siteParameters }, null, 2);
}

function exportFiles(result: SimulatorAnalysisResult): DownloadFile[] {
  const files: DownloadFile[] = [{ name: "simulation-config.json", data: JSON.stringify(result.config, null, 2) }];
  for (const [index, dataset] of result.datasets.entries()) {
    const prefix = `dataset-${String(index + 1).padStart(3, "0")}`;
    files.push({ name: `${prefix}/master-tree.nwk`, data: `${dataset.tree.newick}\n` }, { name: `${prefix}/time-tree.nwk`, data: `${dataset.tree.timeNewick}\n` }, { name: `${prefix}/local-trees.tsv`, data: localTreeTable(dataset) }, { name: `${prefix}/truth.json`, data: truthJson(dataset) });
    if (dataset.fasta !== undefined) files.push({ name: `${prefix}/alignment.fasta`, data: `${dataset.fasta}\n` });
    if (dataset.carrierTree !== undefined) files.push({ name: `${prefix}/unobserved-carrier-tree.nwk`, data: `${dataset.carrierTree.newick}\n` });
  }
  return files;
}

function ParameterHistograms({ dataset }: { readonly dataset: SimulatedDataset }) {
  const entries = Object.entries(dataset.siteParameters ?? {}).filter((entry): entry is [string, readonly number[]] => Array.isArray(entry[1]));
  if (entries.length === 0) return null;
  return <details open className="sim-result-panel"><summary><strong>Realized site parameters</strong><span>Actual draws used for this replicate</span></summary><div className="sim-hist-grid">{entries.map(([name, values], entryIndex) => {
    const maximum = Math.max(...values, 1e-12);
    const bins = new Array<number>(24).fill(0);
    for (const value of values) { const bin = Math.min(bins.length - 1, Math.floor(value / maximum * bins.length)); bins[bin] = bins[bin]! + 1; }
    const peak = Math.max(...bins, 1);
    return <div key={name}><strong>{name}</strong><svg viewBox="0 0 220 75">{bins.map((count, index) => <rect key={index} x={8 + index * 8.5} y={59 - 50 * count / peak} width="7.5" height={50 * count / peak} fill={["#167a70", "#6f62ef", "#d8644b", "#b68128"][entryIndex % 4]} />)}<line x1="8" x2="212" y1="59" y2="59" stroke="#899691" /><text x="8" y="70" fontSize="6">0</text><text x="212" y="70" textAnchor="end" fontSize="6">{maximum.toPrecision(3)}</text></svg></div>;
  })}</div></details>;
}

export function SimulatorResultsView({ result, onLoadDataset, onBatchDatasets, inferenceAnalyses = [] }: { readonly result: SimulatorAnalysisResult } & SimulatorResultActions) {
  const [selected, setSelected] = useState(0);
  const [batchMethod, setBatchMethod] = useState<SimulatorBatchMethod>("fubar");
  const [batchIds, setBatchIds] = useState<ReadonlySet<string>>(() => new Set(result.datasets.map((dataset) => dataset.id)));
  const [batching, setBatching] = useState(false);
  const dataset = result.datasets[Math.min(selected, result.datasets.length - 1)]!;
  const means = useMemo(() => ({
    height: result.datasets.reduce((sum, item) => sum + item.diagnostics.treeHeight, 0) / result.datasets.length,
    diversity: result.datasets.reduce((sum, item) => sum + (item.diagnostics.meanNucleotideDistance ?? 0), 0) / result.datasets.length,
    localTrees: result.datasets.reduce((sum, item) => sum + item.diagnostics.localTrees, 0) / result.datasets.length,
  }), [result]);
  const runBatch = async (): Promise<void> => {
    if (onBatchDatasets === undefined) return;
    setBatching(true);
    try { await onBatchDatasets(batchMethod, result.datasets.filter((item) => batchIds.has(item.id)), result); }
    finally { setBatching(false); }
  };
  return <section className="results simulator-results"><div className="section-heading"><div><p className="eyebrow">Simulation complete</p><h2>{result.datasets.length} reproducible evolutionary dataset{result.datasets.length === 1 ? "" : "s"}</h2><p>Integrated heterochronous coalescent · exact codon Gillespie simulation · {result.config.recombination.enabled ? "branch-interior recombination enabled" : "single genealogy per replicate"}</p></div><div className="result-downloads"><button type="button" className="button button--primary" onClick={() => downloadBlob(createStoredZip(exportFiles(result)), "evoonline-simulations.zip")}>Download all (.zip)</button><button type="button" className="button button--secondary" onClick={() => downloadText(JSON.stringify(result.config, null, 2), "simulation-config.json", "application/json")}>Config JSON</button></div></div>
    <div className="result-stats"><div><span>Datasets</span><strong>{result.datasets.length}</strong></div><div><span>Mean tree height</span><strong>{format(means.height)}</strong></div><div><span>Mean nucleotide distance</span><strong>{result.config.simulateAlignment ? format(means.diversity) : "tree only"}</strong></div><div><span>Mean local trees</span><strong>{means.localTrees.toFixed(1)}</strong></div><div><span>Elapsed</span><strong>{(result.elapsedMs / 1000).toFixed(2)} s</strong></div></div>
    <details open className="sim-result-panel"><summary><strong>All sampled time trees</strong><span>Every tree shares its own explicit backwards-time axis</span></summary><div className="sim-tree-gallery">{result.datasets.map((item, index) => <button type="button" key={item.id} className={index === selected ? "is-active" : ""} onClick={() => setSelected(index)}><span>Dataset {index + 1} · height {format(item.tree.height)}</span><TimeTreeFigure tree={item.tree} compact initialTitle={`Dataset ${index + 1}`} /></button>)}</div></details>
    <div className="sim-dataset-picker"><label>Inspect dataset <select value={selected} onChange={(event) => setSelected(Number(event.target.value))}>{result.datasets.map((item, index) => <option key={item.id} value={index}>Dataset {index + 1} · seed {item.seed}</option>)}</select></label><div><button type="button" className="button button--primary" disabled={dataset.fasta === undefined || onLoadDataset === undefined} onClick={() => void onLoadDataset?.(dataset)}>Load into EvoOnline workspace</button>{dataset.fasta !== undefined && <button type="button" className="button button--secondary" onClick={() => downloadText(`${dataset.fasta}\n`, `${dataset.id}.fasta`)}>FASTA</button>}<button type="button" className="button button--secondary" onClick={() => downloadText(`${dataset.tree.newick}\n`, `${dataset.id}.nwk`)}>Tree</button><button type="button" className="button button--secondary" onClick={() => downloadText(localTreeTable(dataset), `${dataset.id}-local-trees.tsv`, "text/tab-separated-values")}>Local trees</button><button type="button" className="button button--secondary" onClick={() => downloadText(truthJson(dataset), `${dataset.id}-truth.json`, "application/json")}>Truth</button></div></div>
    <div className="sim-selected-summary"><div><span>Observed / carrier tips</span><strong>{dataset.diagnostics.observedTips} / {dataset.diagnostics.carrierTips}</strong></div><div><span>Tree length</span><strong>{format(dataset.diagnostics.totalTreeLength)}</strong></div><div><span>Visible events</span><strong>{dataset.diagnostics.recombinationEvents}</strong></div><div><span>Segregating nt columns</span><strong>{dataset.diagnostics.segregatingNucleotideSites ?? "—"}</strong></div><div><span>Mean AA distance</span><strong>{dataset.diagnostics.meanAminoAcidDistance === undefined ? "—" : format(dataset.diagnostics.meanAminoAcidDistance)}</strong></div></div>
    <TimeTreeFigure tree={dataset.tree} initialTitle={`Dataset ${selected + 1} sampled genealogy`} />
    {result.config.recombination.enabled && <><RecombinationTruthFigure dataset={dataset} sites={result.config.codon.sites} /><details className="sim-result-panel"><summary><strong>Local genealogy gallery</strong><span>{dataset.localTrees.length} contiguous genomic regions</span></summary><div className="sim-local-tree-gallery">{dataset.localTrees.map((region, index) => <div key={`${region.startCodon}-${region.endCodon}`}><strong>T{index + 1} · codons {region.startCodon}–{region.endCodon}</strong><span>active events {region.activeEventIds.join(", ") || "none"}</span><TimeTreeFigure tree={region.tree} compact initialTitle={`Local tree ${index + 1}`} /></div>)}</div></details></>}
    <ParameterHistograms dataset={dataset} />
    <details open className="sim-result-panel"><summary><strong>Reusable tree + alignment viewer</strong><span>AA / nucleotide modes · consensus highlighter · normal horizontal scrolling</span></summary><TreeAlignmentViewer dataset={dataset} geneticCodeId={result.config.codon.geneticCodeId} /></details>
    {result.scuffDiagnostic !== undefined && result.config.codon.engine === "scuff" && <ScuffDiagnostics diagnostic={result.scuffDiagnostic} config={result.config.codon} />}
    <details open className="sim-result-panel sim-batch-panel"><summary><strong>Batch into a codon selection method</strong><span>Each generated alignment/tree pair becomes an independent persisted analysis</span></summary><div className="sim-batch-controls"><label>Method <select value={batchMethod} onChange={(event) => setBatchMethod(event.target.value as SimulatorBatchMethod)}><option value="fubar">FUBAR</option><option value="fame">FAME</option><option value="flavor">FLAVOR</option></select></label><div className="sim-batch-datasets">{result.datasets.map((item, index) => <label key={item.id}><input type="checkbox" checked={batchIds.has(item.id)} onChange={(event) => setBatchIds((current) => { const next = new Set(current); if (event.target.checked) next.add(item.id); else next.delete(item.id); return next; })} />Dataset {index + 1}</label>)}</div><button type="button" className="button button--run" disabled={batching || batchIds.size === 0 || result.datasets.some((item) => item.fasta === undefined) || onBatchDatasets === undefined} onClick={() => void runBatch()}>{batching ? "Running batch…" : `Run ${batchMethod.toUpperCase()} on ${batchIds.size} dataset${batchIds.size === 1 ? "" : "s"}`}</button><small>For recombination simulations, the known local trees are passed through the same detector-agnostic fixed-relative regional-tree contract used by FSART, MosaicSPR, and JEMSPR.</small></div></details>
    <details open className="sim-result-panel"><summary><strong>Inference against simulation truth</strong><span>Flexible quantities · one or all replicates · scatter, site profile, or confusion matrix · SVG</span></summary><SimulationTruthComparison simulation={result} analyses={inferenceAnalyses} selectedDatasetId={dataset.id} /></details>
  </section>;
}

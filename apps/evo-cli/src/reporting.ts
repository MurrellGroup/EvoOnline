import { relative, resolve } from "node:path";
import { extractSignals, megaTableCsv, type ComparisonRecord, type ComparisonSignal } from "./comparison.js";
import { describeArtifact, type OutputArtifact } from "./exporter.js";
import { rowsToCsv, writeText } from "./io.js";
import type { PipelineDefinition } from "./pipeline.js";
import { writeComparisonPlots, writeMethodPlots } from "./plots.js";
import { writeStandardMethodTables } from "./standard-output.js";
import { applyVisualizationSettings, resolveVisualizationSettings, selectMethodSiteSignal } from "./visualization.js";

export interface ReportRecord extends ComparisonRecord {
  readonly datasetId: string;
  readonly outputDirectory: string;
  readonly resultPath: string;
  readonly simulationTruth?: boolean;
}

export interface ReplotRecordReference {
  readonly id: string;
  readonly dataset: string;
  readonly datasetId: string;
  readonly nodeId?: string;
  readonly sourceId: string;
  readonly sourceNodeId?: string;
  readonly sourceLabel: string;
  readonly methodId: string;
  readonly methodLabel: string;
  readonly parameters: ComparisonRecord["parameters"];
  readonly resultPath: string;
  readonly outputDirectory: string;
  readonly simulationTruth: boolean;
}

export interface ReplotIndex {
  readonly format: "evoonline-cli-replot-index";
  readonly schemaVersion: 1;
  readonly records: readonly ReplotRecordReference[];
}

function signalCsv(signals: readonly ComparisonSignal[]): string {
  return rowsToCsv(
    ["dataset", "source", "method", "metric id", "metric", "unit", "item key", "item label", "ordinal", "value", "threshold", "direction"],
    signals.flatMap((signal) => signal.values.map((value) => [signal.dataset, signal.sourceLabel, signal.methodLabel, signal.metricId, signal.metricLabel, signal.unit, value.key, value.label, value.ordinal, value.value, signal.threshold, signal.direction])),
  );
}

function signalCatalogCsv(signals: readonly ComparisonSignal[]): string {
  return rowsToCsv(
    ["signal id", "dataset", "source", "method", "metric id", "metric", "unit", "observations", "plot threshold", "call direction"],
    signals.map((signal) => [signal.id, signal.dataset, signal.sourceLabel, signal.methodLabel, signal.metricId, signal.metricLabel, signal.unit, signal.values.length, signal.threshold, signal.direction]),
  );
}

export function replotIndex(outputRoot: string, records: readonly ReportRecord[]): ReplotIndex {
  const path = (value: string): string => relative(outputRoot, value).replaceAll("\\", "/");
  return {
    format: "evoonline-cli-replot-index",
    schemaVersion: 1,
    records: records.map((record) => ({
      id: record.id,
      dataset: record.dataset,
      datasetId: record.datasetId,
      ...(record.nodeId === undefined ? {} : { nodeId: record.nodeId }),
      sourceId: record.sourceId,
      ...(record.sourceNodeId === undefined ? {} : { sourceNodeId: record.sourceNodeId }),
      sourceLabel: record.sourceLabel,
      methodId: record.methodId,
      methodLabel: record.methodLabel,
      parameters: record.parameters,
      resultPath: path(record.resultPath),
      outputDirectory: path(record.outputDirectory),
      simulationTruth: record.simulationTruth === true,
    })),
  };
}

function recordSignals(record: ReportRecord, pipeline: PipelineDefinition): readonly ComparisonSignal[] {
  const settings = resolveVisualizationSettings(record, pipeline.visualization);
  return applyVisualizationSettings(extractSignals(record), settings);
}

export async function writeReportOutputs(
  outputRoot: string,
  pipeline: PipelineDefinition,
  records: readonly ReportRecord[],
): Promise<{ readonly artifacts: readonly OutputArtifact[]; readonly signals: readonly ComparisonSignal[] }> {
  const artifacts: OutputArtifact[] = [];
  const signalsByRecord = new Map<string, readonly ComparisonSignal[]>();
  for (const record of records) {
    const settings = resolveVisualizationSettings(record, pipeline.visualization);
    const signals = recordSignals(record, pipeline);
    signalsByRecord.set(record.id, signals);
    const context = {
      outputRoot,
      dataset: record.dataset,
      ...(record.nodeId === undefined ? {} : { nodeId: record.nodeId }),
      methodId: record.methodId,
      sourceNodeId: record.sourceNodeId ?? record.sourceId,
    } as const;
    for (const file of await writeStandardMethodTables(record.outputDirectory, record, signals, settings)) {
      artifacts.push(describeArtifact(context, file.path, file.kind, file.mediaType));
    }
    for (const plot of await writeMethodPlots(resolve(record.outputDirectory, "plots"), record, signals, settings)) {
      artifacts.push(describeArtifact(context, plot.path, "plot", "image/svg+xml"));
      for (const path of plot.companionPaths ?? []) artifacts.push(describeArtifact(context, path, "result-table", "text/csv"));
    }
  }

  const signals = records.flatMap((record) => signalsByRecord.get(record.id) ?? []);
  const comparisonDirectory = resolve(outputRoot, "comparisons");
  const comparisonContext = { outputRoot } as const;
  const longPath = resolve(comparisonDirectory, "signals-long.csv");
  await writeText(longPath, signalCsv(signals));
  artifacts.push(describeArtifact(comparisonContext, longPath, "result-table", "text/csv"));
  const catalogPath = resolve(comparisonDirectory, "signal-catalog.csv");
  await writeText(catalogPath, signalCatalogCsv(signals));
  artifacts.push(describeArtifact(comparisonContext, catalogPath, "result-table", "text/csv"));
  for (const unit of ["site", "branch"] as const) {
    const path = resolve(comparisonDirectory, unit === "site" ? "mega-table-sites.csv" : "mega-table-branches.csv");
    await writeText(path, megaTableCsv(signals, unit));
    artifacts.push(describeArtifact(comparisonContext, path, "result-table", "text/csv"));
  }

  const datasets = [...new Map(records.map((record) => [record.datasetId, record.dataset])).entries()];
  for (const [datasetId, dataset] of datasets) {
    const datasetRecords = records.filter((record) => record.datasetId === datasetId);
    const plotSignals = datasetRecords.flatMap((record) => {
      const recordValues = signalsByRecord.get(record.id) ?? [];
      const selected = selectMethodSiteSignal(recordValues, resolveVisualizationSettings(record, pipeline.visualization));
      return selected === undefined ? [] : [selected];
    });
    const directory = resolve(comparisonDirectory, "plots", datasetId);
    for (const plot of await writeComparisonPlots(directory, plotSignals)) {
      const context = { outputRoot, dataset } as const;
      artifacts.push(describeArtifact(context, plot.path, "plot", "image/svg+xml"));
      for (const path of plot.companionPaths ?? []) artifacts.push(describeArtifact(context, path, "result-table", "text/csv"));
    }
  }
  return { artifacts, signals };
}

import { readFile } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import type { SimulatedDataset } from "@phylo-workbench/model-simulator";
import { describeArtifact, type OutputArtifact } from "./exporter.js";
import { writeJson } from "./io.js";
import { parsePipelineDefinition, type PipelineDefinition } from "./pipeline.js";
import { writeReportOutputs, type ReplotIndex, type ReplotRecordReference, type ReportRecord } from "./reporting.js";

export interface ReplotOptions {
  readonly configPath: string;
  readonly outputDirectory: string;
  readonly quiet?: boolean;
}

export interface ReplotSummary {
  readonly pipeline: PipelineDefinition;
  readonly outputDirectory: string;
  readonly datasets: number;
  readonly records: number;
  readonly artifacts: readonly OutputArtifact[];
  readonly manifestPath: string;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseIndex(text: string): ReplotIndex {
  const value: unknown = JSON.parse(text);
  if (!object(value) || value.format !== "evoonline-cli-replot-index" || value.schemaVersion !== 1 || !Array.isArray(value.records)) {
    throw new Error("The output directory has no compatible evo-cli replot cache. Run the analysis once with this version before using --replot.");
  }
  const records = value.records.map((entry, index): ReplotRecordReference => {
    if (!object(entry)
      || typeof entry.id !== "string"
      || typeof entry.dataset !== "string"
      || typeof entry.datasetId !== "string"
      || typeof entry.sourceId !== "string"
      || typeof entry.sourceLabel !== "string"
      || typeof entry.methodId !== "string"
      || typeof entry.methodLabel !== "string"
      || !object(entry.parameters)
      || typeof entry.resultPath !== "string"
      || typeof entry.outputDirectory !== "string"
      || typeof entry.simulationTruth !== "boolean") {
      throw new Error(`Replot cache record ${index + 1} is invalid.`);
    }
    return entry as unknown as ReplotRecordReference;
  });
  return { format: "evoonline-cli-replot-index", schemaVersion: 1, records };
}

function inside(root: string, relativePath: string): string {
  const path = resolve(root, relativePath);
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error(`Replot cache path escapes the output directory: ${relativePath}`);
  return path;
}

function analysisFingerprint(pipeline: PipelineDefinition): string {
  return JSON.stringify({
    schemaVersion: pipeline.schemaVersion,
    id: pipeline.id,
    name: pipeline.name,
    execution: pipeline.execution ?? null,
    nodes: pipeline.nodes,
  });
}

export async function replotPipeline(options: ReplotOptions): Promise<ReplotSummary> {
  const started = new Date();
  const outputRoot = resolve(options.outputDirectory);
  const configPath = resolve(options.configPath);
  const pipeline = parsePipelineDefinition(await readFile(configPath, "utf8"));
  let original: PipelineDefinition;
  let index: ReplotIndex;
  try {
    original = parsePipelineDefinition(await readFile(resolve(outputRoot, "pipeline.json"), "utf8"));
    index = parseIndex(await readFile(resolve(outputRoot, "replot-index.json"), "utf8"));
  } catch (error) {
    if (error instanceof Error && /replot cache/i.test(error.message)) throw error;
    throw new Error(`Cannot replot '${outputRoot}': ${error instanceof Error ? error.message : String(error)}. Run the analysis once with this version first.`);
  }
  if (analysisFingerprint(pipeline) !== analysisFingerprint(original)) {
    throw new Error("--replot only accepts visualization changes. Every non-visualization pipeline setting must match the completed run in pipeline.json.");
  }

  const records: ReportRecord[] = [];
  for (const reference of index.records) {
    const resultPath = inside(outputRoot, reference.resultPath);
    const result: unknown = JSON.parse(await readFile(resultPath, "utf8"));
    records.push({
      id: reference.id,
      dataset: reference.dataset,
      datasetId: reference.datasetId,
      ...(reference.nodeId === undefined ? {} : { nodeId: reference.nodeId }),
      sourceId: reference.sourceId,
      ...(reference.sourceNodeId === undefined ? {} : { sourceNodeId: reference.sourceNodeId }),
      sourceLabel: reference.sourceLabel,
      methodId: reference.methodId,
      methodLabel: reference.methodLabel,
      parameters: reference.parameters,
      result,
      ...(reference.simulationTruth ? { simulationDataset: result as SimulatedDataset, simulationTruth: true as const } : {}),
      resultPath,
      outputDirectory: inside(outputRoot, reference.outputDirectory),
    });
  }
  if (!options.quiet) process.stderr.write(`REPLOT ONLY · loaded ${records.length} saved result record(s); no analysis method will run.\n`);
  const report = await writeReportOutputs(outputRoot, pipeline, records);
  const artifacts = [...report.artifacts];
  const manifestPath = resolve(outputRoot, "replot-manifest.json");
  artifacts.push(describeArtifact({ outputRoot }, manifestPath, "manifest", "application/json", true));
  await writeJson(manifestPath, {
    format: "evoonline-cli-replot",
    schemaVersion: 1,
    config: basename(configPath),
    startedAt: started.toISOString(),
    completedAt: new Date().toISOString(),
    visualization: pipeline.visualization ?? {},
    summary: {
      datasets: new Set(records.map((record) => record.datasetId)).size,
      records: records.length,
      signals: report.signals.length,
      analysisMethodsRerun: 0,
    },
    artifacts,
  });
  if (!options.quiet) process.stderr.write(`Replot complete · analysis methods rerun: 0 · outputs: ${outputRoot}\n`);
  return {
    pipeline,
    outputDirectory: outputRoot,
    datasets: new Set(records.map((record) => record.datasetId)).size,
    records: records.length,
    artifacts,
    manifestPath,
  };
}

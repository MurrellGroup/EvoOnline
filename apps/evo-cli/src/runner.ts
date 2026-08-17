import { basename, extname, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { decodeSimulatorConfig, type SimulatedDataset, type SimulatorAnalysisResult } from "@phylo-workbench/model-simulator";
import { normalizeDifFubarTreeText, type RecombinationCodonTreeSet } from "@phylo-workbench/model-diffubar";
import {
  describeArtifact,
  exportJsonArtifact,
  exportPlainArtifact,
  exportResult,
  exportTreeSet,
  type OutputArtifact,
} from "./exporter.js";
import { findFastTree, inferFastTree, parseFastaText, type FastTreeRuntime } from "./fasttree.js";
import { discoverInputs, pairTrees, prepareOutputDirectory, rowsToCsv, safeName, writeJson, writeText, type DiscoveredFile, type TreePairing } from "./io.js";
import { type ProgressEvent } from "./methods.js";
import { runSelectionMethodIsolated, runSourceMethodIsolated } from "./analysis-worker.js";
import { allocateCpuBudget, availableCpuCount, mapWithConcurrency, normalizeMaxCpus } from "./cpu.js";
import {
  compatibleSources,
  methodLabel,
  nodeStage,
  parsePipelineDefinition,
  pluginById,
  sourceOutputKind,
  type PipelineDefinition,
  type PipelineNode,
  type SourceOutputKind,
} from "./pipeline.js";
import { fsartTreeSet, jemsprTreeSet, mosaicTreeSet, resultBundle, simulatorBundle, simulatorTreeSet, type RecombinationBundle } from "./recombination.js";
import { replotIndex, writeReportOutputs, type ReportRecord } from "./reporting.js";
import { runSimulatorParallel } from "./simulator-parallel.js";

export interface PipelineRunOptions {
  readonly configPath: string;
  readonly inputPaths: readonly string[];
  readonly outputDirectory: string;
  readonly overwrite: boolean;
  readonly fastTreePath?: string;
  readonly maxCpus?: number;
  readonly quiet?: boolean;
}

export interface PipelineRunSummary {
  readonly pipeline: PipelineDefinition;
  readonly outputDirectory: string;
  readonly datasets: number;
  readonly completedRoutes: number;
  readonly failedRoutes: number;
  readonly artifacts: readonly OutputArtifact[];
  readonly manifestPath: string;
}

interface DatasetInput {
  readonly id: string;
  readonly name: string;
  readonly fasta: string;
  readonly alignmentFile?: DiscoveredFile;
  readonly pairing?: TreePairing;
  readonly simulationDataset?: SimulatedDataset;
}

interface SourceProduct {
  readonly node: PipelineNode;
  readonly outputKind: SourceOutputKind;
  readonly tree: string;
  readonly treeSet?: RecombinationCodonTreeSet;
  readonly bundle?: RecombinationBundle;
}

interface RunLogEntry {
  readonly timestamp: string;
  readonly dataset: string;
  readonly component: string;
  readonly status: "info" | "running" | "complete" | "error" | "skipped";
  readonly detail: string;
}

function instanceLabel(node: PipelineNode, stageNodes: readonly PipelineNode[]): string {
  const base = methodLabel(node);
  const matching = stageNodes.filter((candidate) => methodLabel(candidate) === base);
  if (matching.length <= 1) return base;
  return `${base} ${matching.findIndex((candidate) => candidate.id === node.id) + 1}`;
}

function needsFastTree(nodes: readonly PipelineNode[]): boolean {
  return nodes.some((node) => node.kind === "fasttree" || node.modelId === "fsart" || node.modelId === "mosaic-spr" || (node.modelId === "jemspr" && node.parameters.linkedLikelihood !== false));
}

function inputStem(name: string): string {
  const extension = extname(name);
  return name.slice(0, Math.max(0, name.length - extension.length));
}

function sourceTreeFilename(node: PipelineNode): string {
  if (node.kind === "fasttree") return "fasttree.nwk";
  if (node.kind === "user-trees") return "user-tree.nwk";
  if (node.kind === "true-tree") return "true-tree.nwk";
  return `${safeName(node.modelId ?? node.id)}-representative-tree.nwk`;
}

export async function runPipeline(options: PipelineRunOptions): Promise<PipelineRunSummary> {
  const started = new Date();
  const configPath = resolve(options.configPath);
  const pipeline = parsePipelineDefinition(await readFile(configPath, "utf8"));
  const maxCpus = normalizeMaxCpus(options.maxCpus ?? pipeline.execution?.maxCpus, availableCpuCount());
  const outputRoot = await prepareOutputDirectory(options.outputDirectory, options.overwrite);
  const artifacts: OutputArtifact[] = [];
  const logs: RunLogEntry[] = [];
  let completedRoutes = 0;
  let failedRoutes = 0;
  const report = (dataset: string, component: string, status: RunLogEntry["status"], detail: string): void => {
    const entry = { timestamp: new Date().toISOString(), dataset, component, status, detail };
    logs.push(entry);
    if (!options.quiet) process.stderr.write(`[${status.toUpperCase()}] ${dataset} · ${component} · ${detail}\n`);
  };
  const progress = (dataset: string, component: string) => (event: ProgressEvent): void => {
    if (options.quiet) return;
    const percent = Math.round(event.fraction * 100);
    process.stderr.write(`[PROGRESS] ${dataset} · ${component} · ${event.stage} ${percent}%${event.message === undefined ? "" : ` · ${event.message}`}\n`);
  };
  const rootContext = { outputRoot } as const;
  const pipelineCopy = resolve(outputRoot, "pipeline.json");
  artifacts.push(await exportJsonArtifact(pipelineCopy, pipeline, "manifest", rootContext, true));

  const simulatorNode = pipeline.nodes.find((node) => nodeStage(node) === "input");
  const sourceNodes = pipeline.nodes.filter((node) => nodeStage(node) === "source");
  const selectionNodes = pipeline.nodes.filter((node) => nodeStage(node) === "selection");
  const runtime: FastTreeRuntime | undefined = needsFastTree(pipeline.nodes) ? await findFastTree(options.fastTreePath) : undefined;
  if (needsFastTree(pipeline.nodes) && runtime === undefined) {
    throw new Error("This pipeline requires FastTree, but no bundled sibling executable was found. Use the self-contained release archive, pass --fasttree PATH, or set EVO_FASTTREE.");
  }
  report("Pipeline", "Runtime", "info", `${runtime === undefined ? "FastTree is not required by this configuration." : `Using ${runtime.label}.`} CPU limit: ${maxCpus}.`);

  const discovered = simulatorNode === undefined ? await discoverInputs(options.inputPaths, process.cwd()) : [];
  const alignments = discovered.filter((file) => file.kind === "alignment");
  if (simulatorNode === undefined && options.inputPaths.length === 0) throw new Error("At least one --input file or directory is required unless the pipeline starts with Simulator.");
  if (simulatorNode === undefined && alignments.length === 0) throw new Error("No FASTA alignment files were found in the supplied inputs.");
  const pairings = pairTrees(discovered);
  const pairingByAlignment = new Map(pairings.map((pairing) => [pairing.alignment.absolutePath, pairing]));
  const usesUserTrees = sourceNodes.some((node) => node.kind === "user-trees");
  const inputManifestPath = resolve(outputRoot, "input-manifest.csv");
  await writeText(inputManifestPath, rowsToCsv(["path", "kind", "stem"], discovered.map((file) => [file.displayPath, file.kind, file.stem])));
  artifacts.push(describeArtifact(rootContext, inputManifestPath, "manifest", "text/csv", true));
  const pairingPath = resolve(outputRoot, "tree-file-matches.csv");
  await writeText(pairingPath, rowsToCsv(["alignment", "status", "matched tree", "candidate trees"], pairings.map((pairing) => [pairing.alignment.displayPath, pairing.status, pairing.tree?.displayPath ?? "", pairing.candidates.map((candidate) => candidate.displayPath).join(" | ")])));
  artifacts.push(describeArtifact(rootContext, pairingPath, "manifest", "text/csv", true));
  if (usesUserTrees) {
    report("Pipeline", "User-tree matching", "info", `Complete filename-stem match list (${pairings.length} alignment${pairings.length === 1 ? "" : "s"}) follows before analysis.`);
    for (const pairing of pairings) report(pairing.alignment.displayPath, "User-tree match", pairing.status === "matched" ? "complete" : "error", pairing.tree?.displayPath ?? (pairing.status === "ambiguous" ? pairing.candidates.map((candidate) => candidate.displayPath).join(" | ") : "NO MATCH"));
  } else report("Pipeline", "User-tree matching", "info", "No User trees component is present; no filename pairing is required.");

  let simulatorResult: SimulatorAnalysisResult | undefined;
  let datasets: DatasetInput[];
  if (simulatorNode !== undefined) {
    report("Pipeline", instanceLabel(simulatorNode, [simulatorNode]), "running", "Generating simulated alignments and exact truth.");
    simulatorResult = await runSimulatorParallel(decodeSimulatorConfig(simulatorNode.parameters.simulatorConfig), maxCpus, (stage, fraction, detail) => progress("Pipeline", "Simulator")({ stage, fraction, ...(detail?.message === undefined ? {} : { message: detail.message }) }));
    const simulatorDirectory = resolve(outputRoot, "simulator");
    artifacts.push(...await exportResult(simulatorDirectory, simulatorResult, { outputRoot, nodeId: simulatorNode.id, methodId: "simulator" }));
    datasets = simulatorResult.datasets.map((dataset, index) => {
      if (dataset.fasta === undefined) throw new Error(`Simulator dataset ${index + 1} has no FASTA alignment. Enable alignment simulation in the browser pipeline settings.`);
      return { id: safeName(dataset.id, `simulation-${index + 1}`), name: `simulated-dataset-${index + 1}.fasta`, fasta: dataset.fasta, simulationDataset: dataset };
    });
    report("Pipeline", "Simulator", "complete", `${datasets.length} dataset${datasets.length === 1 ? "" : "s"} generated.`);
  } else {
    datasets = await Promise.all(alignments.map(async (alignment, index) => {
      const pairing = pairingByAlignment.get(alignment.absolutePath);
      return { id: `${String(index + 1).padStart(3, "0")}-${safeName(inputStem(alignment.name), "dataset")}`, name: alignment.displayPath, fasta: await readFile(alignment.absolutePath, "utf8"), alignmentFile: alignment, ...(pairing === undefined ? {} : { pairing }) };
    }));
  }

  const comparisonRecords: ReportRecord[] = [];
  const datasetBudget = allocateCpuBudget(maxCpus, datasets.length);
  await mapWithConcurrency(datasets, datasetBudget.parallelism, async (dataset) => {
    const datasetCpus = datasetBudget.cpusPerTask;
    const parsed = parseFastaText(dataset.fasta);
    const sites = parsed.sequences[0]!.length;
    const datasetDirectory = resolve(outputRoot, "datasets", dataset.id);
    const inputContext = { outputRoot, dataset: dataset.name } as const;
    const alignmentPath = resolve(datasetDirectory, "input", "alignment.fasta");
    artifacts.push(await exportPlainArtifact(alignmentPath, dataset.fasta.endsWith("\n") ? dataset.fasta : `${dataset.fasta}\n`, "alignment", "text/x-fasta", inputContext, true));
    report(dataset.name, simulatorNode === undefined ? "Data upload" : "Simulator", "complete", `${parsed.names.length} taxa · ${sites} nucleotide sites.`);

    if (dataset.simulationDataset !== undefined && simulatorNode !== undefined) {
      const truthDirectory = resolve(datasetDirectory, "truth");
      const truthContext = { outputRoot, dataset: dataset.name, nodeId: simulatorNode.id, methodId: "simulator", sourceNodeId: "simulation-ground-truth" } as const;
      artifacts.push(...await exportResult(truthDirectory, dataset.simulationDataset, truthContext));
      const truthSet = simulatorTreeSet(dataset.simulationDataset, sites);
      const truthBundle = simulatorBundle(dataset.simulationDataset, truthSet, sites, parsed.names.length);
      artifacts.push(...await exportTreeSet(truthDirectory, truthSet, truthContext));
      artifacts.push(await exportJsonArtifact(resolve(truthDirectory, "recombination-truth.json"), truthBundle, "recombination-bundle", truthContext, true));
      artifacts.push(await exportPlainArtifact(resolve(truthDirectory, "true-tree.nwk"), `${dataset.simulationDataset.tree.newick.trim()}\n`, "tree", "text/x-newick", truthContext, true));
      comparisonRecords.push({
        id: `${dataset.id}:truth`,
        dataset: dataset.name,
        datasetId: dataset.id,
        nodeId: simulatorNode.id,
        sourceId: "simulation-ground-truth",
        sourceNodeId: "simulation-ground-truth",
        sourceLabel: "Simulation truth",
        methodId: "simulator",
        methodLabel: "Truth",
        parameters: simulatorNode.parameters,
        result: dataset.simulationDataset,
        simulationDataset: dataset.simulationDataset,
        simulationTruth: true,
        outputDirectory: truthDirectory,
        resultPath: resolve(truthDirectory, "result.json"),
      });
    }

    const products = new Map<string, SourceProduct>();
    const sourceBudget = allocateCpuBudget(datasetCpus, sourceNodes.length);
    await mapWithConcurrency(sourceNodes, sourceBudget.parallelism, async (node) => {
      const label = instanceLabel(node, sourceNodes);
      const outputKind = sourceOutputKind(node);
      report(dataset.name, label, "running", "Source route started directly from the alignment.");
      try {
        if (outputKind === undefined) throw new Error("The component has no declared source output.");
        const sourceDirectory = resolve(datasetDirectory, "sources", safeName(label));
        const context = { outputRoot, dataset: dataset.name, nodeId: node.id, ...(node.modelId === undefined ? {} : { methodId: node.modelId }), sourceNodeId: node.id };
        let tree: string;
        let treeSet: RecombinationCodonTreeSet | undefined;
        let bundle: RecombinationBundle | undefined;
        if (node.kind === "user-trees") {
          const pairing = dataset.pairing;
          if (pairing === undefined || pairing.status === "missing") throw new Error(`No tree filename matches ${dataset.name} after removing extensions.`);
          if (pairing.status === "ambiguous") throw new Error(`More than one tree matches ${dataset.name}: ${pairing.candidates.map((candidate) => candidate.displayPath).join(", ")}.`);
          if (pairing.tree === undefined) throw new Error("The matched tree is unavailable.");
          const uploadedTree = await readFile(pairing.tree.absolutePath, "utf8");
          const extension = extname(pairing.tree.name).toLowerCase() || ".txt";
          artifacts.push(await exportPlainArtifact(resolve(sourceDirectory, `uploaded-tree${extension}`), uploadedTree.endsWith("\n") ? uploadedTree : `${uploadedTree}\n`, "tree", "text/plain", context));
          tree = normalizeDifFubarTreeText(uploadedTree).newick;
        } else if (node.kind === "fasttree") {
          if (runtime === undefined) throw new Error("FastTree is unavailable.");
          tree = await inferFastTree(runtime, dataset.fasta, Boolean(node.parameters.fastest ?? false), sourceBudget.cpusPerTask);
        } else if (node.kind === "true-tree") {
          if (dataset.simulationDataset === undefined) throw new Error("True tree requires a Simulator input.");
          treeSet = simulatorTreeSet(dataset.simulationDataset, sites);
          tree = treeSet.segments[0]?.tree ?? dataset.simulationDataset.tree.newick;
          bundle = simulatorBundle(dataset.simulationDataset, treeSet, sites, parsed.names.length);
          if (treeSet.segments.length <= 1) treeSet = undefined;
        } else if (node.modelId === "fsart") {
          const result = await runSourceMethodIsolated("fsart", dataset.fasta, node.parameters, runtime, progress(dataset.name, label), sourceBudget.cpusPerTask);
          artifacts.push(...await exportResult(sourceDirectory, result, context));
          treeSet = fsartTreeSet(result, sites);
          tree = treeSet.segments[0]!.tree;
          bundle = resultBundle(result, treeSet, sites, parsed.names.length);
        } else if (node.modelId === "mosaic-spr") {
          const result = await runSourceMethodIsolated("mosaic-spr", dataset.fasta, node.parameters, runtime, progress(dataset.name, label), sourceBudget.cpusPerTask);
          artifacts.push(...await exportResult(sourceDirectory, result, context));
          treeSet = mosaicTreeSet(result, sites);
          tree = treeSet.segments[0]!.tree;
          bundle = resultBundle(result, treeSet, sites, parsed.names.length);
        } else if (node.modelId === "jemspr") {
          const result = await runSourceMethodIsolated("jemspr", dataset.fasta, node.parameters, runtime, progress(dataset.name, label), sourceBudget.cpusPerTask);
          artifacts.push(...await exportResult(sourceDirectory, result, context));
          treeSet = jemsprTreeSet(result, sites);
          tree = treeSet.segments[0]!.tree;
          bundle = resultBundle(result, treeSet, sites, parsed.names.length);
        } else throw new Error(`Unsupported source method '${node.modelId ?? node.kind}'.`);
        const treePath = resolve(sourceDirectory, sourceTreeFilename(node));
        artifacts.push(await exportPlainArtifact(treePath, tree.trim().endsWith(";") ? `${tree.trim()}\n` : `${tree.trim()};\n`, "tree", "text/x-newick", context, true));
        if (treeSet !== undefined) artifacts.push(...await exportTreeSet(sourceDirectory, treeSet, context));
        if (bundle !== undefined) artifacts.push(await exportJsonArtifact(resolve(sourceDirectory, "recombination-tree-bundle.json"), bundle, "recombination-bundle", context, true));
        products.set(node.id, { node, outputKind, tree, ...(treeSet === undefined ? {} : { treeSet }), ...(bundle === undefined ? {} : { bundle }) });
        completedRoutes += 1;
        report(dataset.name, label, "complete", treeSet === undefined ? "Tree output exported." : `${treeSet.segments.length} regional tree${treeSet.segments.length === 1 ? "" : "s"}, bundle, and detailed method output exported.`);
      } catch (error) {
        failedRoutes += 1;
        report(dataset.name, label, "error", error instanceof Error ? error.message : String(error));
      }
    });

    const routeTasks = selectionNodes.flatMap((node) => compatibleSources(node, pipeline.nodes).map((source) => ({ node, source })));
    const selectionBudget = allocateCpuBudget(datasetCpus, routeTasks.length);
    await mapWithConcurrency(routeTasks, selectionBudget.parallelism, async ({ node, source }) => {
        const targetLabel = instanceLabel(node, selectionNodes);
        const sourceLabel = instanceLabel(source, sourceNodes);
        const routeLabel = `${targetLabel} via ${sourceLabel}`;
        const product = products.get(source.id);
        if (product === undefined) {
          failedRoutes += 1;
          report(dataset.name, routeLabel, "skipped", `${sourceLabel} did not produce its declared output.`);
          return;
        }
        report(dataset.name, routeLabel, "running", "Selection route started.");
        try {
          if (node.modelId === undefined) throw new Error("Selection component has no method identifier.");
          const plugin = pluginById.get(node.modelId);
          const tree = plugin?.prepareTreeInput === undefined ? product.tree : plugin.prepareTreeInput(product.tree);
          const result = await runSelectionMethodIsolated(node.modelId, dataset.fasta, tree, node.parameters, progress(dataset.name, routeLabel), product.treeSet, selectionBudget.cpusPerTask);
          const analysisDirectory = resolve(datasetDirectory, "analyses", `${safeName(targetLabel)}-via-${safeName(sourceLabel)}`);
          const context = { outputRoot, dataset: dataset.name, nodeId: node.id, methodId: node.modelId, sourceNodeId: source.id } as const;
          artifacts.push(...await exportResult(analysisDirectory, result, context));
          artifacts.push(await exportPlainArtifact(resolve(analysisDirectory, "input-tree.nwk"), tree.trim().endsWith(";") ? `${tree.trim()}\n` : `${tree.trim()};\n`, "tree", "text/x-newick", context, true));
          if (product.treeSet !== undefined) artifacts.push(...await exportTreeSet(resolve(analysisDirectory, "downstream-input"), product.treeSet, context));
          if (product.bundle !== undefined) artifacts.push(await exportJsonArtifact(resolve(analysisDirectory, "downstream-input", "recombination-tree-bundle.json"), product.bundle, "recombination-bundle", context, true));
          comparisonRecords.push({
            id: `${dataset.id}:${node.id}:${source.id}`,
            dataset: dataset.name,
            datasetId: dataset.id,
            nodeId: node.id,
            sourceId: source.id,
            sourceNodeId: source.id,
            sourceLabel,
            methodId: node.modelId,
            methodLabel: targetLabel,
            parameters: node.parameters,
            result,
            outputDirectory: analysisDirectory,
            resultPath: resolve(analysisDirectory, "result.json"),
          });
          completedRoutes += 1;
          report(dataset.name, routeLabel, "complete", "Detailed JSON, human-readable standard tables, plots, trees, and downstream inputs exported.");
        } catch (error) {
          failedRoutes += 1;
          report(dataset.name, routeLabel, "error", error instanceof Error ? error.message : String(error));
        }
    });
  });

  const reportOutput = await writeReportOutputs(outputRoot, pipeline, comparisonRecords);
  artifacts.push(...reportOutput.artifacts);
  const signals = reportOutput.signals;
  const replotIndexPath = resolve(outputRoot, "replot-index.json");
  await writeJson(replotIndexPath, replotIndex(outputRoot, comparisonRecords));
  artifacts.push(describeArtifact(rootContext, replotIndexPath, "manifest", "application/json", true));

  const logCsvPath = resolve(outputRoot, "run-log.csv");
  await writeText(logCsvPath, rowsToCsv(["timestamp", "dataset", "component", "status", "detail"], logs.map((entry) => [entry.timestamp, entry.dataset, entry.component, entry.status, entry.detail])));
  artifacts.push(describeArtifact(rootContext, logCsvPath, "log", "text/csv"));
  const manifestPath = resolve(outputRoot, "run-manifest.json");
  const manifestArtifact = describeArtifact(rootContext, manifestPath, "manifest", "application/json", true);
  artifacts.push(manifestArtifact);
  await writeJson(manifestPath, {
    format: "evoonline-cli-run",
    schemaVersion: 1,
    pipeline,
    startedAt: started.toISOString(),
    completedAt: new Date().toISOString(),
    runtime: { node: process.version, platform: process.platform, architecture: process.arch, logicalCpus: availableCpuCount(), maxCpus, fastTree: runtime?.label ?? null },
    inputs: { config: basename(configPath), paths: options.inputPaths, discoveredFiles: discovered.length, treePairings: pairings.map((pairing) => ({ alignment: pairing.alignment.displayPath, status: pairing.status, tree: pairing.tree?.displayPath ?? null, candidates: pairing.candidates.map((candidate) => candidate.displayPath) })) },
    summary: { datasets: datasets.length, completedRoutes, failedRoutes, comparisonRecords: comparisonRecords.length, signals: signals.length },
    artifacts,
  });
  if (!options.quiet) process.stderr.write(`Pipeline complete · ${datasets.length} dataset(s) · ${completedRoutes} completed route(s) · ${failedRoutes} failed route(s)\nOutputs: ${outputRoot}\n`);
  return { pipeline, outputDirectory: outputRoot, datasets: datasets.length, completedRoutes, failedRoutes, artifacts, manifestPath };
}

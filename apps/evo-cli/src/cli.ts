import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { methodLabel, nodeStage, parsePipelineDefinition, pluginById, compatibleSources } from "./pipeline.js";
import { replotPipeline } from "./replot.js";
import { runPipeline } from "./runner.js";

const VERSION = "0.1.7";

export function installBrokenPipeHandler(): void {
  const handler = (error: NodeJS.ErrnoException): void => {
    if (error.code === "EPIPE") process.exit(0);
    throw error;
  };
  process.stdout.on("error", handler);
  process.stderr.on("error", handler);
}

const HELP = `evo-cli ${VERSION} — run EvoOnline browser pipeline configurations locally

Usage:
  evo-cli run --config PIPELINE.json --input PATH [--input PATH ...] --output DIRECTORY [options]
  evo-cli run --config PIPELINE.json --output EXISTING_DIRECTORY --replot
  evo-cli validate --config PIPELINE.json
  evo-cli methods
  evo-cli version

Run options:
  -c, --config PATH       Pipeline JSON exported by the EvoOnline browser app (required)
  -i, --input PATH        FASTA/tree file or directory; repeat for multiple inputs
  -o, --output DIRECTORY  Required output directory for all detailed artifacts
      --fasttree PATH     Override the bundled sibling FastTree executable
      --cpus N            Maximum logical CPUs (default: config value or available CPUs)
      --overwrite         Allow writing into a non-empty output directory
      --replot            Regenerate tables and plots from saved results; run no analyses
      --quiet             Suppress progress lines; fatal errors still print
  -h, --help              Show this help

Simulator pipelines do not require --input. User-tree matching is exact and
case-insensitive after removing the final filename extension. The complete
match list is printed and written before any analysis begins.

Every compatible method × source route runs independently. Detailed JSON and
human-readable CSV results, trees, regional-tree bundles, truth, mega-tables,
SVG plots, logs, and a machine-readable artifact manifest are written below
--output. With --replot, only visualization settings may differ from the saved
pipeline; no model fitting, simulation, recombination detection, or tree
inference is rerun.
`;

interface ParsedArguments {
  readonly values: ReadonlyMap<string, readonly string[]>;
  readonly flags: ReadonlySet<string>;
  readonly positionals: readonly string[];
}

function parseArguments(args: readonly string[]): ParsedArguments {
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  const positionals: string[] = [];
  const aliases: Readonly<Record<string, string>> = { "-c": "--config", "-i": "--input", "-o": "--output", "-h": "--help" };
  const valueOptions = new Set(["--config", "--input", "--output", "--fasttree", "--cpus"]);
  const flagOptions = new Set(["--overwrite", "--replot", "--quiet", "--help"]);
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index]!;
    const equals = raw.startsWith("--") ? raw.indexOf("=") : -1;
    const rawName = equals > 0 ? raw.slice(0, equals) : raw;
    const name = aliases[rawName] ?? rawName;
    if (valueOptions.has(name)) {
      const value = equals > 0 ? raw.slice(equals + 1) : args[++index];
      if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value.`);
      values.set(name, [...(values.get(name) ?? []), value]);
    } else if (flagOptions.has(name)) flags.add(name);
    else if (raw.startsWith("-")) throw new Error(`Unknown option: ${raw}`);
    else positionals.push(raw);
  }
  return { values, flags, positionals };
}

function one(argumentsValue: ParsedArguments, name: string, required = false): string | undefined {
  const values = argumentsValue.values.get(name) ?? [];
  if (values.length > 1) throw new Error(`${name} may be supplied only once.`);
  if (required && values.length === 0) throw new Error(`${name} is required.`);
  return values[0];
}

async function validate(config: string): Promise<void> {
  const definition = parsePipelineDefinition(await readFile(resolve(config), "utf8"));
  const sources = definition.nodes.filter((node) => nodeStage(node) === "source");
  const selections = definition.nodes.filter((node) => nodeStage(node) === "selection");
  process.stdout.write(`Valid EvoOnline pipeline schema v${definition.schemaVersion}: ${definition.name}\n`);
  process.stdout.write(`${definition.nodes.length} component(s) · ${sources.length} source route(s) · ${selections.reduce((sum, selection) => sum + compatibleSources(selection, definition.nodes).length, 0)} selection route(s)\n`);
  for (const node of definition.nodes) {
    const stage = nodeStage(node) ?? "unknown";
    const routes = stage === "selection" ? ` ← ${compatibleSources(node, definition.nodes).map((source) => methodLabel(source)).join(", ")}` : "";
    process.stdout.write(`  ${stage.padEnd(9)} ${methodLabel(node)}${routes}\n`);
  }
}

function methods(): void {
  const entries = [...pluginById.values()].sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
  process.stdout.write("METHOD\tCATEGORY\tTITLE\n");
  for (const plugin of entries) process.stdout.write(`${plugin.manifest.id}\t${plugin.manifest.category}\t${plugin.manifest.title}\n`);
  process.stdout.write("fasttree\tphylogeny\tFastTree tree inference\nuser-trees\tphylogeny\tFilename-matched user trees\ntrue-tree\tsimulation\tExact simulator tree/recombination graph\n");
}

export async function runCli(argv: readonly string[]): Promise<number> {
  const command = argv[0] === undefined || argv[0].startsWith("-") ? "help" : argv[0];
  const parsed = parseArguments(argv[0] === undefined || argv[0].startsWith("-") ? argv : argv.slice(1));
  if (parsed.flags.has("--help") || command === "help") { process.stdout.write(HELP); return 0; }
  if (command === "version" || command === "--version" || command === "-v") { process.stdout.write(`${VERSION}\n`); return 0; }
  if (command === "methods") { methods(); return 0; }
  if (command === "validate") {
    const config = one(parsed, "--config", true)!;
    await validate(config);
    return 0;
  }
  if (command !== "run") throw new Error(`Unknown command '${command}'. Run evo-cli help for usage.`);
  if (parsed.positionals.length > 0) throw new Error(`Unexpected positional argument(s): ${parsed.positionals.join(", ")}. Use --input PATH.`);
  const config = one(parsed, "--config", true)!;
  const output = one(parsed, "--output", true)!;
  const fastTree = one(parsed, "--fasttree");
  const cpusText = one(parsed, "--cpus");
  const maxCpus = cpusText === undefined ? undefined : Number(cpusText);
  if (maxCpus !== undefined && (!Number.isInteger(maxCpus) || maxCpus < 1)) throw new Error("--cpus requires a positive integer.");
  if (parsed.flags.has("--replot")) {
    if ((parsed.values.get("--input") ?? []).length > 0) throw new Error("--replot does not accept --input because it never reruns an analysis.");
    if (fastTree !== undefined) throw new Error("--replot does not accept --fasttree because it never reruns tree inference.");
    if (maxCpus !== undefined) throw new Error("--replot does not accept --cpus because it never reruns an analysis.");
    if (parsed.flags.has("--overwrite")) throw new Error("--replot writes only regenerated tables and plots in the existing output directory; do not pass --overwrite.");
    const summary = await replotPipeline({ configPath: config, outputDirectory: output, quiet: parsed.flags.has("--quiet") });
    process.stdout.write(`${summary.manifestPath}\n`);
    return 0;
  }
  const summary = await runPipeline({
    configPath: config,
    inputPaths: parsed.values.get("--input") ?? [],
    outputDirectory: output,
    overwrite: parsed.flags.has("--overwrite"),
    quiet: parsed.flags.has("--quiet"),
    ...(maxCpus === undefined ? {} : { maxCpus }),
    ...(fastTree === undefined ? {} : { fastTreePath: fastTree }),
  });
  process.stdout.write(`${summary.manifestPath}\n`);
  return summary.failedRoutes === 0 ? 0 : 2;
}

#!/usr/bin/env bun
import { dirname, join } from "node:path";
import { configureWasmBinary } from "@phylo-workbench/model-diffubar";
import diffubarWasmPath from "../../../models/diffubar/src/wasm/diffubar.wasm" with { type: "file" };
import { configureAnalysisWorkers } from "./analysis-worker.js";
import { installBrokenPipeHandler, runCli } from "./cli.js";
import { configureSimulatorWorker } from "./simulator-parallel.js";

// Bun's standalone compiler embeds this immutable file in its virtual
// filesystem. FastTree deliberately remains a separate sibling executable.
configureWasmBinary(diffubarWasmPath);
const siblingDirectory = dirname(process.execPath);
configureAnalysisWorkers(join(siblingDirectory, "evo-analysis-worker.js"), undefined, join(siblingDirectory, "diffubar.wasm"));
configureSimulatorWorker(join(siblingDirectory, "evo-simulator-worker.js"));
installBrokenPipeHandler();

try {
  process.exitCode = await runCli(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`evo-cli: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

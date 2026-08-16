#!/usr/bin/env bun
import { configureWasmBinary } from "@phylo-workbench/model-diffubar";
import diffubarWasmPath from "../../../models/diffubar/src/wasm/diffubar.wasm" with { type: "file" };
import { installBrokenPipeHandler, runCli } from "./cli.js";

// Bun's standalone compiler embeds this immutable file in its virtual
// filesystem. FastTree deliberately remains a separate sibling executable.
configureWasmBinary(diffubarWasmPath);
installBrokenPipeHandler();

try {
  process.exitCode = await runCli(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`evo-cli: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

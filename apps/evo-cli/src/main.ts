#!/usr/bin/env node
import { installBrokenPipeHandler, runCli } from "./cli.js";

installBrokenPipeHandler();

try {
  process.exitCode = await runCli(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`evo-cli: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

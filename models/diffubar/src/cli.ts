#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { analyzeDifFUBAR, resultsToCsv } from "./pipeline.js";
import { getGeneticCode } from "./model/genetic-code.js";
import type { FittedModel } from "./types.js";

function valueAfter(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const fastaPath = valueAfter("--fasta");
  const treePath = valueAfter("--tree");
  const outputPath = valueAfter("--output") ?? "diffubar_posteriors.csv";
  if (fastaPath === undefined || treePath === undefined) {
    process.stderr.write([
      "Usage: diffubar-webgpu --fasta alignment.fasta --tree tagged.nwk [options]",
      "  --output FILE             CSV output (default: diffubar_posteriors.csv)",
      "  --backend auto|wasm-parallel|wasm|webgpu",
      "  --iterations N            Gibbs iterations (default: 2500)",
      "  --burnin N                 Gibbs burn-in (default: iterations/5)",
      "  --foreground-grid N        Grid points below one (default: 6)",
      "  --background-grid N        Background points below one (default: 4)",
      "  --threshold P              Detection threshold (default: 0.95)",
      "  --genetic-code N           NCBI translation table (default: 1)",
      "  --seed N                   Reproducible WASM RNG seed",
      "  --reference-fit            Slower optimizer-compatible fit",
      "  --fitted-model FILE        Reuse a fitted-model JSON object",
      "  --save-fitted-model FILE   Write the fitted model for exact reuse",
      "  --strict-sampler           Disable the 1e-12 likelihood cutoff",
      "  --reference-sampler        Use the dense Julia-style Gibbs transition",
      "",
    ].join("\n"));
    process.exitCode = 2;
    return;
  }
  const [fasta, tree] = await Promise.all([readFile(fastaPath, "utf8"), readFile(treePath, "utf8")]);
  const iterations = Number(valueAfter("--iterations") ?? 2500);
  const burninValue = valueAfter("--burnin");
  const backendValue = valueAfter("--backend") ?? "auto";
  const geneticCode = getGeneticCode(valueAfter("--genetic-code") ?? 1);
  if (!["auto", "wasm", "wasm-parallel", "webgpu"].includes(backendValue)) throw new Error(`Unknown backend '${backendValue}'.`);
  let fittedModel: FittedModel | undefined;
  const fittedModelPath = valueAfter("--fitted-model");
  if (fittedModelPath !== undefined) {
    const parsed = JSON.parse(await readFile(fittedModelPath, "utf8")) as Record<string, unknown>;
    fittedModel = {
      geneticCodeId: getGeneticCode(Number(parsed["geneticCodeId"] ?? 1)).id,
      gtrRates: Float64Array.from(parsed["gtrRates"] as ArrayLike<number>),
      f3x4: Float64Array.from(parsed["f3x4"] as ArrayLike<number>),
      codonEquilibrium: Float64Array.from(parsed["codonEquilibrium"] as ArrayLike<number>),
      globalAlpha: Number(parsed["globalAlpha"]),
      globalBeta: Number(parsed["globalBeta"]),
      logLikelihood: Number(parsed["logLikelihood"]),
      fitKind: "provided",
    };
  }
  const result = await analyzeDifFUBAR(fasta, tree, {
    geneticCode: geneticCode.id,
    backend: backendValue as "auto" | "wasm" | "wasm-parallel" | "webgpu",
    iterations,
    ...(burninValue === undefined ? {} : { burnin: Number(burninValue) }),
    foregroundGrid: Number(valueAfter("--foreground-grid") ?? 6),
    backgroundGrid: Number(valueAfter("--background-grid") ?? 4),
    posteriorThreshold: Number(valueAfter("--threshold") ?? 0.95),
    ...(valueAfter("--seed") === undefined ? {} : { seed: Number(valueAfter("--seed")) }),
    fitMode: process.argv.includes("--reference-fit") ? "reference-compatible" : "empirical-fast",
    samplerMode: process.argv.includes("--reference-sampler") ? "reference" : "fast-exact",
    ...(fittedModel === undefined ? {} : { fittedModel }),
    likelihoodCutoff: process.argv.includes("--strict-sampler") ? 0 : 1e-12,
    onStage: (stage, fraction) => {
      process.stderr.write(`\r${stage.padEnd(25)} ${(fraction * 100).toFixed(1).padStart(6)}%`);
    },
  });
  process.stderr.write("\n");
  await writeFile(outputPath, resultsToCsv(result));
  const savedModelPath = valueAfter("--save-fitted-model");
  if (savedModelPath !== undefined) {
    await writeFile(savedModelPath, `${JSON.stringify({
      ...result.fittedModel,
      gtrRates: Array.from(result.fittedModel.gtrRates),
      f3x4: Array.from(result.fittedModel.f3x4),
      codonEquilibrium: Array.from(result.fittedModel.codonEquilibrium),
    }, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify({
    outputPath,
    ...(savedModelPath === undefined ? {} : { savedModelPath }),
    backend: result.backend,
    diagnostics: result.diagnostics,
    timings: result.timings,
  }, null, 2)}\n`);
}

await main();

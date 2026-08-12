import { readFile } from "node:fs/promises";
import { analyzeCladeShift } from "../src/index.js";

const sourceAlignment = await readFile(new URL("../../../examples/diffubar-demo.fasta", import.meta.url), "utf8");
const tree = await readFile(new URL("../../../examples/diffubar-demo.nwk", import.meta.url), "utf8");
const repeats = Math.max(1, Number.parseInt(process.env.EVOONLINE_CLADE_SHIFT_REPEAT ?? "1", 10) || 1);
const alignment = sourceAlignment
  .split("\n")
  .map((line) => line.length === 0 || line.startsWith(">") ? line : line.repeat(repeats))
  .join("\n");

let previous = "";
const result = await analyzeCladeShift(alignment, tree, {
  backend: "wasm-parallel",
  gridPoints: 16,
  intensityPreset: "fast",
  onStage: (stage, fraction, detail) => {
    const key = `${stage}:${Math.round(fraction * 20)}`;
    if (key === previous) return;
    previous = key;
    console.log(stage.padEnd(36), fraction.toFixed(2), detail?.message ?? "");
  },
});

console.log(JSON.stringify({
  repeatedDemoCopies: repeats,
  taxa: result.diagnostics.taxa,
  codonSites: result.diagnostics.codonSites,
  branches: result.diagnostics.branches,
  candidateClades: result.diagnostics.candidateClades,
  backend: result.backend,
  detectedSites: result.detectedSites.length,
  minimumCapturedPosteriorMass: result.diagnostics.minimumCapturedPosteriorMass,
  meanCapturedPosteriorMass: result.diagnostics.meanCapturedPosteriorMass,
  maximumPosteriorComponents: result.diagnostics.posteriorComponents,
  meanPosteriorComponents: result.diagnostics.meanPosteriorComponents,
  timings: result.timings,
}, null, 2));

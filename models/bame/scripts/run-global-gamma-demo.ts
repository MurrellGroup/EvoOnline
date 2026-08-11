import { readFile } from "node:fs/promises";
import { analyzeGlobalGamma } from "../src/index.js";

const alignment = await readFile(new URL("../../../examples/diffubar-demo.fasta", import.meta.url), "utf8");
const tree = (await readFile(new URL("../../../examples/diffubar-demo.nwk", import.meta.url), "utf8")).replaceAll(/\{[^}]+\}/g, "");
let previous = "";
const result = await analyzeGlobalGamma(alignment, tree, {
  backend: "wasm-parallel",
  omegaSlices: 8,
  alphaSlices: 4,
  fitPreset: "fast",
  onStage: (stage, fraction, detail) => {
    const key = `${stage}:${Math.round(fraction * 20)}`;
    if (key === previous) return;
    previous = key;
    console.log(stage.padEnd(28), fraction.toFixed(2), detail?.message ?? "");
  },
});

console.log(JSON.stringify({
  fit: result.fit,
  positivePrior: result.positivePrior,
  strongestSites: result.sites.slice().sort((left, right) => right.cappedLogEvidence - left.cappedLogEvidence).slice(0, 5),
  strongestBranches: result.branches.slice().sort((left, right) => right.activationLogBayesFactor - left.activationLogBayesFactor).slice(0, 5),
  timings: result.timings,
  backend: result.backend,
}, null, 2));

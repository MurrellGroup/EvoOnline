import { readFile } from "node:fs/promises";
import { analyzeFlavor } from "../src/pipeline.js";

const fasta = await readFile(new URL("../../../examples/diffubar-demo.fasta", import.meta.url), "utf8");
const tree = (await readFile(new URL("../../../examples/diffubar-demo.nwk", import.meta.url), "utf8"))
  .replaceAll(/\{[^}]+\}/g, "");
const interpolated = await analyzeFlavor(fasta, tree, {
  backend: "wasm-parallel",
  gridPreset: "fast",
  gammaSlices: 12,
  iterations: 100,
  transitionEngine: "julia-interpolated",
});
const direct = await analyzeFlavor(fasta, tree, {
  backend: "wasm-parallel",
  gridPreset: "fast",
  gammaSlices: 12,
  iterations: 100,
  transitionEngine: "direct-uniformization",
  fittedModel: interpolated.fittedModel,
});
console.log(JSON.stringify([
  { engine: "julia-interpolated", backend: interpolated.backend, ...interpolated.timings },
  { engine: "direct-uniformization", backend: direct.backend, ...direct.timings },
], null, 2));

import { readFile } from "node:fs/promises";
import { analyzeFubar } from "./models/fubar/src/index.ts";

const source = await readFile("./examples/diffubar-demo.fasta", "utf8");
const alignment = source.split("\n").map((line) => line.length === 0 || line.startsWith(">") ? line : line.repeat(3)).join("\n");
const tree = (await readFile("./examples/diffubar-demo.nwk", "utf8")).replaceAll(/\{[^}]+\}/g, "");
const result = await analyzeFubar(alignment, tree, { backend: "wasm-parallel", gridPoints: 16, inferenceMethod: "dirichlet-em", iterations: 1_000, fitMode: "empirical-fast" });
for (const count of [8, 12, 16, 24, 32, 48, 64, 96, 128]) {
  let minimum = 1;
  let mean = 0;
  for (let site = 0; site < result.posterior.siteCount; site += 1) {
    const start = site * 256;
    const sorted = Array.from(result.posterior.surfaces.subarray(start, start + 256)).sort((left, right) => right - left);
    const mass = sorted.slice(0, count).reduce((sum, value) => sum + value, 0);
    minimum = Math.min(minimum, mass);
    mean += mass;
  }
  console.log(count, minimum, mean / result.posterior.siteCount);
}
for (const target of [0.8, 0.9, 0.95, 0.98]) {
  const required: number[] = [];
  for (let site = 0; site < result.posterior.siteCount; site += 1) {
    const start = site * 256;
    const sorted = Array.from(result.posterior.surfaces.subarray(start, start + 256)).sort((left, right) => right - left);
    let mass = 0;
    let count = 0;
    while (count < sorted.length && mass < target) mass += sorted[count++]!;
    required.push(count);
  }
  console.log("target", target, "minimum", Math.min(...required), "mean", required.reduce((sum, value) => sum + value, 0) / required.length, "maximum", Math.max(...required));
}

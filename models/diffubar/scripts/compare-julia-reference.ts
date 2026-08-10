import { readFile } from "node:fs/promises";
import {
  WasmBackend,
  buildModelBank,
  compileTree,
  createDifFUBARGrid,
  encodeCodonTips,
  parseFasta,
  parseTaggedNewick,
} from "../src/index.js";

function valueAfter(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function matrix(text: string): number[][] {
  return text.trim().split(/\r?\n/).map((line) => line.trim().split(/\s+/).map(Number));
}

const fastaPath = valueAfter("--fasta");
const treePath = valueAfter("--tree");
const prefix = valueAfter("--prefix");
if (fastaPath === undefined || treePath === undefined || prefix === undefined) {
  throw new Error("usage: compare-julia-reference.ts --fasta alignment.fasta --tree tree.nex --prefix reference-prefix");
}
const foregroundGrid = Number(valueAfter("--foreground-grid") ?? 6);
const backgroundGrid = Number(valueAfter("--background-grid") ?? 4);
const tolerance = Number(valueAfter("--tolerance") ?? 1e-8);
const [fastaText, treeText, modelText, categoryText, referenceText] = await Promise.all([
  readFile(fastaPath, "utf8"),
  readFile(treePath, "utf8"),
  readFile(`${prefix}.model.tsv`, "utf8"),
  readFile(`${prefix}.categories.tsv`, "utf8"),
  readFile(`${prefix}.log-likelihoods.tsv`, "utf8"),
]);
const model = matrix(modelText)[0]!;
if (model.length !== 82) throw new Error(`Expected 82 fitted-model values, found ${model.length}.`);
const alignment = parseFasta(fastaText);
const tree = parseTaggedNewick(treeText);
const globalAlpha = model[0]!;
for (const node of tree.nodes) node.branchLength *= globalAlpha;
const grid = createDifFUBARGrid(tree.hasBackground, foregroundGrid, backgroundGrid);
const referenceCategories = matrix(categoryText);
if (referenceCategories.length !== grid.categoryCount) {
  throw new Error(`Category count differs: Julia=${referenceCategories.length}, TypeScript=${grid.categoryCount}.`);
}
let maximumCategoryError = 0;
for (let category = 0; category < grid.categoryCount; category += 1) {
  for (let parameter = 0; parameter < grid.parameterCount; parameter += 1) {
    maximumCategoryError = Math.max(
      maximumCategoryError,
      Math.abs(referenceCategories[category]![parameter]! - grid.categories[category * grid.parameterCount + parameter]!),
    );
  }
}

const f3x4 = Float64Array.from(model.slice(9, 21));
const result = await new WasmBackend().evaluate({
  tree: compileTree(tree),
  tipStates: encodeCodonTips(alignment, tree),
  siteCount: alignment.codonSites,
  grid,
  models: buildModelBank(grid, tree, Float64Array.from(model.slice(3, 9)), f3x4),
  equilibrium: Float64Array.from(model.slice(21, 82)),
});
const reference = matrix(referenceText);
let maximumLikelihoodError = 0;
for (let category = 0; category < grid.categoryCount; category += 1) {
  for (let site = 0; site < alignment.codonSites; site += 1) {
    maximumLikelihoodError = Math.max(
      maximumLikelihoodError,
      Math.abs(reference[category]![site]! - result.logLikelihoods[category * alignment.codonSites + site]!),
    );
  }
}
if (maximumCategoryError > 1e-12 || maximumLikelihoodError > tolerance) {
  throw new Error(`Julia parity failed: category |Δ|max=${maximumCategoryError}, log L |Δ|max=${maximumLikelihoodError}.`);
}
process.stdout.write(`${JSON.stringify({
  categories: grid.categoryCount,
  codonSites: alignment.codonSites,
  maximumCategoryError,
  maximumLogLikelihoodError: maximumLikelihoodError,
  tolerance,
}, null, 2)}\n`);

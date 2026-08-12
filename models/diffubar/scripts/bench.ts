import { performance } from "node:perf_hooks";
import {
  SENSE_CODONS,
  analyzeDifFUBAR,
  codonEquilibriumFromF3x4,
  countF3x4,
  parseFasta,
  type FittedModel,
} from "../src/index.js";

const full = process.argv.includes("--full");
const codonSites = Number(valueAfter("--sites") ?? (full ? 96 : 48));
const foregroundGrid = Number(valueAfter("--foreground-grid") ?? (full ? 6 : 3));
const backgroundGrid = Number(valueAfter("--background-grid") ?? (full ? 4 : 3));
const iterations = Number(valueAfter("--iterations") ?? (full ? 2_500 : 250));
const backend = valueAfter("--backend") ?? "wasm";

function valueAfter(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function syntheticFasta(sites: number): string {
  const records: string[] = [];
  for (let taxon = 0; taxon < 8; taxon += 1) {
    let sequence = "";
    for (let site = 0; site < sites; site += 1) {
      // Deterministic, variable, stop-free data with some conserved columns.
      const index = site % 7 === 0 ? site % SENSE_CODONS.length : (site * 11 + taxon * 17) % SENSE_CODONS.length;
      sequence += SENSE_CODONS[index]!;
    }
    records.push(`>t${taxon}\n${sequence}`);
  }
  return `${records.join("\n")}\n`;
}

const tree = [
  "(",
  "((t0{G1}:0.05,t1{G1}:0.06){G1}:0.04,(t2:0.08,t3:0.07):0.03):0.03,",
  "((t4{G2}:0.06,t5{G2}:0.05){G2}:0.04,(t6:0.08,t7:0.07):0.03):0.03",
  ");",
].join("");
const fasta = syntheticFasta(codonSites);
const alignment = parseFasta(fasta);
const f3x4 = countF3x4(alignment);
const fittedModel: FittedModel = {
  geneticCodeId: 1,
  gtrRates: Float64Array.of(1, 1, 1, 1, 1, 1),
  f3x4,
  codonEquilibrium: codonEquilibriumFromF3x4(f3x4),
  globalAlpha: 1,
  globalBeta: 1,
  logLikelihood: Number.NaN,
  fitKind: "provided",
};

const residentBytes = (): number | undefined => {
  try {
    return process.memoryUsage().rss;
  } catch {
    return undefined;
  }
};
const rssBefore = residentBytes();
const started = performance.now();
const result = await analyzeDifFUBAR(fasta, tree, {
  backend: backend as "wasm" | "wasm-parallel",
  fittedModel,
  foregroundGrid,
  backgroundGrid,
  iterations,
  likelihoodCutoff: 1e-12,
  seed: 0x5eed1234,
});
const wallMs = performance.now() - started;
const rssAfter = residentBytes();

process.stdout.write(`${JSON.stringify({
  mode: full ? "full" : "quick",
  ...result.diagnostics,
  iterations,
  timingsMs: result.timings,
  wallMs,
  ...(rssBefore === undefined || rssAfter === undefined ? {} : { rssDeltaMiB: (rssAfter - rssBefore) / 2 ** 20 }),
  detectedSites: result.detectedSites.length,
}, null, 2)}\n`);

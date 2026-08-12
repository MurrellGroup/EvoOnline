import { parseFsartFasta, scanTripletShard } from "../src/index.js";

let seed = 0x12345678;
const random = (): number => {
  seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
  return seed;
};

const taxa = Number(process.env.FSART_TAXA ?? 60);
const sites = Number(process.env.FSART_SITES ?? 1500);
const alphabet = "ACGT";
const fasta = Array.from({ length: taxa }, (_, taxon) => {
  const sequence = Array.from({ length: sites }, () => alphabet[(random() >>> 16) & 3]).join("");
  return `>t${taxon}\n${sequence}`;
}).join("\n");

const parseStarted = performance.now();
const alignment = parseFsartFasta(fasta);
const parseMs = performance.now() - parseStarted;
const scanStarted = performance.now();
const result = scanTripletShard(alignment, { window: 24, maximumSignals: 512 });
const scanMs = performance.now() - scanStarted;

console.log(JSON.stringify({
  taxa,
  sites,
  triplets: result.scannedTriplets,
  testedBoundaries: result.testedBoundaries,
  retainedSignals: result.signals.length,
  pairEqualityCache: alignment.pairEqualMasks !== undefined,
  parseMs: Number(parseMs.toFixed(1)),
  scanMs: Number(scanMs.toFixed(1)),
  millionSiteTripletsPerSecond: Number((result.scannedTriplets * sites / scanMs / 1000).toFixed(2)),
  millionBoundariesPerSecond: Number((result.testedBoundaries / scanMs / 1000).toFixed(2)),
}, null, 2));

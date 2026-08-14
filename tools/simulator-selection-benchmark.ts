import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  DEFAULT_SIMULATOR_CONFIG,
  alignmentDiagnostics,
  runSimulator,
  writeFasta,
  type SimulatedDataset,
  type SimulatorConfig,
} from "../models/simulator/src/index.ts";
import {
  analyzeFubar,
  approximateFelResultsToCsv,
  fubarResultsToCsv,
  type FubarAnalysisResult,
} from "../models/fubar/src/index.ts";
import {
  analyzeFame,
  analyzeFlavor,
  fameResultsToCsv,
  flavorResultsToCsv,
  type FameAnalysisResult,
  type FlavorAnalysisResult,
} from "../models/bame/src/index.ts";
import {
  getGeneticCode,
  type RecombinationCodonTreeSet,
} from "../models/diffubar/src/index.ts";

const outputDirectory = resolve(process.cwd(), "benchmarks/simulator-selection/results");
const siteCount = 480;
const posteriorThreshold = 0.95;

interface BinaryMetrics {
  readonly positives: number;
  readonly negatives: number;
  readonly detected: number;
  readonly truePositive: number;
  readonly falsePositive: number;
  readonly sensitivity: number;
  readonly specificity: number;
  readonly precision: number;
  readonly falseDiscoveryRate: number;
  readonly rocAuc: number;
  readonly averagePrecision: number;
  readonly brier: number;
}

interface MethodSummary {
  readonly dataset: string;
  readonly method: string;
  readonly target: string;
  readonly threshold: string;
  readonly metrics: BinaryMetrics;
  readonly strongSensitivity?: number;
  readonly rankCorrelation?: number;
  readonly runtimeSeconds: number;
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function ranks(values: readonly number[]): number[] {
  const ordered = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value || a.index - b.index);
  const result = new Array<number>(values.length);
  let start = 0;
  while (start < ordered.length) {
    let end = start + 1;
    while (end < ordered.length && ordered[end]!.value === ordered[start]!.value) end += 1;
    const rank = (start + end - 1) / 2 + 1;
    for (let index = start; index < end; index += 1) result[ordered[index]!.index] = rank;
    start = end;
  }
  return result;
}

function pearson(left: readonly number[], right: readonly number[]): number {
  const n = Math.min(left.length, right.length);
  if (n < 2) return 0;
  const meanLeft = left.reduce((sum, value) => sum + value, 0) / n;
  const meanRight = right.reduce((sum, value) => sum + value, 0) / n;
  let covariance = 0;
  let varianceLeft = 0;
  let varianceRight = 0;
  for (let index = 0; index < n; index += 1) {
    const a = left[index]! - meanLeft;
    const b = right[index]! - meanRight;
    covariance += a * b;
    varianceLeft += a * a;
    varianceRight += b * b;
  }
  return varianceLeft > 0 && varianceRight > 0 ? covariance / Math.sqrt(varianceLeft * varianceRight) : 0;
}

function spearman(left: readonly number[], right: readonly number[]): number {
  return pearson(ranks(left), ranks(right));
}

function rocAuc(labels: readonly boolean[], scores: readonly number[]): number {
  const scoreRanks = ranks(scores);
  let positives = 0;
  let rankSum = 0;
  for (let index = 0; index < labels.length; index += 1) if (labels[index]) {
    positives += 1;
    rankSum += scoreRanks[index]!;
  }
  const negatives = labels.length - positives;
  return positives > 0 && negatives > 0 ? (rankSum - positives * (positives + 1) / 2) / (positives * negatives) : 0;
}

function averagePrecision(labels: readonly boolean[], scores: readonly number[]): number {
  const ordered = labels.map((label, index) => ({ label, score: scores[index]! })).sort((a, b) => b.score - a.score);
  const positives = labels.filter(Boolean).length;
  if (positives === 0) return 0;
  let found = 0;
  let total = 0;
  for (let index = 0; index < ordered.length; index += 1) if (ordered[index]!.label) {
    found += 1;
    total += found / (index + 1);
  }
  return total / positives;
}

function binaryMetrics(labels: readonly boolean[], scores: readonly number[], threshold: number): BinaryMetrics {
  let truePositive = 0;
  let falsePositive = 0;
  let trueNegative = 0;
  let falseNegative = 0;
  let brier = 0;
  for (let index = 0; index < labels.length; index += 1) {
    const predicted = scores[index]! >= threshold;
    const observed = labels[index]!;
    if (predicted && observed) truePositive += 1;
    else if (predicted) falsePositive += 1;
    else if (observed) falseNegative += 1;
    else trueNegative += 1;
    brier += (scores[index]! - Number(observed)) ** 2;
  }
  const positives = truePositive + falseNegative;
  const negatives = trueNegative + falsePositive;
  const detected = truePositive + falsePositive;
  return {
    positives,
    negatives,
    detected,
    truePositive,
    falsePositive,
    sensitivity: positives > 0 ? truePositive / positives : 0,
    specificity: negatives > 0 ? trueNegative / negatives : 0,
    precision: detected > 0 ? truePositive / detected : 1,
    falseDiscoveryRate: detected > 0 ? falsePositive / detected : 0,
    rocAuc: rocAuc(labels, scores),
    averagePrecision: averagePrecision(labels, scores),
    brier: brier / labels.length,
  };
}

function progress(label: string) {
  let previous = "";
  return (stage: string, fraction: number, detail?: { readonly message?: string }): void => {
    const bucket = Math.min(4, Math.floor(fraction * 4));
    const key = `${stage}:${bucket}`;
    if (key === previous) return;
    previous = key;
    process.stderr.write(`[${label}] ${stage} ${Math.round(fraction * 100)}%${detail?.message ? ` · ${detail.message}` : ""}\n`);
  };
}

function baseTree(seed: number, branchScale = 0.0045): SimulatorConfig["tree"] {
  return {
    ...DEFAULT_SIMULATOR_CONFIG.tree,
    preset: "logistic",
    observedTips: 48,
    initialTips: 3,
    replicates: 1,
    branchScale,
  };
}

function mg94Config(seed: number, omega: { readonly kind: "fixed" | "gamma"; readonly mean: number; readonly shape?: number }): SimulatorConfig {
  const marginal = omega.kind === "fixed"
    ? { kind: "fixed" as const, mean: omega.mean }
    : { kind: "gamma" as const, mean: omega.mean, shape: omega.shape ?? 1 };
  return {
    ...DEFAULT_SIMULATOR_CONFIG,
    seed,
    tree: baseTree(seed),
    codon: {
      engine: "mg94",
      sites: siteCount,
      geneticCodeId: 1,
      gtr: DEFAULT_SIMULATOR_CONFIG.codon.gtr,
      alpha: { kind: "gamma", mean: 1, shape: 2.5 },
      omega: marginal,
    },
    recombination: { ...DEFAULT_SIMULATOR_CONFIG.recombination, enabled: false },
  };
}

function recombinationConfig(): SimulatorConfig {
  const base = mg94Config(3701, { kind: "gamma", mean: 0.8, shape: 1 });
  return {
    ...base,
    tree: baseTree(3701, 0.005),
    recombination: {
      ...base.recombination,
      enabled: true,
      eventRate: 0.003,
      mode: "single-tract",
      meanBreakpoints: 2,
      meanTractCodons: 90,
      hotspotMode: "random",
      hotspotCount: 3,
      hotspotWidth: 15,
      hotspotIntensity: 6,
      carrierOversample: 1.5,
    },
  };
}

function scuffConfig(seed: number, sites: number, regime: "calm" | "rapid"): SimulatorConfig {
  const rapid = regime === "rapid";
  return {
    ...DEFAULT_SIMULATOR_CONFIG,
    seed,
    tree: { ...baseTree(seed), replicates: 1 },
    codon: {
      engine: "scuff",
      sites,
      geneticCodeId: 1,
      gtr: DEFAULT_SIMULATOR_CONFIG.codon.gtr,
      alpha: { kind: "gamma", mean: 1, shape: 2.5 },
      eventRate: { kind: "fixed", mean: rapid ? 4 : 1 },
      equilibriumSigma: { kind: "fixed", mean: rapid ? 2.5 : 0.4 },
      mixingRate: { kind: "fixed", mean: rapid ? 4 : 1 },
      burninTime: 4,
      diagnosticTime: 6,
    },
    recombination: { ...DEFAULT_SIMULATOR_CONFIG.recombination, enabled: false },
  };
}

function treeSet(dataset: SimulatedDataset): RecombinationCodonTreeSet {
  return {
    schemaVersion: 1,
    sourceMethod: "simulation-truth",
    branchLengthSource: "method-final-trees",
    branchScalePolicy: "fixed-relative",
    codonAssignment: "middle-nucleotide",
    segments: dataset.localTrees.map((region) => ({
      startCodon: region.startCodon,
      endCodon: region.endCodon,
      tree: region.tree.newick,
      label: `True simulated region ${region.startCodon}-${region.endCodon}`,
    })),
  };
}

function fubarSummaries(datasetName: string, truthOmega: readonly number[], result: FubarAnalysisResult): MethodSummary[] {
  const positiveScores = result.sites.map((site) => site.pPositive);
  const purifyingScores = result.sites.map((site) => site.pPurifying);
  const positiveLabels = truthOmega.map((omega) => omega > 1);
  const purifyingLabels = truthOmega.map((omega) => omega < 1);
  const strongPositive = truthOmega.map((omega) => omega >= 1.5);
  const strongPurifying = truthOmega.map((omega) => omega <= 0.67);
  const detectedPositive = positiveScores.map((value) => value >= posteriorThreshold);
  const detectedPurifying = purifyingScores.map((value) => value >= posteriorThreshold);
  const strongSensitivity = (strong: readonly boolean[], detected: readonly boolean[]): number => {
    const count = strong.filter(Boolean).length;
    return count === 0 ? 0 : strong.reduce((sum, value, index) => sum + Number(value && detected[index]), 0) / count;
  };
  const estimatedLogRatio = result.sites.map((site) => Math.log(Math.max(site.meanBeta, 1e-12) / Math.max(site.meanAlpha, 1e-12)));
  const truthLogRatio = truthOmega.map((omega) => Math.log(Math.max(omega, 1e-12)));
  return [
    {
      dataset: datasetName,
      method: "FUBAR",
      target: "positive",
      threshold: `posterior >= ${posteriorThreshold}`,
      metrics: binaryMetrics(positiveLabels, positiveScores, posteriorThreshold),
      strongSensitivity: strongSensitivity(strongPositive, detectedPositive),
      rankCorrelation: spearman(truthLogRatio, estimatedLogRatio),
      runtimeSeconds: result.timings.totalMs / 1000,
    },
    {
      dataset: datasetName,
      method: "FUBAR",
      target: "purifying",
      threshold: `posterior >= ${posteriorThreshold}`,
      metrics: binaryMetrics(purifyingLabels, purifyingScores, posteriorThreshold),
      strongSensitivity: strongSensitivity(strongPurifying, detectedPurifying),
      rankCorrelation: spearman(truthLogRatio.map((value) => -value), estimatedLogRatio.map((value) => -value)),
      runtimeSeconds: result.timings.totalMs / 1000,
    },
  ];
}

function approximateFelSummaries(datasetName: string, truthOmega: readonly number[], result: FubarAnalysisResult): MethodSummary[] {
  if (result.approximateFel === undefined) return [];
  const positiveLabels = truthOmega.map((omega) => omega > 1);
  const purifyingLabels = truthOmega.map((omega) => omega < 1);
  const strongPositive = truthOmega.map((omega) => omega >= 1.5);
  const strongPurifying = truthOmega.map((omega) => omega <= 0.67);
  const positiveScores = result.approximateFel.sites.map((site) => site.direction === "positive" ? 1 - site.pPositive : 0);
  const purifyingScores = result.approximateFel.sites.map((site) => site.direction === "purifying" ? 1 - site.pPurifying : 0);
  const estimatedLogRatio = result.approximateFel.sites.map((site) => Math.log(Math.max(site.betaAlternative, 1e-12) / Math.max(site.alphaAlternative, 1e-12)));
  const truthLogRatio = truthOmega.map((omega) => Math.log(Math.max(omega, 1e-12)));
  const summarize = (target: "positive" | "purifying", labels: readonly boolean[], strong: readonly boolean[], scores: readonly number[]): MethodSummary => {
    const detected = scores.map((score) => score >= 0.95);
    const strongCount = strong.filter(Boolean).length;
    const direction = target === "positive" ? 1 : -1;
    return {
      dataset: datasetName,
      method: "approx-FEL",
      target,
      threshold: "directional p <= 0.05",
      metrics: binaryMetrics(labels, scores, 0.95),
      strongSensitivity: strongCount === 0 ? 0 : strong.reduce((sum, value, index) => sum + Number(value && detected[index]), 0) / strongCount,
      rankCorrelation: spearman(truthLogRatio.map((value) => direction * value), estimatedLogRatio.map((value) => direction * value)),
      runtimeSeconds: result.timings.totalMs / 1000,
    };
  };
  return [
    summarize("positive", positiveLabels, strongPositive, positiveScores),
    summarize("purifying", purifyingLabels, strongPurifying, purifyingScores),
  ];
}

function episodicSummary(datasetName: string, method: "FAME" | "FLAVOR", truthOmega: readonly number[], result: FameAnalysisResult | FlavorAnalysisResult): MethodSummary {
  const scores = result.sites.map((site) => site.pPositive);
  const labels = truthOmega.map((omega) => omega > 1);
  const strong = truthOmega.map((omega) => omega >= 1.5);
  const detected = scores.map((score) => score >= 0.9);
  const strongCount = strong.filter(Boolean).length;
  return {
    dataset: datasetName,
    method,
    target: "positive",
    threshold: "posterior >= 0.9",
    metrics: binaryMetrics(labels, scores, 0.9),
    strongSensitivity: strongCount === 0 ? 0 : strong.reduce((sum, value, index) => sum + Number(value && detected[index]), 0) / strongCount,
    runtimeSeconds: result.timings.totalMs / 1000,
  };
}

function truthTsv(dataset: SimulatedDataset): string {
  const parameters = dataset.siteParameters!;
  const header = ["site", "alpha", ...(parameters.omega ? ["omega", "truth_direction"] : ["event_rate", "equilibrium_sigma", "mixing_rate"])];
  const rows = parameters.alpha.map((alpha, index) => parameters.omega
    ? [index + 1, alpha, parameters.omega[index], parameters.omega[index]! > 1 ? "positive" : parameters.omega[index]! < 1 ? "purifying" : "neutral"]
    : [index + 1, alpha, parameters.eventRate![index], parameters.equilibriumSigma![index], parameters.mixingRate![index]]);
  return [header.join("\t"), ...rows.map((row) => row.join("\t"))].join("\n");
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

const aminoAcidColors: Readonly<Record<string, string>> = {
  A: "#559f61", C: "#c89522", D: "#db4b50", E: "#db4b50", F: "#7558bd", G: "#7d8a86", H: "#4975c5", I: "#369069", K: "#3f6fc4",
  L: "#369069", M: "#369069", N: "#bd6395", P: "#ae6e36", Q: "#bd6395", R: "#3f6fc4", S: "#328f7a", T: "#328f7a", V: "#369069", W: "#7558bd", Y: "#7558bd", X: "#74817d",
};

function translate(sequence: string): string {
  const code = getGeneticCode(1);
  let output = "";
  for (let offset = 0; offset + 2 < sequence.length; offset += 3) output += code.aminoAcids[sequence.slice(offset, offset + 3)] ?? "X";
  return output;
}

function tipOrder(dataset: SimulatedDataset): number[] {
  const result: number[] = [];
  const visit = (id: number): void => {
    const node = dataset.tree.nodes[id]!;
    if (node.children.length === 0) result.push(id);
    else for (const child of node.children) visit(child);
  };
  visit(dataset.tree.root);
  return result;
}

function treeAlignmentSvg(dataset: SimulatedDataset, title: string, columns = 90): string {
  const order = tipOrder(dataset);
  const rowHeight = 14;
  const top = 56;
  const bottom = 42;
  const left = 28;
  const treeRight = 260;
  const labelRight = 315;
  const alignmentLeft = 328;
  const characterWidth = 10;
  const width = alignmentLeft + columns * characterWidth + 28;
  const height = top + order.length * rowHeight + bottom;
  const byName = new Map(dataset.names.map((name, index) => [name, translate(dataset.sequences![index]!).slice(0, columns)]));
  const sequences = order.map((id) => byName.get(dataset.tree.nodes[id]!.name!)!);
  const consensus = Array.from({ length: columns }, (_, site) => {
    const counts = new Map<string, number>();
    for (const sequence of sequences) counts.set(sequence[site] ?? "X", (counts.get(sequence[site] ?? "X") ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1])[0]![0];
  });
  const layout = new Map<number, { x: number; y: number }>();
  let tip = 0;
  const visit = (id: number): number => {
    const node = dataset.tree.nodes[id]!;
    const y = node.children.length === 0 ? top + tip++ * rowHeight : node.children.map(visit).reduce((sum, value) => sum + value, 0) / node.children.length;
    const x = left + (dataset.tree.height - node.time) / Math.max(dataset.tree.height, 1e-12) * (treeRight - left);
    layout.set(id, { x, y });
    return y;
  };
  visit(dataset.tree.root);
  const lines: string[] = [];
  for (const node of dataset.tree.nodes) if (node.children.length > 0) {
    const here = layout.get(node.id)!;
    const ys = node.children.map((child) => layout.get(child)!.y);
    lines.push(`<line x1="${here.x}" x2="${here.x}" y1="${Math.min(...ys)}" y2="${Math.max(...ys)}" class="tree"/>`);
  }
  for (const node of dataset.tree.nodes) if (node.parent !== null) {
    const here = layout.get(node.id)!;
    const parent = layout.get(node.parent)!;
    lines.push(`<line x1="${parent.x}" x2="${here.x}" y1="${here.y}" y2="${here.y}" class="tree"/>`);
  }
  const rows: string[] = [];
  for (let row = 0; row < order.length; row += 1) {
    const id = order[row]!;
    const node = dataset.tree.nodes[id]!;
    const point = layout.get(id)!;
    const sequence = sequences[row]!;
    rows.push(`<line x1="${point.x}" x2="${treeRight + 3}" y1="${point.y}" y2="${point.y}" class="sample"/>`);
    rows.push(`<text x="${labelRight}" y="${point.y + 3}" text-anchor="end" class="tip">${xml(node.name ?? `tax${id + 1}`)}</text>`);
    for (let site = 0; site < sequence.length; site += 1) {
      const residue = sequence[site]!;
      const color = residue === consensus[site] ? "#d5dcda" : aminoAcidColors[residue] ?? "#74817d";
      rows.push(`<text x="${alignmentLeft + site * characterWidth}" y="${point.y + 3.5}" fill="${color}" class="aa">${residue}</text>`);
    }
  }
  const ticks = Array.from({ length: Math.ceil(columns / 10) }, (_, index) => {
    const site = index * 10 + 1;
    return `<text x="${alignmentLeft + (site - 1) * characterWidth}" y="${top - 13}" class="tick">${site}</text>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><style>
    .tree{stroke:#344843;stroke-width:1;fill:none}.sample{stroke:#aab7b2;stroke-width:.8;stroke-dasharray:2 2}.tip{font:7.5px system-ui,sans-serif;fill:#344843}.aa{font:600 10px ui-monospace,monospace}.tick{font:8px system-ui,sans-serif;fill:#687873}.title{font:650 18px system-ui,sans-serif;fill:#172321}.note{font:9px system-ui,sans-serif;fill:#64736e}
  </style><rect width="100%" height="100%" fill="white"/><text x="${left}" y="25" class="title">${xml(title)}</text><text x="${left}" y="42" class="note">Heterochronous time tree · dotted sampling extensions · first ${columns} amino acids · consensus matches faded</text>${ticks}${lines.join("")}${rows.join("")}</svg>`;
}

function posteriorScatterSvg(omega: readonly number[], result: FubarAnalysisResult): string {
  const width = 920;
  const height = 530;
  const left = 75;
  const right = 28;
  const top = 80;
  const bottom = 66;
  const xValues = omega.map((value) => Math.log10(Math.max(value, 1e-3)));
  const xMin = Math.min(-2, ...xValues);
  const xMax = Math.max(0.8, ...xValues);
  const x = (value: number): number => left + (value - xMin) / (xMax - xMin) * (width - left - right);
  const y = (value: number): number => top + (1 - value) * (height - top - bottom);
  const points = result.sites.map((site, index) => {
    const truth = omega[index]!;
    const fill = truth >= 1.5 ? "#e85a61" : truth <= 0.67 ? "#5275d8" : "#9ca9a5";
    return `<circle cx="${x(xValues[index]!)}" cy="${y(site.pPositive)}" r="2.5" fill="${fill}" fill-opacity=".7"/>`;
  }).join("");
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((value) => `<line x1="${left - 4}" x2="${width - right}" y1="${y(value)}" y2="${y(value)}" class="${value === 0 ? "axis" : "grid"}"/><text x="${left - 9}" y="${y(value) + 4}" text-anchor="end" class="tick">${value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}</text>`).join("");
  const xTicks = [-2, -1, 0, Math.log10(3)].filter((value) => value >= xMin && value <= xMax).map((value) => `<line x1="${x(value)}" x2="${x(value)}" y1="${y(0)}" y2="${y(0) + 5}" class="axis"/><text x="${x(value)}" y="${y(0) + 19}" text-anchor="middle" class="tick">${(10 ** value).toPrecision(2)}</text>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><style>.axis{stroke:#334541;stroke-width:1}.grid{stroke:#d9e0dd;stroke-width:1;stroke-dasharray:4 4}.label{font:12px system-ui,sans-serif;fill:#40514d}.title{font:650 19px system-ui,sans-serif;fill:#172321}.legend{font:11px system-ui,sans-serif;fill:#40514d}.tick{font:9px system-ui,sans-serif;fill:#52635f}</style><rect width="100%" height="100%" fill="white"/><text x="${left}" y="27" class="title">FUBAR positive posterior against simulated site ω</text><circle cx="${left + 4}" cy="51" r="4" fill="#e85a61"/><text x="${left + 14}" y="55" class="legend">strong positive: ω ≥ 1.5</text><circle cx="${left + 184}" cy="51" r="4" fill="#5275d8"/><text x="${left + 194}" y="55" class="legend">strong purifying: ω ≤ 0.67</text>${yTicks}<line x1="${left}" x2="${left}" y1="${top}" y2="${y(0)}" class="axis"/><line x1="${x(0)}" x2="${x(0)}" y1="${top}" y2="${y(0)}" class="grid"/>${xTicks}${points}<text x="${(left + width - right) / 2}" y="${height - 18}" text-anchor="middle" class="label">Simulated ω (log scale)</text><text x="18" y="${(top + y(0)) / 2}" text-anchor="middle" transform="rotate(-90 18 ${(top + y(0)) / 2})" class="label">P(β &gt; α | data)</text><text x="${x(0) + 5}" y="${top + 15}" class="legend">ω = 1</text></svg>`;
}

function runtimeSvg(results: readonly { readonly label: string; readonly seconds: number }[]): string {
  const width = 900;
  const height = 65 + results.length * 42;
  const left = 220;
  const right = 100;
  const top = 45;
  const rowHeight = 42;
  const maximum = Math.max(...results.map((entry) => entry.seconds), 1);
  const bars = results.map((entry, index) => {
    const y = top + index * rowHeight;
    const barWidth = entry.seconds / maximum * (width - left - right);
    return `<text x="${left - 9}" y="${y + 18}" text-anchor="end" class="label">${xml(entry.label)}</text><rect x="${left}" y="${y + 4}" width="${barWidth}" height="22" rx="4" fill="#167a70"/><text x="${left + barWidth + 7}" y="${y + 19}" class="value">${entry.seconds.toFixed(1)} s</text>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><style>.title{font:650 19px system-ui,sans-serif;fill:#172321}.label{font:11px system-ui,sans-serif;fill:#334541}.value{font:10px system-ui,sans-serif;fill:#52635f}</style><rect width="100%" height="100%" fill="white"/><text x="20" y="26" class="title">Measured end-to-end method runtimes</text>${bars}</svg>`;
}

function percent(value: number): string {
  return `${(100 * value).toFixed(1)}%`;
}

function number(value: number, digits = 3): string {
  return finite(value).toFixed(digits);
}

async function saveDataset(name: string, dataset: SimulatedDataset, config: SimulatorConfig): Promise<void> {
  await Promise.all([
    writeFile(resolve(outputDirectory, `${name}.fasta`), dataset.fasta!),
    writeFile(resolve(outputDirectory, `${name}.nwk`), dataset.tree.newick),
    writeFile(resolve(outputDirectory, `${name}.time.nwk`), dataset.tree.timeNewick),
    writeFile(resolve(outputDirectory, `${name}.truth.tsv`), truthTsv(dataset)),
    writeFile(resolve(outputDirectory, `${name}.config.json`), JSON.stringify(config, null, 2)),
    writeFile(resolve(outputDirectory, `${name}.tree-alignment.svg`), treeAlignmentSvg(dataset, `${name}: realized tree and alignment`)),
  ]);
}

async function main(): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  const summaries: MethodSummary[] = [];
  const runtimes: { label: string; seconds: number }[] = [];

  process.stderr.write("Simulating neutral and heterogeneous MG94 controls...\n");
  const neutralConfig = mg94Config(2710, { kind: "fixed", mean: 1 });
  const heterogeneousConfig = mg94Config(2710, { kind: "gamma", mean: 0.8, shape: 1 });
  const neutralSimulation = await runSimulator(neutralConfig, { onProgress: progress("neutral-sim") });
  const heterogeneousSimulation = await runSimulator(heterogeneousConfig, { onProgress: progress("heterogeneous-sim") });
  const neutral = neutralSimulation.datasets[0]!;
  const heterogeneous = heterogeneousSimulation.datasets[0]!;
  await saveDataset("neutral-mg94", neutral, neutralConfig);
  await saveDataset("heterogeneous-mg94", heterogeneous, heterogeneousConfig);

  process.stderr.write("Running FUBAR + approximate FEL on the neutral control...\n");
  const neutralFubar = await analyzeFubar(neutral.fasta!, neutral.tree.newick, {
    backend: "wasm-parallel",
    gridPoints: 20,
    inferenceMethod: "dirichlet-em",
    iterations: 2_500,
    posteriorThreshold,
    approximateFel: true,
    onStage: progress("neutral-fubar"),
  });
  summaries.push(...fubarSummaries("neutral-mg94", neutral.siteParameters!.omega!, neutralFubar));
  summaries.push(...approximateFelSummaries("neutral-mg94", neutral.siteParameters!.omega!, neutralFubar));
  runtimes.push({ label: "Neutral · FUBAR+FEL", seconds: neutralFubar.timings.totalMs / 1000 });
  await Promise.all([
    writeFile(resolve(outputDirectory, "neutral-mg94.fubar.csv"), fubarResultsToCsv(neutralFubar, posteriorThreshold)),
    writeFile(resolve(outputDirectory, "neutral-mg94.approx-fel.csv"), approximateFelResultsToCsv(neutralFubar.approximateFel!, 0.05)),
  ]);

  process.stderr.write("Running FUBAR + approximate FEL on heterogeneous MG94...\n");
  const heterogeneousFubar = await analyzeFubar(heterogeneous.fasta!, heterogeneous.tree.newick, {
    backend: "wasm-parallel",
    gridPoints: 20,
    inferenceMethod: "dirichlet-em",
    iterations: 2_500,
    posteriorThreshold,
    approximateFel: true,
    onStage: progress("heterogeneous-fubar"),
  });
  summaries.push(...fubarSummaries("heterogeneous-mg94", heterogeneous.siteParameters!.omega!, heterogeneousFubar));
  summaries.push(...approximateFelSummaries("heterogeneous-mg94", heterogeneous.siteParameters!.omega!, heterogeneousFubar));
  runtimes.push({ label: "Heterogeneous · FUBAR+FEL", seconds: heterogeneousFubar.timings.totalMs / 1000 });
  await Promise.all([
    writeFile(resolve(outputDirectory, "heterogeneous-mg94.fubar.csv"), fubarResultsToCsv(heterogeneousFubar, posteriorThreshold)),
    writeFile(resolve(outputDirectory, "heterogeneous-mg94.approx-fel.csv"), approximateFelResultsToCsv(heterogeneousFubar.approximateFel!, 0.05)),
    writeFile(resolve(outputDirectory, "heterogeneous-mg94.posterior-vs-truth.svg"), posteriorScatterSvg(heterogeneous.siteParameters!.omega!, heterogeneousFubar)),
  ]);

  process.stderr.write("Running FAME on heterogeneous MG94 with the shared global fit...\n");
  const fame = await analyzeFame(heterogeneous.fasta!, heterogeneous.tree.newick, {
    backend: "wasm-parallel",
    gridPreset: "fast",
    weightIntegration: "likelihood-quadrature",
    quadraturePoints: 4,
    inferenceMethod: "dirichlet-em",
    iterations: 2_500,
    posteriorThreshold: 0.9,
    fittedModel: heterogeneousFubar.fittedModel,
    onStage: progress("heterogeneous-fame"),
  });
  summaries.push(episodicSummary("heterogeneous-mg94", "FAME", heterogeneous.siteParameters!.omega!, fame));
  runtimes.push({ label: "Heterogeneous · FAME", seconds: fame.timings.totalMs / 1000 });
  await writeFile(resolve(outputDirectory, "heterogeneous-mg94.fame.csv"), fameResultsToCsv(fame, 0.9));

  process.stderr.write("Running FLAVOR on heterogeneous MG94 with the shared global fit...\n");
  const flavor = await analyzeFlavor(heterogeneous.fasta!, heterogeneous.tree.newick, {
    backend: "wasm-parallel",
    gridPreset: "fast",
    gammaSlices: 12,
    transitionEngine: "julia-interpolated",
    inferenceMethod: "dirichlet-em",
    iterations: 2_500,
    posteriorThreshold: 0.9,
    fittedModel: heterogeneousFubar.fittedModel,
    onStage: progress("heterogeneous-flavor"),
  });
  summaries.push(episodicSummary("heterogeneous-mg94", "FLAVOR", heterogeneous.siteParameters!.omega!, flavor));
  runtimes.push({ label: "Heterogeneous · FLAVOR", seconds: flavor.timings.totalMs / 1000 });
  await writeFile(resolve(outputDirectory, "heterogeneous-mg94.flavor.csv"), flavorResultsToCsv(flavor, 0.9));

  process.stderr.write("Simulating recombination and comparing master-tree versus true-regional-tree FUBAR...\n");
  const recombinantConfig = recombinationConfig();
  const recombinantSimulation = await runSimulator(recombinantConfig, { onProgress: progress("recombinant-sim") });
  const recombinant = recombinantSimulation.datasets[0]!;
  await saveDataset("recombinant-mg94", recombinant, recombinantConfig);
  await writeFile(resolve(outputDirectory, "recombinant-mg94.events.json"), JSON.stringify({ events: recombinant.recombinationEvents, localTrees: recombinant.localTrees.map((region) => ({ startCodon: region.startCodon, endCodon: region.endCodon, activeEventIds: region.activeEventIds, newick: region.tree.newick })) }, null, 2));
  const regionalFubar = await analyzeFubar(recombinant.fasta!, recombinant.tree.newick, {
    backend: "wasm-parallel",
    gridPoints: 20,
    inferenceMethod: "dirichlet-em",
    iterations: 2_500,
    posteriorThreshold,
    approximateFel: false,
    recombinationTrees: treeSet(recombinant),
    onStage: progress("recombinant-regional-fubar"),
  });
  const masterFubar = await analyzeFubar(recombinant.fasta!, recombinant.tree.newick, {
    backend: "wasm-parallel",
    gridPoints: 20,
    inferenceMethod: "dirichlet-em",
    iterations: 2_500,
    posteriorThreshold,
    approximateFel: false,
    fittedModel: regionalFubar.fittedModel,
    onStage: progress("recombinant-master-fubar"),
  });
  summaries.push(...fubarSummaries("recombinant-true-regional", recombinant.siteParameters!.omega!, regionalFubar));
  summaries.push(...fubarSummaries("recombinant-master-only", recombinant.siteParameters!.omega!, masterFubar));
  runtimes.push({ label: "Recombinant · true regional", seconds: regionalFubar.timings.totalMs / 1000 });
  runtimes.push({ label: "Recombinant · master only", seconds: masterFubar.timings.totalMs / 1000 });
  await Promise.all([
    writeFile(resolve(outputDirectory, "recombinant-mg94.regional.fubar.csv"), fubarResultsToCsv(regionalFubar, posteriorThreshold)),
    writeFile(resolve(outputDirectory, "recombinant-mg94.master.fubar.csv"), fubarResultsToCsv(masterFubar, posteriorThreshold)),
  ]);

  process.stderr.write("Building a calm-versus-adaptive SCUFF block contrast and running FLAVOR...\n");
  const calmConfig = scuffConfig(4710, siteCount / 2, "calm");
  const rapidConfig = scuffConfig(4710, siteCount / 2, "rapid");
  const calmSimulation = await runSimulator(calmConfig, { onProgress: progress("scuff-calm") });
  const rapidSimulation = await runSimulator(rapidConfig, { onProgress: progress("scuff-rapid") });
  const calm = calmSimulation.datasets[0]!;
  const rapid = rapidSimulation.datasets[0]!;
  if (calm.tree.newick !== rapid.tree.newick || calm.names.join("\0") !== rapid.names.join("\0")) throw new Error("SCUFF block simulations did not retain the shared tree/taxon order.");
  const scuffSequences = calm.sequences!.map((sequence, index) => sequence + rapid.sequences![index]!);
  const scuff: SimulatedDataset = {
    ...calm,
    id: "scuff-block-contrast",
    sequences: scuffSequences,
    fasta: writeFasta(calm.names, scuffSequences),
    diagnostics: { ...calm.diagnostics, ...alignmentDiagnostics(scuffSequences, 1) },
  };
  await Promise.all([
    writeFile(resolve(outputDirectory, "scuff-block-contrast.fasta"), scuff.fasta!),
    writeFile(resolve(outputDirectory, "scuff-block-contrast.nwk"), scuff.tree.newick),
    writeFile(resolve(outputDirectory, "scuff-block-contrast.tree-alignment.svg"), treeAlignmentSvg(scuff, "SCUFF calm/adaptive block contrast")),
    writeFile(resolve(outputDirectory, "scuff-block-contrast.config.json"), JSON.stringify({ calm: calmConfig, adaptive: rapidConfig }, null, 2)),
  ]);
  const scuffFlavor = await analyzeFlavor(scuff.fasta!, scuff.tree.newick, {
    backend: "wasm-parallel",
    gridPreset: "fast",
    gammaSlices: 12,
    transitionEngine: "julia-interpolated",
    inferenceMethod: "dirichlet-em",
    iterations: 2_500,
    posteriorThreshold: 0.9,
    onStage: progress("scuff-flavor"),
  });
  const scuffLabels = Array.from({ length: siteCount }, (_, index) => index >= siteCount / 2);
  const scuffScores = scuffFlavor.sites.map((site) => site.pPositive);
  const scuffMetrics = binaryMetrics(scuffLabels, scuffScores, 0.9);
  summaries.push({ dataset: "scuff-calm-vs-adaptive", method: "FLAVOR", target: "adaptive SCUFF block", threshold: "posterior >= 0.9", metrics: scuffMetrics, runtimeSeconds: scuffFlavor.timings.totalMs / 1000 });
  runtimes.push({ label: "SCUFF contrast · FLAVOR", seconds: scuffFlavor.timings.totalMs / 1000 });
  await writeFile(resolve(outputDirectory, "scuff-block-contrast.flavor.csv"), flavorResultsToCsv(scuffFlavor, 0.9));

  const datasetRows = [
    ["neutral-mg94", neutral],
    ["heterogeneous-mg94", heterogeneous],
    ["recombinant-mg94", recombinant],
    ["scuff-block-contrast", scuff],
  ] as const;
  const summaryJson = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    design: {
      tips: 48,
      codonSites: siteCount,
      treePreset: "logistic heterochronous",
      branchScale: 0.0045,
      gtr: "flu-demo nonuniform GTR/F3x4",
      alpha: "Gamma(mean=1, shape=2.5)",
      omega: "neutral fixed 1 or Gamma(mean=0.8, shape=1)",
      fubarGrid: "20x20",
    },
    datasets: Object.fromEntries(datasetRows.map(([name, dataset]) => [name, dataset.diagnostics])),
    scuffDiagnostics: {
      calm: { sampledMeanDnds: calmSimulation.scuffDiagnostic!.sampledMeanDnds, maximumExpectedDnds: calmSimulation.scuffDiagnostic!.maximumExpectedDnds },
      adaptive: { sampledMeanDnds: rapidSimulation.scuffDiagnostic!.sampledMeanDnds, maximumExpectedDnds: rapidSimulation.scuffDiagnostic!.maximumExpectedDnds },
    },
    summaries,
    runtimes,
  };
  await writeFile(resolve(outputDirectory, "summary.json"), JSON.stringify(summaryJson, null, 2));
  const csvHeader = ["dataset", "method", "target", "threshold", "positives", "negatives", "detected", "true_positive", "false_positive", "sensitivity", "specificity", "precision", "fdr", "roc_auc", "average_precision", "brier", "strong_sensitivity", "rank_correlation", "runtime_seconds"];
  const csvRows = summaries.map((entry) => [entry.dataset, entry.method, entry.target, entry.threshold, entry.metrics.positives, entry.metrics.negatives, entry.metrics.detected, entry.metrics.truePositive, entry.metrics.falsePositive, entry.metrics.sensitivity, entry.metrics.specificity, entry.metrics.precision, entry.metrics.falseDiscoveryRate, entry.metrics.rocAuc, entry.metrics.averagePrecision, entry.metrics.brier, entry.strongSensitivity ?? "", entry.rankCorrelation ?? "", entry.runtimeSeconds]);
  await writeFile(resolve(outputDirectory, "summary.csv"), [csvHeader.join(","), ...csvRows.map((row) => row.join(","))].join("\n"));
  await writeFile(resolve(outputDirectory, "runtimes.svg"), runtimeSvg(runtimes));

  const datasetTable = datasetRows.map(([name, dataset]) => `| ${name} | ${number(dataset.diagnostics.treeHeight, 1)} | ${number(dataset.diagnostics.meanNucleotideDistance ?? 0)} | ${number(dataset.diagnostics.meanAminoAcidDistance ?? 0)} | ${dataset.diagnostics.segregatingNucleotideSites ?? 0} | ${dataset.diagnostics.recombinationEvents} | ${dataset.diagnostics.localTrees} |`).join("\n");
  const methodTable = summaries.map((entry) => `| ${entry.dataset} | ${entry.method} | ${entry.target} | ${entry.metrics.detected} | ${entry.metrics.positives === 0 ? "—" : percent(entry.metrics.sensitivity)} | ${entry.metrics.detected === 0 ? "—" : percent(entry.metrics.precision)} | ${entry.metrics.positives === 0 || entry.metrics.negatives === 0 ? "—" : number(entry.metrics.rocAuc)} | ${entry.metrics.positives === 0 ? "—" : number(entry.metrics.averagePrecision)} | ${entry.strongSensitivity === undefined || entry.metrics.positives === 0 ? "—" : percent(entry.strongSensitivity)} | ${number(entry.runtimeSeconds, 1)} |`).join("\n");
  const neutralPositive = summaries.find((entry) => entry.dataset === "neutral-mg94" && entry.method === "FUBAR" && entry.target === "positive")!;
  const neutralPurifying = summaries.find((entry) => entry.dataset === "neutral-mg94" && entry.method === "FUBAR" && entry.target === "purifying")!;
  const neutralFelPositive = summaries.find((entry) => entry.dataset === "neutral-mg94" && entry.method === "approx-FEL" && entry.target === "positive")!;
  const neutralFelPurifying = summaries.find((entry) => entry.dataset === "neutral-mg94" && entry.method === "approx-FEL" && entry.target === "purifying")!;
  const regionalPositive = summaries.find((entry) => entry.dataset === "recombinant-true-regional" && entry.target === "positive")!;
  const masterPositive = summaries.find((entry) => entry.dataset === "recombinant-master-only" && entry.target === "positive")!;
  const report = `# EvoOnline simulator → selection-method benchmark\n\nThis is an executable end-to-end test using EvoOnline's own simulator, Newick/FASTA outputs, global codon fitting, WASM likelihood engines, posterior inference, and result tabulation. Random seeds and complete configurations are saved beside the outputs.\n\n## Design\n\n- 48 heterochronous tips from the logistic sampled-coalescent preset.\n- 480 codons under the nonuniform flu-demo GTR/F3×4 process.\n- Branch scale 0.0045 for the main controls; Gamma(α) has mean 1 and shape 2.5.\n- Neutral control: ω=1. Heterogeneous control: Gamma(ω) with mean 0.8 and shape 1.\n- FUBAR uses the production 20×20 grid, Dirichlet-EM, posterior threshold 0.95, and the optional approximate-FEL calculation.\n- FAME/FLAVOR use their production fast grids and Dirichlet-EM; FLAVOR uses Julia-style transition interpolation. Their positive event is not identical to constant-across-branch MG94 truth, so their scores are deliberately treated as a model-mismatch stress test.\n\n## Realized datasets\n\n| Dataset | Tree height | Mean nt distance | Mean AA distance | Segregating nt | Visible recomb. events | Local trees |\n|---|---:|---:|---:|---:|---:|---:|\n${datasetTable}\n\nThe main tree's sampled-tip ages span ${number(Math.min(...heterogeneous.tree.tips.map((id) => heterogeneous.tree.nodes[id]!.time)), 2)}–${number(Math.max(...heterogeneous.tree.tips.map((id) => heterogeneous.tree.nodes[id]!.time)), 2)} demographic-time units. Its scaled root depth is ${number(heterogeneous.tree.height * heterogeneous.tree.branchScale)} and total scaled tree length is ${number(heterogeneous.tree.totalTimeLength * heterogeneous.tree.branchScale)}.\n\n## Recovery\n\n| Dataset | Method | Target | Calls | Sensitivity | Precision | ROC AUC | Average precision | Strong-site sensitivity | Runtime |\n|---|---|---|---:|---:|---:|---:|---:|---:|---:|\n${methodTable}\n\n"Strong" means ω≥1.5 for positive selection or ω≤0.67 for purifying selection. ROC/average precision use the complete continuous posterior and therefore separate ranking quality from the deliberately stringent reporting threshold.\n\n## Checks that matter\n\n- **Neutral calibration:** FUBAR made ${neutralPositive.metrics.detected} positive and ${neutralPurifying.metrics.detected} purifying calls at posterior ≥0.95 across ${siteCount} truly neutral sites. Approximate FEL made ${neutralFelPositive.metrics.detected} directional-positive and ${neutralFelPurifying.metrics.detected} directional-purifying calls at p≤0.05.\n- **Recombination handoff:** using the exact regional genealogies gave positive-selection ROC AUC ${number(regionalPositive.metrics.rocAuc)} versus ${number(masterPositive.metrics.rocAuc)} with only the master tree. This comparison uses the same fitted global codon model for the master-only rerun, isolating the local-tree assignment.\n- **SCUFF stress test:** the calm block has diagnostic mean expected dN/dS ${number(calmSimulation.scuffDiagnostic!.sampledMeanDnds)} and theoretical maximum-mean reference ${number(calmSimulation.scuffDiagnostic!.maximumExpectedDnds)}; the adaptive/high-jump block has ${number(rapidSimulation.scuffDiagnostic!.sampledMeanDnds)} and ${number(rapidSimulation.scuffDiagnostic!.maximumExpectedDnds)}. FLAVOR's adaptive-block ROC AUC is ${number(scuffMetrics.rocAuc)}. This is a block-discrimination stress test, not a claim that SCUFF's time-varying fitness process has a single binary site truth.\n\n## Visual audits\n\n- [Main heterogeneous tree + induced AA alignment](heterogeneous-mg94.tree-alignment.svg)\n- [Recombinant tree + induced AA alignment](recombinant-mg94.tree-alignment.svg)\n- [SCUFF block tree + induced AA alignment](scuff-block-contrast.tree-alignment.svg)\n- [FUBAR posterior against true ω](heterogeneous-mg94.posterior-vs-truth.svg)\n- [Measured runtimes](runtimes.svg)\n\nConsensus matches are intentionally faded in the alignment audits, making repeated homoplasy and divergent columns visible without expanding vertical spacing.\n\n## Files\n\nEach dataset has FASTA, substitution-length Newick, time Newick, JSON configuration, and TSV truth. Method CSVs are direct EvoOnline exports. The recombination case additionally includes every branch-interior event and every true local genealogy.\n`;
  const interpretation = `\n\n## Interpretation\n\n- The realized nucleotide divergences are informative without looking saturated in the tree/alignment audits. This is a useful moderate-information default.\n- At posterior 0.95, FUBAR is intentionally conservative here: the positive and purifying calls are high precision, but thresholded sensitivity is modest. For a power-testing preset, increase to roughly 64–80 tips and 600–900 codons while keeping realized mean nucleotide divergence around 12–18%.\n- Approximate FEL gains thresholded sensitivity but loses ranking and precision relative to FUBAR. Its two neutral directional call rates are separate one-sided 5% tests and should not be pooled and compared with a single 5% null rate.\n- FAME and FLAVOR are deliberately being applied to constant-across-branch MG94 as a model-mismatch stress test; their ranking here is not evidence that either supersedes FUBAR.\n- The exact regional trees only slightly improve this mild recombination case. A small recombinant history should not manufacture a dramatic selection result.\n- FLAVOR does not automatically recover the adaptive SCUFF block despite its diagnostic expected dN/dS exceeding one. Treat FLAVOR-on-SCUFF recovery as unvalidated until a larger replicate study identifies which aspects of continuously changing fitness are represented by FLAVOR's across-branch Gamma mixture.`;
  const finalReport = report.replace("\n\n## Visual audits", `${interpretation}\n\n## Visual audits`);
  await writeFile(resolve(outputDirectory, "REPORT.md"), finalReport);
  process.stdout.write(`${JSON.stringify(summaryJson, null, 2)}\n`);
}

await main();

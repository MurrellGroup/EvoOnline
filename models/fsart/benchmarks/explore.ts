import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  exploreTreeHmm,
  fitTreeHmm,
  type TreeEmissionProfile,
} from "../src/index.js";

interface Scenario {
  readonly id: string;
  readonly label: string;
  readonly sites: number;
  readonly truth: readonly { readonly start: number; readonly end: number; readonly state: number }[];
  readonly signal: number;
  readonly noise: number;
}

const SCENARIOS: readonly Scenario[] = [
  { id: "null", label: "No topology change", sites: 3000, truth: [{ start: 1, end: 3000, state: 0 }], signal: 0.18, noise: 0.24 },
  { id: "strong", label: "Two long, strong tracts", sites: 3000, truth: [{ start: 1, end: 1000, state: 0 }, { start: 1001, end: 2000, state: 1 }, { start: 2001, end: 3000, state: 2 }], signal: 0.24, noise: 0.24 },
  { id: "weak-short", label: "One weak 300-nt mosaic tract", sites: 3000, truth: [{ start: 1, end: 1350, state: 0 }, { start: 1351, end: 1650, state: 1 }, { start: 1651, end: 3000, state: 0 }], signal: 0.055, noise: 0.18 },
];

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function normal(next: () => number): number {
  return Math.sqrt(-2 * Math.log(Math.max(1e-12, next()))) * Math.cos(2 * Math.PI * next());
}

function activeState(scenario: Scenario, site: number): number {
  return scenario.truth.find((segment) => site + 1 >= segment.start && site + 1 <= segment.end)!.state;
}

function profiles(scenario: Scenario, stateCount = 24): TreeEmissionProfile[] {
  const next = random(0x9e3779b9 ^ scenario.id.length * 7919);
  const values = Array.from({ length: stateCount }, () => new Float64Array(scenario.sites));
  for (let site = 0; site < scenario.sites; site += 1) {
    const active = activeState(scenario, site);
    const common = 0.12 * normal(next);
    for (let state = 0; state < stateCount; state += 1) {
      const supported = state === active ? scenario.signal : 0;
      const decoyPenalty = state < 3 ? 0 : 0.035 + 0.002 * (state - 3);
      values[state]![site] = -1 + common + scenario.noise * normal(next) + supported - decoyPenalty;
    }
  }
  return values.map((siteLogLikelihoods, state): TreeEmissionProfile => ({
    id: `T${state + 1}`,
    sourceStart: Math.floor(state * scenario.sites / stateCount) + 1,
    sourceEnd: Math.max(1, Math.floor((state + 1) * scenario.sites / stateCount)),
    tree: state % 3 === 0 ? "((a,b),(c,d));" : state % 3 === 1 ? "((a,c),(b,d));" : "((a,d),(b,c));",
    topologySignature: `synthetic-${state + 1}`,
    logLikelihood: siteLogLikelihoods.reduce((sum, value) => sum + value, 0),
    siteLogLikelihoods,
    elapsedMs: 0,
  }));
}

function breakpoints(scenario: Scenario): number[] {
  return scenario.truth.slice(0, -1).map((segment) => segment.end);
}

function score(truth: readonly number[], predicted: readonly number[], tolerance = 40): { readonly precision: number; readonly recall: number; readonly f1: number } {
  const available = new Set(predicted.map((_value, index) => index));
  let matches = 0;
  for (const expected of truth) {
    let best: number | undefined;
    for (const index of available) {
      if (Math.abs(predicted[index]! - expected) <= tolerance && (best === undefined || Math.abs(predicted[index]! - expected) < Math.abs(predicted[best]! - expected))) best = index;
    }
    if (best !== undefined) { matches += 1; available.delete(best); }
  }
  const precision = predicted.length === 0 ? (truth.length === 0 ? 1 : 0) : matches / predicted.length;
  const recall = truth.length === 0 ? (predicted.length === 0 ? 1 : 0) : matches / truth.length;
  return { precision, recall, f1: precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall) };
}

function median(values: readonly number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function timed<T>(callback: () => T, repeats = 5): { readonly result: T; readonly milliseconds: number } {
  let result = callback();
  const values: number[] = [];
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    const started = performance.now();
    result = callback();
    values.push(performance.now() - started);
  }
  return { result, milliseconds: median(values) };
}

async function main(): Promise<void> {
  const rates = [0.25, 0.5, 1, 2, 4, 8, 16];
  const lines = [
    "# Interactive topology-HMM cached-emission stress benchmark",
    "",
    "This deterministic benchmark times only inference over a precomputed 3,000-site × 24-tree likelihood bank. It intentionally excludes FastTree: slider changes in EvoOnline reuse exactly this bank. Per-site log-likelihood noise is independent across tree hypotheses, with a planted coherent topology advantage. Breakpoint matching uses a ±40-site tolerance.",
    "",
    "## Default comparison (2 prior reset opportunities)",
    "",
    "| Scenario | Method | Trees retained | Viterbi breakpoints | Precision | Recall | F1 | Median update |",
    "|---|---|---:|---|---:|---:|---:|---:|",
  ];
  const rateLines = [
    "## Switching-prior sensitivity",
    "",
    "| Scenario | Prior resets | Low-switch breakpoints | Low-switch F1 | Sparse-EM breakpoints | Sparse-EM F1 |",
    "|---|---:|---|---:|---|---:|",
  ];
  for (const scenario of SCENARIOS) {
    const bank = profiles(scenario);
    const truth = breakpoints(scenario);
    const conservative = timed(() => fitTreeHmm(bank, {
      taxa: 9,
      criterion: "aicc",
      maximumRateSlices: 13,
      maximumStates: 12,
      beamWidth: 4,
      minimumRunLength: 45,
      searchMode: "rapid",
    }), 2);
    const low = timed(() => exploreTreeHmm(bank, { mode: "fixed-low-switch", expectedResets: 2, minimumRunLength: 45 }));
    const sparse = timed(() => exploreTreeHmm(bank, { mode: "sparse-dirichlet", expectedResets: 2, dirichletConcentration: 0.05, minimumRunLength: 45, maximumIterations: 40 }));
    const methods = [
      { label: "Conservative AICc", retained: conservative.result.states.length, values: conservative.result.viterbi?.breakpoints ?? [], ms: conservative.milliseconds },
      { label: "Low-switch Viterbi retention", retained: low.result.states.length, values: low.result.viterbi.breakpoints, ms: low.milliseconds },
      { label: "Sparse Dirichlet-EM", retained: sparse.result.states.length, values: sparse.result.viterbi.breakpoints, ms: sparse.milliseconds },
    ];
    for (const method of methods) {
      const accuracy = score(truth, method.values);
      lines.push(`| ${scenario.label} | ${method.label} | ${method.retained} | ${method.values.join(", ") || "none"} | ${accuracy.precision.toFixed(3)} | ${accuracy.recall.toFixed(3)} | ${accuracy.f1.toFixed(3)} | ${method.ms.toFixed(1)} ms |`);
    }
    for (const expectedResets of rates) {
      const lowRate = exploreTreeHmm(bank, { mode: "fixed-low-switch", expectedResets, minimumRunLength: 45 });
      const sparseRate = exploreTreeHmm(bank, { mode: "sparse-dirichlet", expectedResets, dirichletConcentration: 0.05, minimumRunLength: 45, maximumIterations: 40 });
      rateLines.push(`| ${scenario.label} | ${expectedResets} | ${lowRate.viterbi.breakpoints.join(", ") || "none"} | ${score(truth, lowRate.viterbi.breakpoints).f1.toFixed(3)} | ${sparseRate.viterbi.breakpoints.join(", ") || "none"} | ${score(truth, sparseRate.viterbi.breakpoints).f1.toFixed(3)} |`);
    }
  }
  lines.push(
    "",
    ...rateLines,
    "",
    "## Interpretation",
    "",
    "- The conservative result pays for every tree's phylogenetic parameters through AICc; coherent but modest short-tract support can therefore be rejected.",
    "- The two exploratory modes condition on the data-derived draft tree bank as if it were fixed. Their higher sensitivity is real conditional on that bank, but their posterior probabilities are not unconditional model-selection probabilities.",
    "- Low-switch retention is deliberately discontinuous when a Viterbi state enters or leaves the path. Sparse Dirichlet-EM changes more smoothly through its learned post-reset weights, although the final Viterbi path remains discrete.",
    "- This is a kernel stress test, not a calibrated evolutionary simulation. The piecewise-GTR simulation report remains the relevant end-to-end accuracy check; this benchmark isolates the behavior and latency of the new post-analysis controls.",
  );
  const output = resolve("benchmarks/results/tree-hmm-exploration.md");
  await mkdir(resolve("benchmarks/results"), { recursive: true });
  await writeFile(output, `${lines.join("\n")}\n`);
  console.log(output);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});

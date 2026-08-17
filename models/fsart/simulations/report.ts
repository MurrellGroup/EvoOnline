import type { BenchmarkResult, BenchmarkApproach, ReplicateResult, SummaryResult } from "./results.js";

const APPROACH_LABEL: Readonly<Record<BenchmarkApproach, string>> = {
  "ranked-window": "Ranked window candidates",
  "local-hmm-merged": "Consensus triplet proposals",
  "stepwise-aicc": "Legacy greedy fixed partition",
  "tree-hmm-aicc": "Consensus-family HMM + refit",
  "oracle-aicc": "Oracle candidates + AICc",
  "single-tree": "Single FastTree",
};

const COLORS: Readonly<Record<BenchmarkApproach, string>> = {
  "ranked-window": "#71867f",
  "local-hmm-merged": "#2d72b8",
  "stepwise-aicc": "#17806f",
  "tree-hmm-aicc": "#b54e72",
  "oracle-aicc": "#c87922",
  "single-tree": "#815bb5",
};

function number(value: number | null, digits = 3): string {
  return value === null || !Number.isFinite(value) ? "—" : value.toFixed(digits);
}

function milliseconds(value: number): string {
  return value < 1000 ? `${value.toFixed(1)} ms` : `${(value / 1000).toFixed(2)} s`;
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : Array.isArray(value) ? value.join(";") : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function replicateCsv(replicates: readonly ReplicateResult[]): string {
  const header = [
    "diversity", "diversity_label", "branch_length_scale", "scenario", "scenario_label", "replicate", "seed", "taxa", "sites", "tolerance", "true_breakpoints",
    "approach", "predicted_breakpoints", "tp", "fp", "fn", "precision", "recall", "f1", "exact_count",
    "localization_mae", "localization_rmse", "interval_coverage", "mean_interval_width", "topology_rf",
    "wall_ms", "fasttree_fresh_fits", "status", "simulation_ms", "scan_ms", "hmm_ms", "merge_ms",
    "rate_invariant_fraction", "rate_q10", "rate_median", "rate_q90", "rate_maximum", "mean_pairwise_distance",
    "pairwise_distance_q10", "pairwise_distance_q90", "variable_site_fraction", "parsimony_informative_fraction",
    "complete_case_fraction", "mean_events_per_triplet", "median_events_per_triplet", "events_per_triplet_q10",
    "events_per_triplet_q90", "eligible_triplet_fraction",
  ];
  const rows = replicates.flatMap((replicate) => replicate.approaches.map((approach) => {
    const accuracy = approach.accuracy;
    return [
      replicate.diversityId, replicate.diversityLabel, replicate.branchLengthScale, replicate.scenarioId, replicate.scenarioLabel,
      replicate.replicate, replicate.seed, replicate.taxa, replicate.sites,
      replicate.tolerance, replicate.trueBreakpoints, approach.approach, approach.predictedBreakpoints,
      accuracy?.truePositive, accuracy?.falsePositive, accuracy?.falseNegative, accuracy?.precision, accuracy?.recall,
      accuracy?.f1, accuracy?.exactCount, accuracy?.localizationMae, accuracy?.localizationRmse,
      accuracy?.intervalCoverage, accuracy?.meanIntervalWidth, approach.topologyRf, approach.wallMs,
      approach.fastTreeFreshFits, approach.status, replicate.simulationMs, replicate.scanMs, replicate.hmmMs,
      replicate.mergeMs, replicate.rateSummary.invariantFraction, replicate.rateSummary.q10, replicate.rateSummary.median,
      replicate.rateSummary.q90, replicate.rateSummary.maximum, replicate.diversitySummary.meanPairwiseDistance,
      replicate.diversitySummary.pairwiseDistanceQ10, replicate.diversitySummary.pairwiseDistanceQ90,
      replicate.diversitySummary.variableSiteFraction, replicate.diversitySummary.parsimonyInformativeFraction,
      replicate.diversitySummary.completeCaseFraction, replicate.diversitySummary.meanEventsPerTriplet,
      replicate.diversitySummary.medianEventsPerTriplet, replicate.diversitySummary.eventsPerTripletQ10,
      replicate.diversitySummary.eventsPerTripletQ90, replicate.diversitySummary.eligibleTripletFraction,
    ].map(csvCell).join(",");
  }));
  return `${header.join(",")}\n${rows.join("\n")}\n`;
}

export function summaryCsv(summaries: readonly SummaryResult[]): string {
  const keys: readonly (keyof SummaryResult)[] = [
    "diversityId", "diversityLabel", "branchLengthScale", "scenarioId", "scenarioLabel", "approach", "replicates", "trueBreakpoints", "predictedBreakpoints", "truePositive",
    "falsePositive", "falseNegative", "precision", "recall", "f1", "exactCountRate", "falsePositivesPerReplicate",
    "localizationMae", "intervalCoverage", "meanIntervalWidth", "topologyRf", "meanWallMs", "medianWallMs", "p95WallMs",
    "meanFastTreeFreshFits", "meanPairwiseDistance", "meanVariableSiteFraction", "meanParsimonyInformativeFraction",
    "meanEventsPerTriplet", "medianEventsPerTriplet", "eligibleTripletFraction",
  ];
  return `${keys.join(",")}\n${summaries.map((value) => keys.map((key) => csvCell(value[key])).join(",")).join("\n")}\n`;
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function quantile(values: readonly number[], probability: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const position = probability * (sorted.length - 1);
  const low = Math.floor(position);
  const high = Math.ceil(position);
  const fraction = position - low;
  return sorted[low]! * (1 - fraction) + sorted[high]! * fraction;
}

interface PooledApproach {
  readonly precision: number | null;
  readonly recall: number | null;
  readonly f1: number | null;
  readonly exactCountRate: number | null;
  readonly localizationMae: number | null;
  readonly intervalCoverage: number | null;
  readonly intervalWidth: number | null;
  readonly topologyRf: number | null;
  readonly medianWallMs: number;
  readonly meanPredicted: number;
}

function poolApproach(
  result: BenchmarkResult,
  diversityId: string,
  approach: BenchmarkApproach,
  includeNull: boolean,
): PooledApproach {
  const values = result.replicates
    .filter((replicate) => replicate.diversityId === diversityId && (includeNull || replicate.scenarioId !== "null"))
    .flatMap((replicate) => replicate.approaches.filter((value) => value.approach === approach));
  const accuracies = values.flatMap((value) => value.accuracy === null ? [] : [value.accuracy]);
  const tp = accuracies.reduce((sum, value) => sum + value.truePositive, 0);
  const fp = accuracies.reduce((sum, value) => sum + value.falsePositive, 0);
  const fn = accuracies.reduce((sum, value) => sum + value.falseNegative, 0);
  const errors = accuracies.flatMap((value) => value.matches.map((match) => match.error));
  const intervals = accuracies.filter((value) => value.intervalCoverage !== null);
  const topology = values.flatMap((value) => value.topologyRf === null ? [] : [value.topologyRf]);
  return {
    precision: tp + fp === 0 ? null : tp / (tp + fp),
    recall: tp + fn === 0 ? null : tp / (tp + fn),
    f1: 2 * tp + fp + fn === 0 ? null : 2 * tp / (2 * tp + fp + fn),
    exactCountRate: accuracies.length === 0 ? null : accuracies.filter((value) => value.exactCount).length / accuracies.length,
    localizationMae: mean(errors),
    intervalCoverage: mean(intervals.map((value) => value.intervalCoverage!)),
    intervalWidth: mean(intervals.flatMap((value) => value.meanIntervalWidth === null ? [] : [value.meanIntervalWidth])),
    topologyRf: mean(topology),
    medianWallMs: quantile(values.map((value) => value.wallMs), 0.5),
    meanPredicted: mean(values.map((value) => value.predictedBreakpoints.length)) ?? 0,
  };
}

export function markdownReport(result: BenchmarkResult): string {
  const config = result.config as { taxa?: number; sites?: number; replicates?: number; tolerance?: number; fastTree?: boolean; seed?: number };
  const environment = result.environment as { fastTreeVersion?: string | null };
  const diversities = Array.from(new Map(result.replicates.map((value) => [value.diversityId, {
    id: value.diversityId,
    label: value.diversityLabel,
    scale: value.branchLengthScale,
  }])).values());
  const candidateApproaches: BenchmarkApproach[] = (["ranked-window", "local-hmm-merged"] as const)
    .filter((approach) => result.replicates.some((replicate) => replicate.approaches.some((value) => value.approach === approach)));
  const detectionApproaches: BenchmarkApproach[] = (["stepwise-aicc", "tree-hmm-aicc", "oracle-aicc"] as const)
    .filter((approach) => result.replicates.some((replicate) => replicate.approaches.some((value) => value.approach === approach)));
  const diversityRows = diversities.map((diversity) => {
    const rows = result.replicates.filter((value) => value.diversityId === diversity.id);
    const summaries = rows.map((value) => value.diversitySummary);
    return `| ${diversity.label} | ${number(diversity.scale, 2)} | ${number(mean(summaries.map((value) => value.meanPairwiseDistance)))} | ${number(mean(summaries.map((value) => value.pairwiseDistanceQ10)))}–${number(mean(summaries.map((value) => value.pairwiseDistanceQ90)))} | ${number(mean(summaries.map((value) => value.variableSiteFraction)))} | ${number(mean(summaries.map((value) => value.parsimonyInformativeFraction)))} | ${number(mean(summaries.map((value) => value.medianEventsPerTriplet)), 1)} | ${number(mean(summaries.map((value) => value.eligibleTripletFraction)))} |`;
  });
  const accuracyRows = diversities.flatMap((diversity) => detectionApproaches.map((approach) => {
    const pooled = poolApproach(result, diversity.id, approach, false);
    return `| ${diversity.label} | ${APPROACH_LABEL[approach]} | ${number(pooled.precision)} | ${number(pooled.recall)} | ${number(pooled.f1)} | ${number(pooled.exactCountRate)} | ${number(pooled.localizationMae, 1)} | ${number(pooled.intervalCoverage)} | ${number(pooled.intervalWidth, 1)} | ${number(pooled.topologyRf)} | ${milliseconds(pooled.medianWallMs)} |`;
  }));
  const candidateRows = diversities.flatMap((diversity) => candidateApproaches.map((approach) => {
    const pooled = poolApproach(result, diversity.id, approach, false);
    return `| ${diversity.label} | ${APPROACH_LABEL[approach]} | ${number(pooled.recall)} | ${number(pooled.meanPredicted, 1)} | ${number(pooled.localizationMae, 1)} | ${number(pooled.intervalCoverage)} | ${number(pooled.intervalWidth, 1)} | ${milliseconds(pooled.medianWallMs)} |`;
  }));
  const nullRows = result.summaries
    .filter((value) => value.scenarioId === "null" && detectionApproaches.includes(value.approach))
    .map((value) => `| ${value.diversityLabel} | ${APPROACH_LABEL[value.approach]} | ${number(value.falsePositivesPerReplicate, 2)} | ${number(value.exactCountRate)} | ${milliseconds(value.medianWallMs)} |`);
  const complexityRows = diversities.flatMap((diversity) => result.summaries
    .filter((value) => value.diversityId === diversity.id && value.scenarioId !== "null" && value.approach === "stepwise-aicc")
    .map((value) => {
      const ranked = result.summaries.find((candidate) => candidate.diversityId === diversity.id && candidate.scenarioId === value.scenarioId && candidate.approach === "tree-hmm-aicc");
      const oracle = result.summaries.find((candidate) => candidate.diversityId === diversity.id && candidate.scenarioId === value.scenarioId && candidate.approach === "oracle-aicc");
      return `| ${diversity.label} | ${value.scenarioLabel} | ${number(value.f1)} | ${number(ranked?.f1 ?? null)} | ${number(oracle?.f1 ?? null)} |`;
    }));
  const rates = result.replicates.map((value) => value.rateSummary);
  const meanRate = (key: keyof ReplicateResult["rateSummary"]): number => rates.reduce((sum, value) => sum + value[key], 0) / Math.max(1, rates.length);
  const headlineRows = diversities.map((diversity) => {
    const rows = result.replicates.filter((value) => value.diversityId === diversity.id);
    const realized = mean(rows.map((value) => value.diversitySummary.meanPairwiseDistance));
    const thresholded = poolApproach(result, diversity.id, "stepwise-aicc", false);
    const ranked = poolApproach(result, diversity.id, "tree-hmm-aicc", false);
    const oracle = poolApproach(result, diversity.id, "oracle-aicc", false);
    return `- **${diversity.label} (realized p-distance ${number(realized)}):** legacy fixed-partition F1 ${number(thresholded.f1)}; consensus-family topology-HMM F1 ${number(ranked.f1)}; oracle-candidate AICc F1 ${number(oracle.f1)}.`;
  });
  return `# FSART recombination simulation benchmark

Generated ${result.generatedAt}. This report is descriptive for the pinned simulator/configuration below; it is not a claim of general calibration.

## Design

- **Replicates:** ${config.replicates ?? "?"} per diversity × recombination scenario; ${config.taxa ?? "?"} taxa; ${config.sites ?? "?"} aligned nucleotides; deterministic base seed ${config.seed ?? "?"}.
- **Evolution:** exact Gillespie simulation under a four-state GTR CTMC (π = 0.30/0.20/0.22/0.28, elevated transition rates) on random bifurcating trees with heterogeneous branch lengths.
- **Diversity:** paired branch-length scales target the approximately 5% and 25% divergence regimes in GARD's broad 8-taxon, 3,000-nt simulations. All interpretation uses realized pairwise p-distance and informative-event supply rather than the scale label.
- **Rate variation:** continuous Gamma(shape 0.55) site rates, approximately 8% invariant sites, and an AR(1)-correlated lognormal regional multiplier. Realized mean invariant fraction was ${number(meanRate("invariantFraction"))}; positive-rate median ${number(meanRate("median"))}, q90 ${number(meanRate("q90"))}, maximum ${number(meanRate("maximum"))}.
- **Data imperfections:** sparse ambiguous bases and short gap tracts.
- **Recombination:** the primary suite uses 0, 1, 2, or 3 well-separated breakpoints over ${config.sites ?? "?"} nt. Every adjacent tree is required to differ in its **unrooted split set** by at least one NNI; root-only rearrangements are rejected by the simulator. Four- and eight-event mosaics are separate stress cases.
- **Matching:** a predicted breakpoint is a true positive only in a one-to-one assignment within ±${config.tolerance ?? "?"} nt. The assignment first maximizes matches and then minimizes total absolute error.
- **Intervals:** triplet-HMM intervals condition on a candidate-associated local switch mode. Topology-HMM intervals instead use the full-alignment switching posterior, merge nearby subpeaks belonging to one posterior mode, and discard modes carrying negligible expected-switch mass.
- **Topology:** normalized Robinson–Foulds distance is integrated over every overlap between inferred and true segments; 0 is perfect and 1 is maximally discordant under the observed split sets.
- **Timing:** wall time excludes simulation. The legacy fixed partition and consensus-family HMM are timed independently after the shared scan; the HMM row includes family generation, all site-emission fits, rapid subset search, and up to three Viterbi/tree-refit cycles. Scanner timings use one Node worker (the browser shards across up to eight); tree timings ${config.fastTree === false ? "were not requested" : `use ${environment.fastTreeVersion ?? "an unidentified native FastTree build"} rather than bioWASM`}. Oracle+AICc and single-tree rows are diagnostics, not deployable breakpoint detectors.

## Headline findings

${headlineRows.join("\n")}

- No multiple-comparisons correction is used to admit initial breakpoint candidates. The scan produces a bounded evidence ranking; whole-model AICc controls complexity downstream.
- Candidate-local HMM interval coverage must be read together with width and point-estimate error. Conditioning fixes the invalid whole-alignment normalization but cannot rescue a scan candidate attached to the wrong biological breakpoint.

## Candidate retrieval (not final discoveries)

The two scan layers are deliberately uncorrected bounded rankings. Precision and null false-positive counts are therefore category errors; the useful quantities are whether a true breakpoint entered the budget, where it ranked/localized, and how much time candidate generation cost.

| Diversity | Candidate layer | Recall within retained budget | Mean candidates/alignment | Nearest MAE (nt) | Interval coverage | Mean interval width | Median time |
|---|---|---:|---:|---:|---:|---:|---:|
${candidateRows.join("\n")}

## Realized diversity and usable triplet information

| Diversity stratum | Branch scale | Mean p-distance | Pairwise q10–q90 | Variable sites | Parsimony-informative | Median events/triplet | Triplets with ≥48 events |
|---|---:|---:|---:|---:|---:|---:|---:|
${diversityRows.join("\n")}

The final column is the fraction of taxa triplets capable of supplying FSART's default 24 informative events on each side of a boundary. High event count is necessary but not sufficient: recurrent substitutions and branch-length asymmetry can still obscure which pair dominates.

## Final-model breakpoint and topology results

Pooled over all non-null recombination scenarios within each diversity stratum:

| Diversity | Approach | Precision | Recall | F1 | Exact count | MAE (nt) | Local interval coverage | Mean local width | Topology RF | Median time |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${accuracyRows.join("\n")}

## Accuracy by recombination complexity

| Diversity | Scenario | Legacy fixed-partition F1 | Consensus-family HMM F1 | Oracle+AICc F1 |
|---|---|---:|---:|---:|
${complexityRows.join("\n")}

For the no-recombination scenario, precision/recall/F1 are undefined; false positives per alignment are more informative:

| Diversity | Approach | FP/alignment | Exact zero-count rate | Median time |
|---|---|---:|---:|---:|
${nullRows.join("\n")}

## Interpretation controls

- **Ranked window candidates** isolate the optimized informative-triplet G-test and spatial non-maximum suppression without a significance gate.
- **Consensus triplet proposals** combine rate-marginalized candidate-local modes by corroborating-triplet count and compressed evidence strength, then apply the information-aware hard-spacing guard. They are still proposals, not final discoveries.
- **Legacy greedy fixed partition** is retained only as a comparator for the previous implementation; it commits to one breakpoint at a time.
- **Consensus-family HMM + refit** hard-spaces count/strength consensus proposals (150 nt by default, raised until a window is expected to contain at least max(30, 2 × taxa) variable sites), fits every atomic segment plus adjacent pairs/triplets and the global tree, retains and scores every source-fitted full tree independently, searches subsets with a beam plus reversible add/drop/swap moves, then alternates a minimum-run Viterbi path with tree refits. Its switch-mode intervals do not assume the proposal boundaries are final.
- **Oracle candidates + AICc** supplies the true breakpoints to the same FastTree rule. Its gap from FSART+AICc separates candidate-generation failures from model-selection failures.
- **Single FastTree** is a topology-only baseline. It cannot detect breakpoints.

## Important limitations

This simulator is intentionally rough rather than an ecological truth generator. NNI changes approximate local genealogy changes but do not explicitly simulate a recombinant lineage, ancestral recombination graph, gene conversion tract, selection, indel evolution, or population structure. GTR+Gamma is favorable to the FastTree scoring model. The uncorrected triplet ranking is candidate generation, not a calibrated hypothesis test; null control belongs to the whole-model IC stages. Use the included CLI to expand taxa, length, replicates, topology contrast, diversity scales, and rate settings.

## Published GARD calibration target

The original GARD study's broad suite used 8 taxa × 3,000 nt at roughly 5% and 25% divergence with 0, 1, 2, 4, or 8 recombination events. Its reported probability of detecting any recombination was 56%/76% for one event, 74%/88% for two, 84%/99% for four, and 97%/98% for eight in low/high-diversity strata; the corresponding no-event false-positive rates were 10% and 6%. Separate 9-sequence fixed scenarios with two or three breakpoints had much stronger signal. See the [GARD method paper](https://academic.oup.com/mbe/article/23/10/1891/1096946) and [software paper](https://academic.oup.com/bioinformatics/article/22/24/3096/208339). Those published simulations are a calibration target, not a directly interchangeable control for this simulator; parity requires replicated same-data GARD runs.

Files: \`summary.csv\`, \`replicates.csv\`, \`results.json\`, and \`accuracy-timing.svg\`.
`;
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function benchmarkSvg(result: BenchmarkResult): string {
  const diversities = Array.from(new Map(result.replicates.map((value) => [value.diversityId, {
    id: value.diversityId,
    label: value.diversityLabel,
    pDistance: mean(result.replicates.filter((candidate) => candidate.diversityId === value.diversityId).map((candidate) => candidate.diversitySummary.meanPairwiseDistance)) ?? 0,
  }])).values());
  const candidateApproaches: BenchmarkApproach[] = (["ranked-window", "local-hmm-merged"] as const)
    .filter((approach) => result.replicates.some((replicate) => replicate.approaches.some((value) => value.approach === approach)));
  const detectionApproaches: BenchmarkApproach[] = (["stepwise-aicc", "tree-hmm-aicc", "oracle-aicc"] as const)
    .filter((approach) => result.replicates.some((replicate) => replicate.approaches.some((value) => value.approach === approach)));
  const timingApproaches: BenchmarkApproach[] = [...candidateApproaches, ...detectionApproaches];
  if (result.replicates.some((replicate) => replicate.approaches.some((value) => value.approach === "single-tree"))) timingApproaches.push("single-tree");
  const width = 1380;
  const height = 850;
  const left = 92;
  const right = 36;
  const plotWidth = width - left - right;
  const panelHeight = 245;
  const firstTop = 104;
  const secondTop = 455;
  const groupWidth = plotWidth / diversities.length;
  const f1Y = (value: number): number => firstTop + panelHeight - value * panelHeight;
  const maximumTime = Math.max(10, ...result.summaries.map((value) => value.medianWallMs));
  const timeMaximumLog = Math.ceil(Math.log10(maximumTime));
  const timeY = (value: number): number => secondTop + panelHeight - Math.log10(Math.max(1, value)) / timeMaximumLog * panelHeight;
  const lines: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
    `<g font-family="Inter,Arial,sans-serif" fill="#1b2926">`,
    `<text x="${left}" y="38" font-size="25" font-weight="700">FSART final-model accuracy across realized diversity</text>`,
    `<text x="${left}" y="64" font-size="12" fill="#63726e">F1 excludes uncorrected candidate rankings; timing includes candidate generation; error tolerance ±${String(result.config.tolerance)} nt</text>`,
  ];
  for (let tick = 0; tick <= 4; tick += 1) {
    const value = tick / 4;
    const y = f1Y(value);
    lines.push(`<line x1="${left}" x2="${width - right}" y1="${y}" y2="${y}" stroke="#dfe6e2" stroke-dasharray="3 5"/>`);
    lines.push(`<text x="${left - 12}" y="${y + 4}" text-anchor="end" font-size="10" fill="#667570">${value.toFixed(2)}</text>`);
  }
  lines.push(`<text x="24" y="${firstTop + panelHeight / 2}" transform="rotate(-90 24 ${firstTop + panelHeight / 2})" text-anchor="middle" font-size="12">Breakpoint F1</text>`);
  diversities.forEach((diversity, diversityIndex) => {
    const center = left + groupWidth * (diversityIndex + 0.5);
    const barsWidth = groupWidth * 0.72;
    const barWidth = barsWidth / detectionApproaches.length;
    detectionApproaches.forEach((approach, approachIndex) => {
      const value = poolApproach(result, diversity.id, approach, false).f1;
      if (value === null || value === undefined) return;
      const x = center - barsWidth / 2 + approachIndex * barWidth + 2;
      const y = f1Y(value);
      const barHeight = Math.max(3, firstTop + panelHeight - y);
      const barTop = firstTop + panelHeight - barHeight;
      lines.push(`<rect x="${x}" y="${barTop}" width="${Math.max(2, barWidth - 4)}" height="${barHeight}" rx="2" fill="${COLORS[approach]}" opacity="0.88"><title>${escapeXml(diversity.label)} · ${APPROACH_LABEL[approach]} · F1 ${value.toFixed(3)}</title></rect>`);
    });
    lines.push(`<text x="${center}" y="${firstTop + panelHeight + 20}" text-anchor="middle" font-size="10" fill="#44534f">${escapeXml(diversity.label)}</text>`);
    lines.push(`<text x="${center}" y="${firstTop + panelHeight + 35}" text-anchor="middle" font-size="10" fill="#6b7975">mean p = ${diversity.pDistance.toFixed(3)}</text>`);
  });
  for (let exponent = 0; exponent <= timeMaximumLog; exponent += 1) {
    const value = 10 ** exponent;
    const y = timeY(value);
    lines.push(`<line x1="${left}" x2="${width - right}" y1="${y}" y2="${y}" stroke="#dfe6e2" stroke-dasharray="3 5"/>`);
    lines.push(`<text x="${left - 12}" y="${y + 4}" text-anchor="end" font-size="10" fill="#667570">${value >= 1000 ? `${value / 1000}s` : `${value}ms`}</text>`);
  }
  lines.push(`<text x="24" y="${secondTop + panelHeight / 2}" transform="rotate(-90 24 ${secondTop + panelHeight / 2})" text-anchor="middle" font-size="12">Median wall time (log scale)</text>`);
  diversities.forEach((diversity, diversityIndex) => {
    const center = left + groupWidth * (diversityIndex + 0.5);
    const barsWidth = groupWidth * 0.76;
    const barWidth = barsWidth / timingApproaches.length;
    timingApproaches.forEach((approach, approachIndex) => {
      const value = poolApproach(result, diversity.id, approach, true).medianWallMs;
      const x = center - barsWidth / 2 + approachIndex * barWidth + 2;
      const y = timeY(value);
      lines.push(`<rect x="${x}" y="${y}" width="${Math.max(2, barWidth - 4)}" height="${secondTop + panelHeight - y}" rx="2" fill="${COLORS[approach]}" opacity="0.88"><title>${escapeXml(diversity.label)} · ${APPROACH_LABEL[approach]} · ${milliseconds(value)}</title></rect>`);
    });
    lines.push(`<text x="${center}" y="${secondTop + panelHeight + 22}" text-anchor="middle" font-size="10" fill="#44534f">${escapeXml(diversity.label)}</text>`);
  });
  const legendY = 788;
  timingApproaches.forEach((approach, index) => {
    const x = left + (index % 3) * 410;
    const y = legendY + Math.floor(index / 3) * 25;
    lines.push(`<rect x="${x}" y="${y - 11}" width="18" height="10" rx="2" fill="${COLORS[approach]}"/>`);
    lines.push(`<text x="${x + 25}" y="${y - 2}" font-size="10" fill="#43524e">${APPROACH_LABEL[approach]}</text>`);
  });
  lines.push(`</g></svg>`);
  return lines.join("\n");
}

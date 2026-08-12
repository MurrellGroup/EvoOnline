import { informativeState } from "./alignment.js";
import type {
  FsartAlignment,
  FsartRefinementOptions,
  RawTripletSignal,
  RefinedTripletSignal,
  SwitchingRateSlice,
  TripletTrace,
} from "./types.js";

interface EventStream {
  readonly positions: Uint32Array;
  readonly observations: Uint8Array;
}

interface HmmPosterior {
  readonly trace: TripletTrace;
  readonly emissionAccuracy: number;
  readonly rates: readonly SwitchingRateSlice[];
}

const LOG_TEN = Math.log(10);

function eventsForTriplet(alignment: FsartAlignment, taxa: readonly [number, number, number]): EventStream {
  const positions = new Uint32Array(alignment.variableSites.length);
  const observations = new Uint8Array(alignment.variableSites.length);
  let length = 0;
  for (let variableIndex = 0; variableIndex < alignment.variableSites.length; variableIndex += 1) {
    const site = alignment.variableSites[variableIndex]!;
    const offset = site * alignment.taxa;
    const state = informativeState(
      alignment.matrix[offset + taxa[0]]!,
      alignment.matrix[offset + taxa[1]]!,
      alignment.matrix[offset + taxa[2]]!,
    );
    if (state < 0) continue;
    positions[length] = site;
    observations[length] = state;
    length += 1;
  }
  return { positions: positions.slice(0, length), observations: observations.slice(0, length) };
}

function mode(observations: Uint8Array, start: number, end: number): number {
  const counts = [0, 0, 0];
  for (let index = start; index < end; index += 1) counts[observations[index]!]! += 1;
  let state = 0;
  if (counts[1]! > counts[state]!) state = 1;
  if (counts[2]! > counts[state]!) state = 2;
  return state;
}

function initialEmissionAccuracy(stream: EventStream, candidates: readonly RawTripletSignal[]): number {
  const boundaries = Array.from(new Set(candidates.map((signal) => signal.eventBoundary)))
    .filter((boundary) => boundary > 0 && boundary < stream.observations.length)
    .sort((a, b) => a - b);
  let matches = 0;
  let total = 0;
  let start = 0;
  for (const end of [...boundaries, stream.observations.length]) {
    if (end > start) {
      const state = mode(stream.observations, start, end);
      for (let index = start; index < end; index += 1) {
        matches += stream.observations[index] === state ? 1 : 0;
        total += 1;
      }
    }
    start = end;
  }
  // Symmetric Dirichlet(1/2) stabilization. This parameter is initialized
  // once from event purity and deliberately never optimized by Baum-Welch.
  return Math.max(0.55, Math.min(0.995, (matches + 0.5) / (total + 1.5)));
}

function transition(rate: number, distance: number): readonly [number, number] {
  // Continuous-time, three-state symmetric chain. `different` is the
  // probability of each particular alternative state, not their sum.
  const decay = Math.exp(-1.5 * rate * Math.max(1, distance));
  return [1 / 3 + (2 / 3) * decay, 1 / 3 - (1 / 3) * decay];
}

function emission(observation: number, state: number, accuracy: number): number {
  return observation === state ? accuracy : (1 - accuracy) / 2;
}

function forward(
  stream: EventStream,
  rate: number,
  accuracy: number,
  retain: boolean,
): { readonly logEvidence: number; readonly values?: Float64Array; readonly scales?: Float64Array } {
  const length = stream.observations.length;
  const values = retain ? new Float64Array(length * 3) : new Float64Array(6);
  const scales = retain ? new Float64Array(length) : undefined;
  let previousOffset = 0;
  let currentOffset = retain ? 0 : 3;
  let scale = 0;
  for (let state = 0; state < 3; state += 1) {
    const value = emission(stream.observations[0]!, state, accuracy) / 3;
    values[currentOffset + state] = value;
    scale += value;
  }
  for (let state = 0; state < 3; state += 1) values[currentOffset + state] = values[currentOffset + state]! / scale;
  if (retain) scales![0] = scale;
  let logEvidence = Math.log(scale);
  for (let index = 1; index < length; index += 1) {
    if (!retain) {
      const swap = previousOffset;
      previousOffset = currentOffset;
      currentOffset = swap;
    } else {
      previousOffset = (index - 1) * 3;
      currentOffset = index * 3;
    }
    const [same, different] = transition(rate, stream.positions[index]! - stream.positions[index - 1]!);
    scale = 0;
    for (let state = 0; state < 3; state += 1) {
      let predicted = 0;
      for (let previous = 0; previous < 3; previous += 1) {
        predicted += values[previousOffset + previous]! * (previous === state ? same : different);
      }
      const value = predicted * emission(stream.observations[index]!, state, accuracy);
      values[currentOffset + state] = value;
      scale += value;
    }
    scale = Math.max(scale, Number.MIN_VALUE);
    for (let state = 0; state < 3; state += 1) values[currentOffset + state] = values[currentOffset + state]! / scale;
    if (retain) scales![index] = scale;
    logEvidence += Math.log(scale);
  }
  return retain ? { logEvidence, values, scales: scales! } : { logEvidence };
}

function posteriorForRate(stream: EventStream, rate: number, accuracy: number): { readonly states: Float64Array; readonly switches: Float64Array } {
  const retained = forward(stream, rate, accuracy, true);
  const forwardValues = retained.values!;
  const scales = retained.scales!;
  const length = stream.observations.length;
  const states = new Float64Array(length * 3);
  const switches = new Float64Array(Math.max(0, length - 1));
  let betaNext = new Float64Array([1, 1, 1]);

  const writeState = (index: number, beta: Float64Array): void => {
    let normalizer = 0;
    for (let state = 0; state < 3; state += 1) normalizer += forwardValues[index * 3 + state]! * beta[state]!;
    for (let state = 0; state < 3; state += 1) states[index * 3 + state] = forwardValues[index * 3 + state]! * beta[state]! / normalizer;
  };
  writeState(length - 1, betaNext);
  for (let index = length - 2; index >= 0; index -= 1) {
    const [same, different] = transition(rate, stream.positions[index + 1]! - stream.positions[index]!);
    let switchNumerator = 0;
    let xiNormalizer = 0;
    for (let from = 0; from < 3; from += 1) {
      for (let to = 0; to < 3; to += 1) {
        const value = forwardValues[index * 3 + from]!
          * (from === to ? same : different)
          * emission(stream.observations[index + 1]!, to, accuracy)
          * betaNext[to]!;
        xiNormalizer += value;
        if (from !== to) switchNumerator += value;
      }
    }
    switches[index] = xiNormalizer > 0 ? switchNumerator / xiNormalizer : 0;
    const beta = new Float64Array(3);
    for (let from = 0; from < 3; from += 1) {
      let value = 0;
      for (let to = 0; to < 3; to += 1) {
        value += (from === to ? same : different)
          * emission(stream.observations[index + 1]!, to, accuracy)
          * betaNext[to]!;
      }
      beta[from] = value / Math.max(scales[index + 1]!, Number.MIN_VALUE);
    }
    writeState(index, beta);
    betaNext = beta;
  }
  return { states, switches };
}

function logSumExp(values: readonly number[]): number {
  let maximum = -Infinity;
  for (const value of values) maximum = Math.max(maximum, value);
  let total = 0;
  for (const value of values) total += Math.exp(value - maximum);
  return maximum + Math.log(total);
}

function runHmm(
  stream: EventStream,
  candidates: readonly RawTripletSignal[],
  alignmentSites: number,
  sliceCount: number,
): HmmPosterior {
  const accuracy = initialEmissionAccuracy(stream, candidates);
  const center = Math.max(0.5, candidates.length);
  const rates = new Float64Array(sliceCount);
  const expected = new Float64Array(sliceCount);
  const logEvidence = new Float64Array(sliceCount);
  for (let slice = 0; slice < sliceCount; slice += 1) {
    const exponent = sliceCount === 1 ? 0 : -3 + (6 * slice) / (sliceCount - 1);
    expected[slice] = center * (2 ** exponent);
    rates[slice] = expected[slice]! / Math.max(1, alignmentSites - 1);
    logEvidence[slice] = forward(stream, rates[slice]!, accuracy, false).logEvidence;
  }
  const normalizer = logSumExp(Array.from(logEvidence));
  const rateWeights = Float64Array.from(logEvidence, (value) => Math.exp(value - normalizer));
  const statePosterior = new Float64Array(stream.observations.length * 3);
  const switchPosterior = new Float64Array(Math.max(0, stream.observations.length - 1));
  for (let slice = 0; slice < sliceCount; slice += 1) {
    const weight = rateWeights[slice]!;
    if (weight < 1e-12) continue;
    const posterior = posteriorForRate(stream, rates[slice]!, accuracy);
    for (let index = 0; index < statePosterior.length; index += 1) statePosterior[index] = statePosterior[index]! + weight * posterior.states[index]!;
    for (let index = 0; index < switchPosterior.length; index += 1) switchPosterior[index] = switchPosterior[index]! + weight * posterior.switches[index]!;
  }
  const mapStates = new Uint8Array(stream.observations.length);
  for (let index = 0; index < mapStates.length; index += 1) {
    let state = 0;
    if (statePosterior[index * 3 + 1]! > statePosterior[index * 3 + state]!) state = 1;
    if (statePosterior[index * 3 + 2]! > statePosterior[index * 3 + state]!) state = 2;
    mapStates[index] = state;
  }
  return {
    emissionAccuracy: accuracy,
    rates: Array.from(expected, (value, index) => ({ expectedSwitches: value, posterior: rateWeights[index]! })),
    trace: {
      positions: stream.positions,
      observations: stream.observations,
      mapStates,
      switchPosterior: Float32Array.from(switchPosterior),
    },
  };
}

function weightedQuantile(weights: Float32Array, low: number, high: number, probability: number): number {
  let total = 0;
  for (let index = low; index <= high; index += 1) total += weights[index]!;
  if (!(total > 0)) return Math.round(low + probability * (high - low));
  const target = total * probability;
  let cumulative = 0;
  for (let index = low; index <= high; index += 1) {
    cumulative += weights[index]!;
    if (cumulative >= target) return index;
  }
  return high;
}

export interface CandidateLocalSwitchMode {
  readonly peak: number;
  readonly basinLow: number;
  readonly basinHigh: number;
  readonly quantileLow: number;
  readonly quantileHigh: number;
}

/**
 * Associate a raw scan candidate with one local HMM switch mode.
 *
 * `P(S_i != S_{i+1} | data)` is a collection of marginal event probabilities,
 * not a normalized posterior over one breakpoint: its sum is the expected
 * number of switches. Consequently, global quantiles mix unrelated modes. We
 * instead anchor at the scan boundary, climb to the connected local maximum,
 * stop at the posterior valleys on either side, and normalize only that basin.
 */
export function candidateLocalSwitchMode(
  weights: Float32Array,
  targetInput: number,
  searchLowInput: number,
  searchHighInput: number,
  credibleMass: number,
): CandidateLocalSwitchMode {
  if (weights.length === 0) throw new Error("A candidate-local switch mode requires at least one HMM edge.");
  const searchLow = Math.max(0, Math.min(weights.length - 1, Math.round(searchLowInput)));
  const searchHigh = Math.max(searchLow, Math.min(weights.length - 1, Math.round(searchHighInput)));
  const target = Math.max(searchLow, Math.min(searchHigh, Math.round(targetInput)));
  const smoothed = new Float64Array(weights.length);
  for (let index = searchLow; index <= searchHigh; index += 1) {
    let total = 2 * weights[index]!;
    let denominator = 2;
    if (index > searchLow) { total += weights[index - 1]!; denominator += 1; }
    if (index < searchHigh) { total += weights[index + 1]!; denominator += 1; }
    smoothed[index] = total / denominator;
  }

  let peak = target;
  for (;;) {
    const current = smoothed[peak]!;
    const left = peak > searchLow ? smoothed[peak - 1]! : -Infinity;
    const right = peak < searchHigh ? smoothed[peak + 1]! : -Infinity;
    if (left <= current && right <= current) break;
    peak += left >= right ? -1 : 1;
  }

  let basinLow = peak;
  while (basinLow > searchLow && smoothed[basinLow - 1]! <= smoothed[basinLow]!) basinLow -= 1;
  let basinHigh = peak;
  while (basinHigh < searchHigh && smoothed[basinHigh + 1]! <= smoothed[basinHigh]!) basinHigh += 1;
  const alpha = (1 - Math.max(0.5, Math.min(0.999, credibleMass))) / 2;
  return {
    peak,
    basinLow,
    basinHigh,
    quantileLow: weightedQuantile(weights, basinLow, basinHigh, alpha),
    quantileHigh: weightedQuantile(weights, basinLow, basinHigh, 1 - alpha),
  };
}

function refineGroup(
  alignment: FsartAlignment,
  rawSignals: readonly RawTripletSignal[],
  totalTests: number,
  credibleMass: number,
  rateSlices: number,
  scanWindow: number,
): RefinedTripletSignal[] {
  const stream = eventsForTriplet(alignment, rawSignals[0]!.taxa);
  const hmm = runHmm(stream, rawSignals, alignment.sites, rateSlices);
  const ordered = rawSignals.slice().sort((a, b) => a.eventBoundary - b.eventBoundary);
  return ordered.map((raw, candidateIndex) => {
    const target = Math.max(0, Math.min(hmm.trace.switchPosterior.length - 1, raw.eventBoundary - 1));
    const previous = candidateIndex === 0 ? 0 : Math.floor((ordered[candidateIndex - 1]!.eventBoundary - 1 + target) / 2) + 1;
    const nextTarget = candidateIndex + 1 === ordered.length
      ? hmm.trace.switchPosterior.length - 1
      : ordered[candidateIndex + 1]!.eventBoundary - 1;
    const next = candidateIndex + 1 === ordered.length
      ? nextTarget
      : Math.floor((target + nextTarget) / 2);
    // The candidate can only own a mode inside the informative-event window
    // that generated its G statistic, additionally clipped at neighboring raw
    // candidates for the same triplet.
    const searchLow = Math.max(previous, raw.eventBoundary - scanWindow);
    const searchHigh = Math.min(next, raw.eventBoundary + scanWindow - 2);
    const local = candidateLocalSwitchMode(hmm.trace.switchPosterior, target, searchLow, searchHigh, credibleMass);
    const { peak, quantileLow, quantileHigh } = local;
    const breakpoint = Math.max(1, Math.min(alignment.sites - 1,
      Math.floor((stream.positions[peak]! + stream.positions[peak + 1]!) / 2) + 1));
    const intervalLow = Math.max(1, stream.positions[quantileLow]! + 1);
    const intervalHigh = Math.min(alignment.sites - 1, stream.positions[quantileHigh + 1]!);
    const adjustedLogP = Math.min(0, raw.logP + Math.log(Math.max(1, totalTests)));
    return {
      ...raw,
      breakpoint,
      taxaNames: [alignment.names[raw.taxa[0]]!, alignment.names[raw.taxa[1]]!, alignment.names[raw.taxa[2]]!],
      rawP: Math.exp(raw.logP),
      adjustedP: Math.exp(adjustedLogP),
      evidence: -raw.logP / LOG_TEN,
      intervalLow: Math.min(intervalLow, intervalHigh),
      intervalHigh: Math.max(intervalLow, intervalHigh),
      switchPosterior: hmm.trace.switchPosterior[peak]!,
      emissionAccuracy: hmm.emissionAccuracy,
      switchingRates: hmm.rates,
      trace: hmm.trace,
    };
  });
}

export function refineTripletSignals(
  alignment: FsartAlignment,
  rawSignals: readonly RawTripletSignal[],
  totalTests: number,
  options: FsartRefinementOptions = {},
): RefinedTripletSignal[] {
  const maximum = Math.max(1, Math.min(10_000, Math.round(options.maximumReportedSignals ?? 256)));
  const credibleMass = Math.max(0.5, Math.min(0.999, options.credibleMass ?? 0.95));
  const rateSlices = Math.max(3, Math.min(25, Math.round(options.rateSlices ?? 9)));
  const scanWindow = Math.max(4, Math.min(256, Math.round(options.window ?? 24)));
  const sorted = rawSignals.slice().sort((a, b) => a.logP - b.logP);
  // This is candidate generation, not a family-wise hypothesis test. Refine a
  // bounded evidence-ranked list without a Bonferroni admission gate. Reserve
  // half the budget for spatially distinct modes so corroborating triplets at
  // one huge peak cannot crowd weaker breakpoints out of the tree search.
  const distinctBudget = Math.max(1, Math.floor(maximum / 2));
  const separation = Math.max(2, Math.round(options.mergeDistance ?? 12));
  const selected: RawTripletSignal[] = [];
  const selectedSet = new Set<RawTripletSignal>();
  for (const signal of sorted) {
    if (selected.some((value) => Math.abs(value.breakpoint - signal.breakpoint) <= separation)) continue;
    selected.push(signal);
    selectedSet.add(signal);
    if (selected.length >= distinctBudget) break;
  }
  for (const signal of sorted) {
    if (selectedSet.has(signal)) continue;
    selected.push(signal);
    if (selected.length >= maximum) break;
  }
  const groups = new Map<string, RawTripletSignal[]>();
  for (const signal of selected) {
    const key = signal.taxa.join(":");
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [signal]);
    else group.push(signal);
  }
  const output: RefinedTripletSignal[] = [];
  let completed = 0;
  for (const group of groups.values()) {
    options.signal?.throwIfAborted();
    output.push(...refineGroup(alignment, group, totalTests, credibleMass, rateSlices, scanWindow));
    completed += 1;
    options.onProgress?.(completed / groups.size, {
      message: `${completed.toLocaleString()} / ${groups.size.toLocaleString()} triplet HMMs · switching rate marginalized over ${rateSlices} slices`,
      current: completed,
      total: groups.size,
      metricLabel: "refined signals",
      metricValue: output.length,
    });
  }
  return output.sort((a, b) => b.evidence - a.evidence);
}

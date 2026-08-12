import { informationCriterion } from "./stepwise.js";
import { searchTreeHmmSubsets } from "./tree-hmm-search.js";
import { decodeTreeHmmViterbi } from "./tree-hmm-viterbi.js";
import type {
  InformationCriterion,
  TreeEmissionProfile,
  TreeHmmOptions,
  TreeHmmRateSlice,
  TreeHmmResult,
  TreeHmmSearchStep,
  TreeHmmSwitchInterval,
} from "./types.js";

const COLORS = ["#176b87", "#d5673f", "#6e56cf", "#25856f", "#bd4668", "#8a6a1f", "#5072b8", "#7d5685", "#4f7b3a", "#b65c2f"] as const;

interface ForwardBackwardResult {
  readonly logLikelihood: number;
  readonly posterior: Float32Array;
  readonly switchPosterior: Float32Array;
  readonly resetCounts: Float64Array;
}

interface RateFit {
  readonly expectedResets: number;
  readonly transitionProbability: number;
  readonly logLikelihood: number;
  readonly weights: Float64Array;
  readonly forwardBackward: ForwardBackwardResult;
}

interface SubsetFit {
  readonly indexes: readonly number[];
  readonly logLikelihood: number;
  readonly integratedLogEvidence: number;
  readonly criterionValue: number;
  readonly parameterCount: number;
  readonly posterior: Float32Array;
  readonly switchPosterior: Float32Array;
  readonly weights: Float64Array;
  readonly rates: readonly TreeHmmRateSlice[];
}

function logSumExp(values: readonly number[]): number {
  const maximum = Math.max(...values);
  if (!Number.isFinite(maximum)) return maximum;
  let total = 0;
  for (const value of values) total += Math.exp(value - maximum);
  return maximum + Math.log(total);
}

function normalizedEmissions(profiles: readonly TreeEmissionProfile[], sites: number): {
  readonly values: Float64Array;
  readonly offsets: Float64Array;
} {
  const states = profiles.length;
  const values = new Float64Array(states * sites);
  const offsets = new Float64Array(sites);
  for (let site = 0; site < sites; site += 1) {
    let maximum = -Infinity;
    for (let state = 0; state < states; state += 1) {
      const value = Number(profiles[state]!.siteLogLikelihoods[site]);
      if (Number.isFinite(value) && value > maximum) maximum = value;
    }
    if (!Number.isFinite(maximum)) maximum = 0;
    offsets[site] = maximum;
    for (let state = 0; state < states; state += 1) {
      const value = Number(profiles[state]!.siteLogLikelihoods[site]);
      values[state * sites + site] = Number.isFinite(value) ? Math.exp(Math.max(-745, value - maximum)) : 0;
    }
  }
  return { values, offsets };
}

/**
 * O(LK) forward/backward for T = (1-q)I + q 1w'. The reset form is the
 * same algebraic shortcut used by CHMMera's symmetric topology HMM, extended
 * to fitted stationary tree weights without materializing a K-by-K matrix.
 */
function forwardBackward(
  emissions: Float64Array,
  offsets: Float64Array,
  sites: number,
  states: number,
  transitionProbability: number,
  weights: Float64Array,
): ForwardBackwardResult {
  const alpha = new Float64Array(states * sites);
  const scales = new Float64Array(sites);
  let scale = 0;
  for (let state = 0; state < states; state += 1) {
    const value = weights[state]! * emissions[state * sites]!;
    alpha[state * sites] = value;
    scale += value;
  }
  if (!(scale > 0)) scale = Number.MIN_VALUE;
  scales[0] = scale;
  for (let state = 0; state < states; state += 1) alpha[state * sites] = alpha[state * sites]! / scale;
  let logLikelihood = offsets[0]! + Math.log(scale);
  const stay = 1 - transitionProbability;
  for (let site = 1; site < sites; site += 1) {
    scale = 0;
    for (let state = 0; state < states; state += 1) {
      const previous = alpha[state * sites + site - 1]!;
      const value = emissions[state * sites + site]! * (stay * previous + transitionProbability * weights[state]!);
      alpha[state * sites + site] = value;
      scale += value;
    }
    if (!(scale > 0)) scale = Number.MIN_VALUE;
    scales[site] = scale;
    for (let state = 0; state < states; state += 1) alpha[state * sites + site] = alpha[state * sites + site]! / scale;
    logLikelihood += offsets[site]! + Math.log(scale);
  }

  const beta = new Float64Array(states * sites);
  for (let state = 0; state < states; state += 1) beta[state * sites + sites - 1] = 1;
  for (let site = sites - 2; site >= 0; site -= 1) {
    let resetDestination = 0;
    for (let destination = 0; destination < states; destination += 1) {
      resetDestination += weights[destination]!
        * emissions[destination * sites + site + 1]!
        * beta[destination * sites + site + 1]!;
    }
    const divisor = scales[site + 1]!;
    for (let state = 0; state < states; state += 1) {
      const same = emissions[state * sites + site + 1]! * beta[state * sites + site + 1]!;
      beta[state * sites + site] = (stay * same + transitionProbability * resetDestination) / divisor;
    }
  }

  const posterior = new Float32Array(states * sites);
  for (let site = 0; site < sites; site += 1) {
    let total = 0;
    for (let state = 0; state < states; state += 1) total += alpha[state * sites + site]! * beta[state * sites + site]!;
    const inverse = total > 0 ? 1 / total : 1 / states;
    for (let state = 0; state < states; state += 1) posterior[state * sites + site] = alpha[state * sites + site]! * beta[state * sites + site]! * inverse;
  }

  const switchPosterior = new Float32Array(Math.max(0, sites - 1));
  const resetCounts = new Float64Array(states);
  for (let state = 0; state < states; state += 1) resetCounts[state] = posterior[state * sites]!;
  for (let site = 0; site + 1 < sites; site += 1) {
    let resetDestination = 0;
    let sameReset = 0;
    const divisor = scales[site + 1]!;
    for (let destination = 0; destination < states; destination += 1) {
      const future = emissions[destination * sites + site + 1]! * beta[destination * sites + site + 1]!;
      const destinationMass = weights[destination]! * future;
      resetDestination += destinationMass;
      sameReset += alpha[destination * sites + site]! * destinationMass;
      resetCounts[destination] = resetCounts[destination]! + transitionProbability * destinationMass / divisor;
    }
    switchPosterior[site] = Math.max(0, Math.min(1,
      transitionProbability * (resetDestination - sameReset) / divisor,
    ));
  }
  return { logLikelihood, posterior, switchPosterior, resetCounts };
}

function optimizeWeights(
  emissions: Float64Array,
  offsets: Float64Array,
  sites: number,
  states: number,
  transitionProbability: number,
  maximumIterations: number,
): { readonly weights: Float64Array; readonly result: ForwardBackwardResult } {
  let weights = new Float64Array(states).fill(1 / states);
  let result = forwardBackward(emissions, offsets, sites, states, transitionProbability, weights);
  const pseudoCount = 0.05;
  for (let iteration = 0; iteration < maximumIterations; iteration += 1) {
    const total = result.resetCounts.reduce((sum, value) => sum + value, 0) + pseudoCount * states;
    const updated = new Float64Array(states);
    let maximumChange = 0;
    for (let state = 0; state < states; state += 1) {
      updated[state] = (result.resetCounts[state]! + pseudoCount) / total;
      maximumChange = Math.max(maximumChange, Math.abs(updated[state]! - weights[state]!));
    }
    weights = updated;
    result = forwardBackward(emissions, offsets, sites, states, transitionProbability, weights);
    if (maximumChange < 1e-5) break;
  }
  return { weights, result };
}

function rateGrid(sites: number, states: number, maximumSlices: number): number[] {
  if (states <= 1 || sites <= 1) return [0];
  const slices = Math.max(5, Math.min(25, Math.round(maximumSlices)));
  const maximum = Math.min(64, Math.max(8, 4 * (states - 1)));
  const values = [0];
  for (let index = 0; index < slices - 1; index += 1) {
    const fraction = index / Math.max(1, slices - 2);
    values.push(0.25 * Math.exp(fraction * Math.log(maximum / 0.25)));
  }
  return Array.from(new Set(values.map((value) => Number(value.toPrecision(8))))).sort((a, b) => a - b);
}

function treeHmmParameterCount(taxa: number, states: number): number {
  if (states <= 1) return 2 * taxa + 6;
  // Shared: 5 GTR rates + 3 frequencies. Per tree: 2n-3 branch lengths
  // and one Gamma shape. HMM: K-1 stationary weights and one switch rate.
  return 8 + states * (2 * taxa - 2) + (states - 1) + 1;
}

function fitSubset(
  allProfiles: readonly TreeEmissionProfile[],
  indexes: readonly number[],
  options: TreeHmmOptions,
  progress?: (completed: number, total: number, fit: RateFit) => void,
): SubsetFit {
  const profiles = indexes.map((index) => allProfiles[index]!);
  const sites = profiles[0]!.siteLogLikelihoods.length;
  const states = profiles.length;
  const { values: emissions, offsets } = normalizedEmissions(profiles, sites);
  const grid = rateGrid(sites, states, options.maximumRateSlices ?? 13);
  const fits: RateFit[] = grid.map((expectedResets, rateIndex) => {
    options.signal?.throwIfAborted();
    const transitionProbability = sites <= 1 ? 0 : 1 - Math.exp(-expectedResets / (sites - 1));
    const optimized = optimizeWeights(
      emissions,
      offsets,
      sites,
      states,
      transitionProbability,
      Math.max(1, Math.min(20, Math.round(options.maximumWeightIterations ?? 8))),
    );
    const fit = {
      expectedResets,
      transitionProbability,
      logLikelihood: optimized.result.logLikelihood,
      weights: optimized.weights,
      forwardBackward: optimized.result,
    };
    progress?.(rateIndex + 1, grid.length, fit);
    return fit;
  });
  const logLikelihoods = fits.map((fit) => fit.logLikelihood);
  const normalizer = logSumExp(logLikelihoods);
  const integratedLogEvidence = normalizer - Math.log(fits.length);
  const ratePosterior = logLikelihoods.map((value) => Math.exp(value - normalizer));
  const posterior = new Float32Array(states * sites);
  const switchPosterior = new Float32Array(Math.max(0, sites - 1));
  const weights = new Float64Array(states);
  for (let rateIndex = 0; rateIndex < fits.length; rateIndex += 1) {
    const fit = fits[rateIndex]!;
    const mass = ratePosterior[rateIndex]!;
    for (let index = 0; index < posterior.length; index += 1) posterior[index] = posterior[index]! + mass * fit.forwardBackward.posterior[index]!;
    for (let index = 0; index < switchPosterior.length; index += 1) switchPosterior[index] = switchPosterior[index]! + mass * fit.forwardBackward.switchPosterior[index]!;
    for (let state = 0; state < states; state += 1) weights[state] = weights[state]! + mass * fit.weights[state]!;
  }
  const parameterCount = treeHmmParameterCount(options.taxa, states);
  const maximumLogLikelihood = Math.max(...logLikelihoods);
  const criterion = options.criterion ?? "aicc";
  return {
    indexes,
    logLikelihood: maximumLogLikelihood,
    integratedLogEvidence,
    criterionValue: informationCriterion(criterion, maximumLogLikelihood, parameterCount, sites),
    parameterCount,
    posterior,
    switchPosterior,
    weights,
    rates: fits.map((fit, index) => ({
      expectedResets: fit.expectedResets,
      transitionProbability: fit.transitionProbability,
      logLikelihood: fit.logLikelihood,
      posterior: ratePosterior[index]!,
    })),
  };
}

function posteriorOccupancies(posterior: Float32Array, states: number, sites: number): Float64Array {
  const output = new Float64Array(states);
  for (let state = 0; state < states; state += 1) {
    let total = 0;
    for (let site = 0; site < sites; site += 1) total += posterior[state * sites + site]!;
    output[state] = total;
  }
  return output;
}

function switchIntervals(values: Float32Array, credibleMass: number, maximumIntervals: number): TreeHmmSwitchInterval[] {
  if (values.length === 0) return [];
  const smooth = new Float64Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    let weighted = 0;
    let weight = 0;
    for (let offset = -2; offset <= 2; offset += 1) {
      const at = index + offset;
      if (at < 0 || at >= values.length) continue;
      const kernel = 3 - Math.abs(offset);
      weighted += kernel * values[at]!;
      weight += kernel;
    }
    smooth[index] = weighted / weight;
  }
  const maximum = Math.max(...smooth);
  if (!(maximum > 1e-5)) return [];
  const candidates: number[] = [];
  for (let index = 0; index < smooth.length; index += 1) {
    if (smooth[index]! >= Math.max(0.0025, maximum * 0.04)
      && smooth[index]! >= (smooth[index - 1] ?? -Infinity)
      && smooth[index]! >= (smooth[index + 1] ?? -Infinity)) candidates.push(index);
  }
  const separation = Math.max(3, Math.round(values.length * 0.003));
  const localPeaks: number[] = [];
  for (const candidate of candidates.sort((a, b) => smooth[b]! - smooth[a]!)) {
    if (localPeaks.some((peak) => Math.abs(peak - candidate) < separation)) continue;
    localPeaks.push(candidate);
  }
  const mergeRadius = Math.max(separation, Math.min(120, Math.round(values.length * 0.04)));
  const peakClusters: number[][] = [];
  for (const peak of localPeaks.sort((a, b) => a - b)) {
    const cluster = peakClusters.at(-1);
    if (cluster === undefined || peak - cluster.at(-1)! > mergeRadius) peakClusters.push([peak]);
    else cluster.push(peak);
  }
  const peaks = peakClusters
    .map((cluster) => cluster.reduce((best, peak) => smooth[peak]! > smooth[best]! ? peak : best))
    .sort((a, b) => smooth[b]! - smooth[a]!)
    .slice(0, maximumIntervals)
    .sort((a, b) => a - b);
  if (peaks.length === 0) return [];
  const separators: number[] = [];
  for (let index = 0; index + 1 < peaks.length; index += 1) {
    let minimumAt = peaks[index]!;
    for (let at = peaks[index]! + 1; at < peaks[index + 1]!; at += 1) {
      if (smooth[at]! < smooth[minimumAt]!) minimumAt = at;
    }
    separators.push(minimumAt);
  }
  const tail = (1 - Math.max(0.5, Math.min(0.999, credibleMass))) / 2;
  const sortedSmooth = Array.from(smooth).sort((a, b) => a - b);
  const background = sortedSmooth[Math.floor(0.2 * Math.max(0, sortedSmooth.length - 1))] ?? 0;
  const intervals = peaks.map((peak, index) => {
    const separatorLow = index === 0 ? 0 : separators[index - 1]! + 1;
    const separatorHigh = index + 1 === peaks.length ? values.length - 1 : separators[index]!;
    // Condition uncertainty on this prominent switch mode rather than letting
    // thousands of tiny diffuse reset probabilities dominate a nominal 95%
    // interval. The 2% prominence contour is only a basin delimiter; quantiles
    // inside the basin still use the actual posterior mass.
    const modeFloor = background + 0.02 * Math.max(0, smooth[peak]! - background);
    let low = peak;
    let high = peak;
    while (low > separatorLow && smooth[low - 1]! >= modeFloor) low -= 1;
    while (high < separatorHigh && smooth[high + 1]! >= modeFloor) high += 1;
    let total = 0;
    let excessTotal = 0;
    for (let at = low; at <= high; at += 1) total += values[at]!;
    for (let at = low; at <= high; at += 1) excessTotal += Math.max(0, values[at]! - background);
    let cumulative = 0;
    let intervalLow = low;
    let intervalHigh = high;
    const intervalMass = excessTotal > 0 ? excessTotal : total;
    if (intervalMass > 0) {
      for (let at = low; at <= high; at += 1) {
        cumulative += (excessTotal > 0 ? Math.max(0, values[at]! - background) : values[at]!) / intervalMass;
        if (cumulative >= tail) { intervalLow = at; break; }
      }
      cumulative = 0;
      for (let at = low; at <= high; at += 1) {
        cumulative += (excessTotal > 0 ? Math.max(0, values[at]! - background) : values[at]!) / intervalMass;
        if (cumulative >= 1 - tail) { intervalHigh = at; break; }
      }
    }
    return {
      rank: 0,
      breakpoint: peak + 1,
      intervalLow: intervalLow + 1,
      intervalHigh: intervalHigh + 1,
      peakProbability: values[peak]!,
      expectedSwitchMass: total,
      excessMass: excessTotal,
    };
  });
  const totalExcessMass = intervals.reduce((sum, value) => sum + value.excessMass, 0);
  const minimumModeMass = Math.min(0.1, totalExcessMass * 0.1);
  return intervals.filter((value) => value.excessMass >= minimumModeMass)
    .sort((a, b) => b.peakProbability - a.peakProbability)
    .map(({ excessMass: _excessMass, ...value }, index) => ({ ...value, rank: index + 1 }));
}

export function skippedTreeHmm(message: string, criterion: InformationCriterion = "aicc"): TreeHmmResult {
  return {
    status: "skipped",
    criterion,
    criterionValue: null,
    nullCriterionValue: null,
    deltaCriterion: null,
    logLikelihood: null,
    integratedLogEvidence: null,
    nullLogLikelihood: null,
    parameterCount: null,
    nullParameterCount: null,
    sites: 0,
    states: [],
    statePosterior: new Float32Array(),
    mapState: new Uint16Array(),
    switchPosterior: new Float32Array(),
    switchIntervals: [],
    switchingRates: [],
    expectedSwitches: 0,
    searchSteps: [],
    fastTreeMs: 0,
    hmmMs: 0,
    message,
  };
}

export function fitTreeHmm(profiles: readonly TreeEmissionProfile[], options: TreeHmmOptions): TreeHmmResult {
  if (profiles.length === 0) return skippedTreeHmm("No fixed-topology likelihood profiles were available.", options.criterion);
  const sites = profiles[0]!.siteLogLikelihoods.length;
  if (sites < 2 || profiles.some((profile) => profile.siteLogLikelihoods.length !== sites)) {
    throw new Error("Tree-HMM emission profiles must have the same alignment length (at least two sites).\n");
  }
  const started = performance.now();
  const criterion = options.criterion ?? "aicc";
  const searchMode = options.searchMode ?? "rapid";
  options.onProgress?.(0, { message: "Topology HMM: initializing the one-tree null", indeterminate: true });
  const nullFit = fitSubset(profiles, [0], options, (completed, total, fit) => options.onProgress?.(
    0.08 * completed / total,
    {
      message: `One-tree null · switching-rate slice ${completed}/${total}`,
      current: completed,
      total,
      metricLabel: "log L",
      metricValue: fit.logLikelihood,
    },
  ));
  const allIndexes = profiles.map((_profile, index) => index);
  const requestedIndexes = options.selectedIndexes === undefined
    ? allIndexes
    : Array.from(new Set(options.selectedIndexes.filter((index) => Number.isInteger(index) && index >= 0 && index < profiles.length))).sort((a, b) => a - b);
  const subsetSearch = searchMode === "rapid" && profiles.length > 1
    ? searchTreeHmmSubsets(profiles, {
      ...options,
      onProgress: (fraction, detail) => options.onProgress?.(0.08 + 0.30 * fraction, detail),
    })
    : undefined;
  const initialIndexes = subsetSearch?.selectedProfileIndexes ?? (requestedIndexes.length > 0 ? requestedIndexes : [0]);
  options.onProgress?.(0.38, { message: `Exact forward/backward fit for ${initialIndexes.length} selected topologies`, current: 0, total: initialIndexes.length });
  let current = fitSubset(profiles, initialIndexes, options, (completed, total, fit) => options.onProgress?.(
    0.38 + 0.24 * completed / total,
    {
      message: `Exact ${initialIndexes.length}-state model · switching-rate slice ${completed}/${total}`,
      current: completed,
      total,
      metricLabel: "log L",
      metricValue: fit.logLikelihood,
    },
  ));
  const searchSteps: TreeHmmSearchStep[] = [];
  let searchRound = 0;
  while (searchMode !== "fixed" && current.indexes.length > 1) {
    options.signal?.throwIfAborted();
    const occupancy = posteriorOccupancies(current.posterior, current.indexes.length, sites);
    const removableIndexes = searchMode === "backward"
      ? current.indexes.filter((profileIndex) => profileIndex !== 0)
      : current.indexes;
    const removals = removableIndexes.map((profileIndex) => {
      const localIndex = current.indexes.indexOf(profileIndex);
      return { profileIndex, localIndex, expectedSites: occupancy[localIndex]! };
    }).sort((a, b) => a.expectedSites - b.expectedSites);
    if (removals.length === 0) break;
    let best: { readonly removal: typeof removals[number]; readonly fit: SubsetFit } | undefined;
    for (let index = 0; index < removals.length; index += 1) {
      const removal = removals[index]!;
      const subset = current.indexes.filter((value) => value !== removal.profileIndex);
      const fit = fitSubset(profiles, subset, options, (completed, total, rateFit) => {
        const searchFraction = (searchRound + (index + completed / total) / removals.length)
          / Math.max(1, initialIndexes.length - 1);
        options.onProgress?.(Math.min(0.985, 0.62 + 0.36 * searchFraction), {
          message: `Exact floating cleanup · ${current.indexes.length} states · removal ${index + 1}/${removals.length} · rate ${completed}/${total}`,
          current: initialIndexes.length - current.indexes.length,
          total: Math.max(1, initialIndexes.length - 1),
          metricLabel: "log L",
          metricValue: rateFit.logLikelihood,
        });
      });
      if (best === undefined || fit.criterionValue < best.fit.criterionValue) best = { removal, fit };
    }
    if (best === undefined) break;
    const accepted = best.fit.criterionValue + 1e-8 < current.criterionValue;
    searchSteps.push({
      treeCountBefore: current.indexes.length,
      removedTreeId: profiles[best.removal.profileIndex]!.id,
      removedExpectedSites: best.removal.expectedSites,
      criterionBefore: current.criterionValue,
      criterionAfter: best.fit.criterionValue,
      accepted,
    });
    if (!accepted) break;
    current = best.fit;
    searchRound += 1;
  }

  const occupancy = posteriorOccupancies(current.posterior, current.indexes.length, sites);
  const mapState = new Uint16Array(sites);
  for (let site = 0; site < sites; site += 1) {
    let best = 0;
    for (let state = 1; state < current.indexes.length; state += 1) {
      if (current.posterior[state * sites + site]! > current.posterior[best * sites + site]!) best = state;
    }
    mapState[site] = best;
  }
  const intervals = switchIntervals(current.switchPosterior, options.credibleMass ?? 0.95, Math.min(32, 4 * current.indexes.length + 4));
  options.onProgress?.(1, {
    message: `${current.indexes.length}/${profiles.length} topology states retained · ${intervals.length} switch mode${intervals.length === 1 ? "" : "s"}`,
    current: initialIndexes.length - current.indexes.length,
    total: Math.max(1, initialIndexes.length - 1),
    metricLabel: criterion.toUpperCase(),
    metricValue: current.criterionValue,
  });
  const hmmMs = performance.now() - started;
  const states = current.indexes.map((profileIndex, state) => {
    const profile = profiles[profileIndex]!;
    return {
      id: profile.id,
      tree: profile.tree,
      topologySignature: profile.topologySignature,
      sourceStart: profile.sourceStart,
      sourceEnd: profile.sourceEnd,
      ...(profile.sourceRanges === undefined ? {} : { sourceRanges: profile.sourceRanges }),
      weight: current.weights[state]!,
      occupancy: occupancy[state]! / sites,
      expectedSites: occupancy[state]!,
      color: COLORS[state % COLORS.length]!,
    };
  });
  const output: TreeHmmResult = {
    status: "complete",
    criterion,
    criterionValue: current.criterionValue,
    nullCriterionValue: nullFit.criterionValue,
    deltaCriterion: nullFit.criterionValue - current.criterionValue,
    logLikelihood: current.logLikelihood,
    integratedLogEvidence: current.integratedLogEvidence,
    nullLogLikelihood: nullFit.logLikelihood,
    parameterCount: current.parameterCount,
    nullParameterCount: nullFit.parameterCount,
    sites,
    states,
    statePosterior: current.posterior,
    mapState,
    switchPosterior: current.switchPosterior,
    switchIntervals: intervals,
    switchingRates: current.rates,
    expectedSwitches: current.switchPosterior.reduce((sum, value) => sum + value, 0),
    searchSteps,
    ...(subsetSearch === undefined ? {} : { subsetSearch }),
    fastTreeMs: profiles.reduce((sum, profile) => sum + profile.elapsedMs, 0),
    hmmMs,
  };
  const viterbi = decodeTreeHmmViterbi(profiles, output, options.minimumRunLength ?? 1);
  return viterbi === undefined ? output : { ...output, viterbi };
}

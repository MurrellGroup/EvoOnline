import { forwardBackward, normalizedEmissions, type ForwardBackwardResult } from "./tree-hmm.js";
import { decodeTreeHmmViterbiParameters } from "./tree-hmm-viterbi.js";
import type {
  TreeEmissionProfile,
  TreeHmmExplorationOptions,
  TreeHmmExplorationResult,
  TreeHmmState,
  TreeHmmViterbiResult,
} from "./types.js";

const COLORS = [
  "#176b87", "#d5673f", "#6e56cf", "#25856f", "#bd4668", "#8a6a1f",
  "#5072b8", "#7d5685", "#4f7b3a", "#b65c2f", "#277b9c", "#9c4f78",
] as const;

interface ActiveFit {
  readonly indexes: readonly number[];
  readonly profiles: readonly TreeEmissionProfile[];
  readonly weights: Float64Array;
  readonly forwardBackward: ForwardBackwardResult;
  readonly viterbi: TreeHmmViterbiResult;
}

function digamma(raw: number): number {
  let value = Math.max(1e-10, raw);
  let output = 0;
  while (value < 8) {
    output -= 1 / value;
    value += 1;
  }
  const inverse = 1 / value;
  const inverse2 = inverse * inverse;
  return output + Math.log(value) - 0.5 * inverse
    - inverse2 * (1 / 12 - inverse2 * (1 / 120 - inverse2 / 252));
}

function normalize(values: Float64Array): Float64Array {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) return new Float64Array(values.length).fill(1 / Math.max(1, values.length));
  for (let index = 0; index < values.length; index += 1) values[index] = values[index]! / total;
  return values;
}

function occupancy(posterior: Float32Array, states: number, sites: number): Float64Array {
  const output = new Float64Array(states);
  for (let state = 0; state < states; state += 1) {
    let total = 0;
    for (let site = 0; site < sites; site += 1) total += posterior[state * sites + site]!;
    output[state] = total;
  }
  return output;
}

function mapStates(posterior: Float32Array, states: number, sites: number): Uint16Array {
  const output = new Uint16Array(sites);
  for (let site = 0; site < sites; site += 1) {
    let best = 0;
    for (let state = 1; state < states; state += 1) {
      if (posterior[state * sites + site]! > posterior[best * sites + site]!) best = state;
    }
    output[site] = best;
  }
  return output;
}

function evaluate(
  allProfiles: readonly TreeEmissionProfile[],
  indexes: readonly number[],
  rawWeights: Float64Array,
  transitionProbability: number,
  expectedResets: number,
  minimumRunLength: number,
): ActiveFit {
  const profiles = indexes.map((index) => allProfiles[index]!);
  const sites = profiles[0]!.siteLogLikelihoods.length;
  const weights = normalize(Float64Array.from(rawWeights));
  const normalized = normalizedEmissions(profiles, sites);
  const fitted = forwardBackward(
    normalized.values,
    normalized.offsets,
    sites,
    profiles.length,
    transitionProbability,
    weights,
  );
  const viterbi = decodeTreeHmmViterbiParameters(
    profiles,
    weights,
    transitionProbability,
    minimumRunLength,
    expectedResets,
  );
  return { indexes, profiles, weights, forwardBackward: fitted, viterbi };
}

function fixedViterbiRetention(
  profiles: readonly TreeEmissionProfile[],
  transitionProbability: number,
  expectedResets: number,
  minimumRunLength: number,
): { readonly fit: ActiveFit; readonly iterations: number; readonly converged: boolean } {
  let indexes = profiles.map((_profile, index) => index);
  let fit = evaluate(
    profiles,
    indexes,
    new Float64Array(indexes.length).fill(1 / indexes.length),
    transitionProbability,
    expectedResets,
    minimumRunLength,
  );
  for (let iteration = 1; iteration <= Math.min(16, profiles.length + 1); iteration += 1) {
    const used = Array.from(new Set(fit.viterbi.statePath)).sort((a, b) => a - b);
    if (used.length === fit.profiles.length) return { fit, iterations: iteration, converged: true };
    indexes = used.map((local) => fit.indexes[local]!);
    fit = evaluate(
      profiles,
      indexes,
      new Float64Array(indexes.length).fill(1 / indexes.length),
      transitionProbability,
      expectedResets,
      minimumRunLength,
    );
  }
  return { fit, iterations: Math.min(16, profiles.length + 1), converged: false };
}

function sparseDirichletFit(
  profiles: readonly TreeEmissionProfile[],
  transitionProbability: number,
  expectedResets: number,
  concentration: number,
  maximumIterations: number,
  minimumRunLength: number,
  pruningWeight: number,
): { readonly fit: ActiveFit; readonly iterations: number; readonly converged: boolean } {
  let indexes = profiles.map((_profile, index) => index);
  let weights: Float64Array<ArrayBufferLike> = new Float64Array(indexes.length).fill(1 / indexes.length);
  let totalIterations = 0;
  let converged = false;
  let fit = evaluate(profiles, indexes, weights, transitionProbability, expectedResets, minimumRunLength);
  for (let pruningRound = 0; pruningRound < Math.min(12, profiles.length); pruningRound += 1) {
    converged = false;
    for (let iteration = 0; iteration < maximumIterations; iteration += 1) {
      totalIterations += 1;
      const logWeights = new Float64Array(indexes.length);
      let maximum = -Infinity;
      for (let state = 0; state < indexes.length; state += 1) {
        logWeights[state] = digamma(concentration + fit.forwardBackward.resetCounts[state]!);
        maximum = Math.max(maximum, logWeights[state]!);
      }
      const updated = new Float64Array(indexes.length);
      let maximumChange = 0;
      for (let state = 0; state < indexes.length; state += 1) {
        updated[state] = Math.exp(Math.max(-745, logWeights[state]! - maximum));
      }
      normalize(updated);
      for (let state = 0; state < indexes.length; state += 1) {
        maximumChange = Math.max(maximumChange, Math.abs(updated[state]! - weights[state]!));
      }
      weights = updated;
      fit = evaluate(profiles, indexes, weights, transitionProbability, expectedResets, minimumRunLength);
      if (maximumChange < 1e-6) {
        converged = true;
        break;
      }
    }
    if (indexes.length <= 1) break;
    const expectedSites = occupancy(fit.forwardBackward.posterior, indexes.length, fit.profiles[0]!.siteLogLikelihoods.length);
    const viterbiStates = new Set(fit.viterbi.statePath);
    const retainedLocal = indexes.map((_value, state) => state).filter((state) =>
      viterbiStates.has(state) || (weights[state]! >= pruningWeight && expectedSites[state]! >= 0.5),
    );
    if (retainedLocal.length === indexes.length) break;
    if (retainedLocal.length === 0) {
      let best = 0;
      for (let state = 1; state < weights.length; state += 1) if (weights[state]! > weights[best]!) best = state;
      retainedLocal.push(best);
    }
    indexes = retainedLocal.map((local) => indexes[local]!);
    weights = normalize(Float64Array.from(retainedLocal, (local) => weights[local]!));
    fit = evaluate(profiles, indexes, weights, transitionProbability, expectedResets, minimumRunLength);
  }
  return { fit, iterations: totalIterations, converged };
}

export function exploreTreeHmm(
  profiles: readonly TreeEmissionProfile[],
  options: TreeHmmExplorationOptions,
): TreeHmmExplorationResult {
  const started = performance.now();
  if (profiles.length === 0) throw new Error("Interactive topology-HMM exploration requires the cached draft tree family.");
  const sites = profiles[0]!.siteLogLikelihoods.length;
  if (sites < 2 || profiles.some((profile) => profile.siteLogLikelihoods.length !== sites)) {
    throw new Error("Interactive topology-HMM profiles must share an alignment length of at least two sites.");
  }
  const expectedResets = Math.max(0, Math.min(256, Number(options.expectedResets)));
  const transitionProbability = profiles.length <= 1 ? 0 : 1 - Math.exp(-expectedResets / (sites - 1));
  const minimumRunLength = Math.max(1, Math.min(Math.floor(sites / 2), Math.round(options.minimumRunLength ?? 30)));
  const concentration = Math.max(1e-4, Math.min(10, Number(options.dirichletConcentration ?? 0.05)));
  const fitted = options.mode === "fixed-low-switch"
    ? fixedViterbiRetention(profiles, transitionProbability, expectedResets, minimumRunLength)
    : sparseDirichletFit(
      profiles,
      transitionProbability,
      expectedResets,
      concentration,
      Math.max(2, Math.min(100, Math.round(options.maximumIterations ?? 40))),
      minimumRunLength,
      Math.max(1e-8, Math.min(0.1, Number(options.pruningWeight ?? 1e-4))),
    );
  const fit = fitted.fit;
  const expectedSites = occupancy(fit.forwardBackward.posterior, fit.profiles.length, sites);
  const states: TreeHmmState[] = fit.profiles.map((profile, state) => ({
    id: profile.id,
    tree: profile.tree,
    topologySignature: profile.topologySignature,
    sourceStart: profile.sourceStart,
    sourceEnd: profile.sourceEnd,
    ...(profile.sourceRanges === undefined ? {} : { sourceRanges: profile.sourceRanges }),
    weight: fit.weights[state]!,
    occupancy: expectedSites[state]! / sites,
    expectedSites: expectedSites[state]!,
    color: COLORS[fit.indexes[state]! % COLORS.length]!,
  }));
  const active = new Set(fit.indexes);
  const droppedTreeIds = profiles.filter((_profile, index) => !active.has(index)).map((profile) => profile.id);
  const modeLabel = options.mode === "fixed-low-switch"
    ? "Fixed switching prior with iterative Viterbi-only tree retention"
    : "Sparse symmetric-Dirichlet variational EM over post-reset tree frequencies";
  return {
    status: "complete",
    mode: options.mode,
    sites,
    draftStateCount: profiles.length,
    states,
    statePosterior: fit.forwardBackward.posterior,
    mapState: mapStates(fit.forwardBackward.posterior, states.length, sites),
    switchPosterior: fit.forwardBackward.switchPosterior,
    expectedSwitches: fit.forwardBackward.switchPosterior.reduce((sum, value) => sum + value, 0),
    expectedResets,
    transitionProbability,
    logLikelihood: fit.forwardBackward.logLikelihood,
    viterbi: fit.viterbi,
    iterations: fitted.iterations,
    converged: fitted.converged,
    droppedTreeIds,
    ...(options.mode === "sparse-dirichlet" ? { dirichletConcentration: concentration } : {}),
    elapsedMs: performance.now() - started,
    message: `${modeLabel}; retained ${states.length}/${profiles.length} draft topologies without a subset search or a new tree fit.`,
  };
}

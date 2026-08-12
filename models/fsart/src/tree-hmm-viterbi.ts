import type { TreeEmissionProfile, TreeHmmResult, TreeHmmViterbiResult, TreeHmmViterbiRun } from "./types.js";

function runsFromPath(path: Uint16Array, treeIds: readonly string[]): TreeHmmViterbiRun[] {
  if (path.length === 0) return [];
  const output: TreeHmmViterbiRun[] = [];
  let start = 0;
  let state = path[0]!;
  for (let site = 1; site <= path.length; site += 1) {
    if (site < path.length && path[site] === state) continue;
    output.push({ start: start + 1, end: site, state, treeId: treeIds[state] ?? `T${state + 1}` });
    if (site < path.length) {
      start = site;
      state = path[site]!;
    }
  }
  return output;
}

function coalesceShortRuns(
  path: Uint16Array,
  profiles: readonly TreeEmissionProfile[],
  treeIds: readonly string[],
  minimumRunLength: number,
): void {
  if (minimumRunLength <= 1) return;
  for (let pass = 0; pass < path.length; pass += 1) {
    const runs = runsFromPath(path, treeIds);
    const short = runs
      .map((run, index) => ({ run, index, length: run.end - run.start + 1 }))
      .filter((value) => value.length < minimumRunLength && runs.length > 1)
      .sort((a, b) => a.length - b.length || a.run.start - b.run.start)[0];
    if (short === undefined) return;
    const alternatives = Array.from(new Set([
      runs[short.index - 1]?.state,
      runs[short.index + 1]?.state,
    ].filter((value): value is number => value !== undefined)));
    if (alternatives.length === 0) return;
    let bestState = alternatives[0]!;
    let bestScore = -Infinity;
    for (const state of alternatives) {
      let score = 0;
      for (let site = short.run.start - 1; site < short.run.end; site += 1) {
        score += Number(profiles[state]!.siteLogLikelihoods[site]);
      }
      if (score > bestScore) {
        bestScore = score;
        bestState = state;
      }
    }
    for (let site = short.run.start - 1; site < short.run.end; site += 1) path[site] = bestState;
  }
}

export function decodeTreeHmmViterbi(
  profiles: readonly TreeEmissionProfile[],
  result: TreeHmmResult,
  minimumRunLength = 1,
): TreeHmmViterbiResult | undefined {
  if (result.status !== "complete" || result.states.length === 0 || result.sites === 0) return undefined;
  const orderedProfiles = result.states.map((state) => profiles.find((profile) => profile.id === state.id));
  if (orderedProfiles.some((profile) => profile === undefined)) return undefined;
  const selected = orderedProfiles as TreeEmissionProfile[];
  const states = selected.length;
  const sites = result.sites;
  const rate = result.switchingRates.slice().sort((a, b) => b.posterior - a.posterior)[0];
  const transition = states <= 1 ? 0 : rate?.transitionProbability ?? 0;
  const weights = Float64Array.from(result.states, (state) => Math.max(1e-12, state.weight));
  return decodeTreeHmmViterbiParameters(
    selected,
    weights,
    transition,
    minimumRunLength,
    rate?.expectedResets ?? 0,
  );
}

/** Decode a sticky/reset HMM with T_ij=(1-q)I(i=j)+q*w_j in O(LK). */
export function decodeTreeHmmViterbiParameters(
  profiles: readonly TreeEmissionProfile[],
  rawWeights: ArrayLike<number>,
  transitionProbability: number,
  minimumRunLength = 1,
  expectedResets = 0,
): TreeHmmViterbiResult {
  if (profiles.length === 0) throw new Error("Viterbi decoding requires at least one tree-emission profile.");
  const sites = profiles[0]!.siteLogLikelihoods.length;
  if (sites === 0 || profiles.some((profile) => profile.siteLogLikelihoods.length !== sites)) {
    throw new Error("Viterbi tree-emission profiles must have one common, non-empty alignment length.");
  }
  const states = profiles.length;
  const transition = states <= 1 ? 0 : Math.max(0, Math.min(1 - Number.EPSILON, transitionProbability));
  const stay = 1 - transition;
  const weights = Float64Array.from({ length: states }, (_value, state) => Math.max(1e-300, Number(rawWeights[state] ?? 0)));
  const weightTotal = weights.reduce((sum, value) => sum + value, 0);
  for (let state = 0; state < states; state += 1) weights[state] = weights[state]! / weightTotal;
  let previous = new Float64Array(states);
  let current = new Float64Array(states);
  const back = new Uint16Array(states * sites);
  for (let state = 0; state < states; state += 1) {
    previous[state] = Math.log(weights[state]!) + Number(profiles[state]!.siteLogLikelihoods[0]);
  }
  for (let site = 1; site < sites; site += 1) {
    let firstState = 0;
    let secondState = states > 1 ? 1 : 0;
    if (previous[secondState]! > previous[firstState]!) [firstState, secondState] = [secondState, firstState];
    for (let state = 0; state < states; state += 1) {
      if (state === firstState || state === secondState) continue;
      if (previous[state]! > previous[firstState]!) {
        secondState = firstState;
        firstState = state;
      } else if (previous[state]! > previous[secondState]!) secondState = state;
    }
    for (let destination = 0; destination < states; destination += 1) {
      const sameProbability = stay + transition * weights[destination]!;
      const same = previous[destination]! + Math.log(Math.max(Number.MIN_VALUE, sameProbability));
      const otherState = firstState === destination ? secondState : firstState;
      const change = states <= 1 || transition <= 0
        ? -Infinity
        : previous[otherState]! + Math.log(transition * weights[destination]!);
      const from = same >= change ? destination : otherState;
      current[destination] = Math.max(same, change) + Number(profiles[destination]!.siteLogLikelihoods[site]);
      back[destination * sites + site] = from;
    }
    [previous, current] = [current, previous];
  }
  let terminal = 0;
  for (let state = 1; state < states; state += 1) if (previous[state]! > previous[terminal]!) terminal = state;
  const rawLogProbability = previous[terminal]!;
  const statePath = new Uint16Array(sites);
  statePath[sites - 1] = terminal;
  for (let site = sites - 1; site > 0; site -= 1) statePath[site - 1] = back[statePath[site]! * sites + site]!;
  const constrainedMinimum = Math.max(1, Math.min(Math.floor(sites / 2), Math.round(minimumRunLength)));
  const treeIds = profiles.map((profile) => profile.id);
  coalesceShortRuns(statePath, profiles, treeIds, constrainedMinimum);
  const runs = runsFromPath(statePath, treeIds);
  return {
    statePath,
    runs,
    breakpoints: runs.slice(0, -1).map((run) => run.end),
    logProbability: rawLogProbability,
    expectedResets,
    minimumRunLength: constrainedMinimum,
  };
}

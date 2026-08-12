import type { MergedBreakpoint, RefinedTripletSignal } from "./types.js";

interface ConsensusOptions {
  readonly mergeDistance?: number;
  readonly minimumSpacing?: number;
  readonly sites?: number;
  readonly maximumCandidates?: number;
  readonly proposalPenalty?: number;
}

interface SignalMember {
  readonly signal: RefinedTripletSignal;
  readonly index: number;
  readonly contribution: number;
}

interface ConsensusCandidate {
  readonly breakpoint: number;
  readonly strongest: SignalMember;
  readonly members: readonly SignalMember[];
  readonly supportTriplets: number;
  readonly supportTaxa: number;
  readonly consensusScore: number;
  readonly strengthScore: number;
  readonly supportLow: number;
  readonly supportHigh: number;
}

function tripletKey(signal: RefinedTripletSignal): string {
  return `${signal.taxa[0]}:${signal.taxa[1]}:${signal.taxa[2]}`;
}

function strength(signal: RefinedTripletSignal): number {
  // The scanner admits G² >= 4, or evidence ~= 0.869. Subtracting a nearby
  // floor prevents a large cloud of threshold-skimming peaks from behaving
  // like the same amount of evidence as a genuinely decisive triplet.
  const excess = Math.max(0, Math.min(12, signal.evidence) - 0.75);
  const credibility = 0.4 + 0.6 * Math.sqrt(Math.max(0, Math.min(1, signal.switchPosterior)));
  // Log compression is essential here: one pathological triplet may still be
  // a useful proposal, but it must not outweigh broad independent support by
  // orders of magnitude merely because its G statistic is extreme.
  return Math.log1p(excess) * credibility;
}

function weightedMedian(members: readonly SignalMember[]): number {
  const ordered = members.slice().sort((a, b) => a.signal.breakpoint - b.signal.breakpoint);
  const total = ordered.reduce((sum, member) => sum + Math.max(1e-9, member.contribution), 0);
  let cumulative = 0;
  for (const member of ordered) {
    cumulative += Math.max(1e-9, member.contribution);
    if (cumulative >= total / 2) return member.signal.breakpoint;
  }
  return ordered.at(-1)!.signal.breakpoint;
}

function proposalCandidates(signals: readonly RefinedTripletSignal[], bandwidth: number): ConsensusCandidate[] {
  const centers = Array.from(new Set(signals.map((signal) => signal.breakpoint))).sort((a, b) => a - b);
  const candidates = centers.map((center): ConsensusCandidate | undefined => {
    // A triplet may contribute several local scan peaks. Within one consensus
    // kernel retain only its strongest contribution so one triplet cannot vote
    // repeatedly for the same breakpoint.
    const perTriplet = new Map<string, SignalMember>();
    for (let index = 0; index < signals.length; index += 1) {
      const signal = signals[index]!;
      const distance = Math.abs(signal.breakpoint - center);
      if (distance > bandwidth) continue;
      const ratio = distance / (bandwidth + 1);
      const contribution = strength(signal) * Math.max(0, 1 - ratio * ratio);
      const member = { signal, index, contribution };
      const key = tripletKey(signal);
      if (contribution > (perTriplet.get(key)?.contribution ?? -Infinity)) perTriplet.set(key, member);
    }
    const members = Array.from(perTriplet.values());
    if (members.length === 0) return undefined;
    const strongest = members.slice().sort((a, b) => b.signal.evidence - a.signal.evidence || b.contribution - a.contribution)[0]!;
    const taxa = new Set<number>();
    for (const member of members) for (const taxon of member.signal.taxa) taxa.add(taxon);
    const strengthScore = members.reduce((sum, member) => sum + member.contribution, 0);
    return {
      breakpoint: weightedMedian(members),
      strongest,
      members,
      supportTriplets: members.length,
      supportTaxa: taxa.size,
      strengthScore,
      // The first term accumulates strength, while the logarithmic term gives
      // independent corroboration an explicit benefit without allowing a huge
      // weak-triplet cloud to grow linearly without bound.
      consensusScore: strengthScore + 1.5 * Math.log1p(members.length),
      supportLow: Math.min(...members.map((member) => member.signal.intervalLow)),
      supportHigh: Math.max(...members.map((member) => member.signal.intervalHigh)),
    };
  }).filter((candidate): candidate is ConsensusCandidate => candidate !== undefined);

  // Several kernel centers can collapse onto the same weighted median. Keep
  // only the best-supported version before spacing optimization.
  const unique = new Map<number, ConsensusCandidate>();
  for (const candidate of candidates) {
    const current = unique.get(candidate.breakpoint);
    if (current === undefined || candidate.consensusScore > current.consensusScore) unique.set(candidate.breakpoint, candidate);
  }
  return Array.from(unique.values()).sort((a, b) => a.breakpoint - b.breakpoint);
}

/**
 * Aggregate a distribution of triplet peaks, then solve a weighted interval
 * scheduling problem so every retained boundary leaves enough nucleotides for
 * an independently estimable tree on both sides. This is deliberately only a
 * topology-proposal layer; no breakpoint is accepted as a final partition here.
 */
export function consensusBreakpointSignals(
  signals: readonly RefinedTripletSignal[],
  options: ConsensusOptions = {},
): MergedBreakpoint[] {
  if (signals.length === 0) return [];
  const minimumSpacing = Math.max(1, Math.round(options.minimumSpacing ?? 1));
  const sites = Math.max(2, Math.round(options.sites ?? Number.MAX_SAFE_INTEGER));
  const maximumCandidates = Math.max(1, Math.min(100, Math.round(options.maximumCandidates ?? 64)));
  const bandwidth = Math.max(2, Math.round(Math.max(options.mergeDistance ?? 12, minimumSpacing / 5)));
  const proposalPenalty = Math.max(0, Number(options.proposalPenalty ?? 2.5));
  const candidates = proposalCandidates(signals, bandwidth)
    .filter((candidate) => candidate.breakpoint >= minimumSpacing && sites - candidate.breakpoint >= minimumSpacing);
  if (candidates.length === 0) return [];

  const previous = candidates.map((candidate, index) => {
    let cursor = index - 1;
    while (cursor >= 0 && candidate.breakpoint - candidates[cursor]!.breakpoint < minimumSpacing) cursor -= 1;
    return cursor;
  });
  const objective = candidates.map((candidate) => candidate.consensusScore - proposalPenalty);
  const dp = Array.from({ length: candidates.length + 1 }, () => new Float64Array(maximumCandidates + 1).fill(-Infinity));
  const take = Array.from({ length: candidates.length + 1 }, () => new Uint8Array(maximumCandidates + 1));
  dp[0]![0] = 0;
  for (let prefix = 1; prefix <= candidates.length; prefix += 1) {
    const candidateIndex = prefix - 1;
    for (let count = 0; count <= maximumCandidates; count += 1) {
      const skip = dp[prefix - 1]![count]!;
      const priorPrefix = previous[candidateIndex]! + 1;
      const include = count > 0 && Number.isFinite(dp[priorPrefix]![count - 1]!)
        ? dp[priorPrefix]![count - 1]! + objective[candidateIndex]!
        : -Infinity;
      if (include > skip + 1e-12) {
        dp[prefix]![count] = include;
        take[prefix]![count] = 1;
      } else dp[prefix]![count] = skip;
    }
  }
  let bestCount = 0;
  for (let count = 1; count <= maximumCandidates; count += 1) {
    if (dp[candidates.length]![count]! > dp[candidates.length]![bestCount]!) bestCount = count;
  }
  const selected: ConsensusCandidate[] = [];
  let prefix = candidates.length;
  let count = bestCount;
  while (prefix > 0 && count > 0) {
    if (take[prefix]![count] === 0) {
      prefix -= 1;
      continue;
    }
    const candidateIndex = prefix - 1;
    selected.push(candidates[candidateIndex]!);
    prefix = previous[candidateIndex]! + 1;
    count -= 1;
  }

  return selected.sort((a, b) => b.consensusScore - a.consensusScore || b.strengthScore - a.strengthScore)
    .map((candidate, index): MergedBreakpoint => ({
      id: `BP${index + 1}`,
      rank: index + 1,
      breakpoint: candidate.breakpoint,
      intervalLow: Math.min(candidate.breakpoint, candidate.strongest.signal.intervalLow),
      intervalHigh: Math.max(candidate.breakpoint, candidate.strongest.signal.intervalHigh),
      supportLow: candidate.supportLow,
      supportHigh: candidate.supportHigh,
      evidence: candidate.strongest.signal.evidence,
      consensusScore: candidate.consensusScore,
      strengthScore: candidate.strengthScore,
      adjustedP: candidate.strongest.signal.adjustedP,
      supportTriplets: candidate.supportTriplets,
      supportTaxa: candidate.supportTaxa,
      representative: candidate.strongest.signal,
      memberIndexes: candidate.members.map((member) => member.index),
    }));
}

/** Backwards-compatible wrapper for callers that only need local merging. */
export function mergeBreakpointSignals(
  signals: readonly RefinedTripletSignal[],
  mergeDistance = 12,
  maximumCandidates = 64,
): MergedBreakpoint[] {
  return consensusBreakpointSignals(signals, { mergeDistance, maximumCandidates });
}

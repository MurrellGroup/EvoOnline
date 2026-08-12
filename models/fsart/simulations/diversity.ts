export interface DiversitySummary {
  readonly meanPairwiseDistance: number;
  readonly pairwiseDistanceQ10: number;
  readonly pairwiseDistanceQ90: number;
  readonly variableSiteFraction: number;
  readonly parsimonyInformativeFraction: number;
  readonly completeCaseFraction: number;
  readonly meanEventsPerTriplet: number;
  readonly medianEventsPerTriplet: number;
  readonly eventsPerTripletQ10: number;
  readonly eventsPerTripletQ90: number;
  readonly eligibleTripletFraction: number;
}

function canonical(value: string): boolean {
  return value === "A" || value === "C" || value === "G" || value === "T";
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

/**
 * Realized alignment diversity, including the event supply seen by FSART.
 * Distances ignore pairwise gaps/ambiguities; site fractions use every column.
 */
export function summarizeDiversity(sequences: readonly string[], window: number): DiversitySummary {
  if (sequences.length < 3 || sequences[0]?.length === 0) throw new Error("Diversity summaries require at least three non-empty aligned sequences.");
  const sites = sequences[0]!.length;
  if (!sequences.every((sequence) => sequence.length === sites)) throw new Error("Diversity summaries require a rectangular alignment.");
  const pairwiseDistances: number[] = [];
  for (let first = 0; first < sequences.length - 1; first += 1) {
    for (let second = first + 1; second < sequences.length; second += 1) {
      let compared = 0;
      let differences = 0;
      for (let site = 0; site < sites; site += 1) {
        const left = sequences[first]![site]!;
        const right = sequences[second]![site]!;
        if (!canonical(left) || !canonical(right)) continue;
        compared += 1;
        differences += left === right ? 0 : 1;
      }
      if (compared > 0) pairwiseDistances.push(differences / compared);
    }
  }

  let variableSites = 0;
  let parsimonyInformativeSites = 0;
  let completeCaseSites = 0;
  for (let site = 0; site < sites; site += 1) {
    const counts = new Uint32Array(4);
    let complete = true;
    for (const sequence of sequences) {
      const state = sequence[site]!;
      const index = state === "A" ? 0 : state === "C" ? 1 : state === "G" ? 2 : state === "T" ? 3 : -1;
      if (index < 0) complete = false;
      else counts[index] = counts[index]! + 1;
    }
    if (complete) completeCaseSites += 1;
    let observedStates = 0;
    let repeatedStates = 0;
    for (const count of counts) {
      observedStates += count > 0 ? 1 : 0;
      repeatedStates += count >= 2 ? 1 : 0;
    }
    variableSites += observedStates >= 2 ? 1 : 0;
    parsimonyInformativeSites += repeatedStates >= 2 ? 1 : 0;
  }

  const eventCounts: number[] = [];
  for (let first = 0; first < sequences.length - 2; first += 1) {
    for (let second = first + 1; second < sequences.length - 1; second += 1) {
      for (let third = second + 1; third < sequences.length; third += 1) {
        let events = 0;
        for (let site = 0; site < sites; site += 1) {
          const a = sequences[first]![site]!;
          const b = sequences[second]![site]!;
          const c = sequences[third]![site]!;
          if (!canonical(a) || !canonical(b) || !canonical(c)) continue;
          const equalPairs = (a === b ? 1 : 0) + (a === c ? 1 : 0) + (b === c ? 1 : 0);
          events += equalPairs === 1 ? 1 : 0;
        }
        eventCounts.push(events);
      }
    }
  }

  const mean = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  return {
    meanPairwiseDistance: mean(pairwiseDistances),
    pairwiseDistanceQ10: quantile(pairwiseDistances, 0.1),
    pairwiseDistanceQ90: quantile(pairwiseDistances, 0.9),
    variableSiteFraction: variableSites / sites,
    parsimonyInformativeFraction: parsimonyInformativeSites / sites,
    completeCaseFraction: completeCaseSites / sites,
    meanEventsPerTriplet: mean(eventCounts),
    medianEventsPerTriplet: quantile(eventCounts, 0.5),
    eventsPerTripletQ10: quantile(eventCounts, 0.1),
    eventsPerTripletQ90: quantile(eventCounts, 0.9),
    eligibleTripletFraction: eventCounts.filter((value) => value >= 2 * window).length / Math.max(1, eventCounts.length),
  };
}

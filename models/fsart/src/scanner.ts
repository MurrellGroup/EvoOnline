import {
  combinationCount3,
  informativeState,
  nextCombination3,
  pairRank,
  unrankCombination3,
} from "./alignment.js";
import type {
  FsartAlignment,
  FsartScanOptions,
  RawTripletSignal,
  ScanShardResult,
  TripletState,
} from "./types.js";

interface MutableSignal {
  taxa: [number, number, number];
  breakpoint: number;
  eventBoundary: number;
  informativeEvents: number;
  leftState: TripletState;
  rightState: TripletState;
  leftCounts: [number, number, number];
  rightCounts: [number, number, number];
  g2: number;
  logP: number;
}

class SignalHeap {
  readonly values: MutableSignal[] = [];
  constructor(readonly capacity: number) {}

  push(value: MutableSignal): void {
    if (this.capacity === 0) return;
    if (this.values.length < this.capacity) {
      this.values.push(value);
      this.up(this.values.length - 1);
      return;
    }
    if (value.g2 <= this.values[0]!.g2) return;
    this.values[0] = value;
    this.down(0);
  }

  sorted(): RawTripletSignal[] {
    return this.values.slice().sort((a, b) => b.g2 - a.g2);
  }

  private up(start: number): void {
    let index = start;
    while (index > 0) {
      const parent = (index - 1) >>> 1;
      if (this.values[parent]!.g2 <= this.values[index]!.g2) break;
      [this.values[parent], this.values[index]] = [this.values[index]!, this.values[parent]!];
      index = parent;
    }
  }

  private down(start: number): void {
    let index = start;
    for (;;) {
      const left = index * 2 + 1;
      if (left >= this.values.length) return;
      const right = left + 1;
      const child = right < this.values.length && this.values[right]!.g2 < this.values[left]!.g2 ? right : left;
      if (this.values[index]!.g2 <= this.values[child]!.g2) return;
      [this.values[index], this.values[child]] = [this.values[child]!, this.values[index]!];
      index = child;
    }
  }
}

function dominant(counts: readonly number[]): TripletState | -1 {
  const first = counts[0]!;
  const second = counts[1]!;
  const third = counts[2]!;
  if (first > second && first > third) return 0;
  if (second > first && second > third) return 1;
  if (third > first && third > second) return 2;
  return -1;
}

function appendInformativeWord(
  word: number,
  equalAB: number,
  equalAC: number,
  equalBC: number,
  canonicalA: number,
  canonicalB: number,
  canonicalC: number,
  positions: Uint32Array,
  observations: Uint8Array,
  start: number,
): number {
  const state0 = (equalAB & canonicalC & ~equalAC) >>> 0;
  const state1 = (equalAC & canonicalB & ~equalAB) >>> 0;
  const state2 = (equalBC & canonicalA & ~equalAB) >>> 0;
  let remaining = (state0 | state1 | state2) >>> 0;
  let length = start;
  while (remaining !== 0) {
    const lowest = (remaining & -remaining) >>> 0;
    const bit = 31 - Math.clz32(lowest);
    positions[length] = word * 32 + bit;
    observations[length] = (state0 & lowest) !== 0 ? 0 : (state1 & lowest) !== 0 ? 1 : 2;
    length += 1;
    remaining = (remaining & (remaining - 1)) >>> 0;
  }
  return length;
}

function collectBitsetEvents(
  alignment: FsartAlignment,
  taxa: readonly [number, number, number],
  positions: Uint32Array,
  observations: Uint8Array,
): number {
  const words = alignment.bitsetWords!;
  const bases = alignment.baseMasks!;
  const canonical = alignment.canonicalMasks!;
  const [a, b, c] = taxa;
  let length = 0;
  if (alignment.pairEqualMasks !== undefined) {
    const equality = alignment.pairEqualMasks;
    const offsetAB = pairRank(a, b, alignment.taxa) * words;
    const offsetAC = pairRank(a, c, alignment.taxa) * words;
    const offsetBC = pairRank(b, c, alignment.taxa) * words;
    for (let word = 0; word < words; word += 1) {
      length = appendInformativeWord(
        word,
        equality[offsetAB + word]!,
        equality[offsetAC + word]!,
        equality[offsetBC + word]!,
        canonical[a * words + word]!,
        canonical[b * words + word]!,
        canonical[c * words + word]!,
        positions,
        observations,
        length,
      );
    }
    return length;
  }

  const baseA = a * 4 * words;
  const baseB = b * 4 * words;
  const baseC = c * 4 * words;
  for (let word = 0; word < words; word += 1) {
    let equalAB = 0;
    let equalAC = 0;
    let equalBC = 0;
    for (let base = 0; base < 4; base += 1) {
      const offset = base * words + word;
      const maskA = bases[baseA + offset]!;
      const maskB = bases[baseB + offset]!;
      const maskC = bases[baseC + offset]!;
      equalAB |= maskA & maskB;
      equalAC |= maskA & maskC;
      equalBC |= maskB & maskC;
    }
    length = appendInformativeWord(
      word,
      equalAB,
      equalAC,
      equalBC,
      canonical[a * words + word]!,
      canonical[b * words + word]!,
      canonical[c * words + word]!,
      positions,
      observations,
      length,
    );
  }
  return length;
}

function collectByteEvents(
  alignment: FsartAlignment,
  taxa: readonly [number, number, number],
  positions: Uint32Array,
  observations: Uint8Array,
): number {
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
  return length;
}

function insertSeparatedPeak(peaks: MutableSignal[], candidate: MutableSignal, maximum: number, separation: number): void {
  const nearby = peaks.findIndex((peak) => Math.abs(peak.eventBoundary - candidate.eventBoundary) < separation);
  if (nearby >= 0) {
    if (candidate.g2 <= peaks[nearby]!.g2) return;
    peaks[nearby] = {
      ...candidate,
      taxa: [...candidate.taxa],
      leftCounts: [...candidate.leftCounts],
      rightCounts: [...candidate.rightCounts],
    };
  } else {
    if (peaks.length >= maximum && candidate.g2 <= peaks[peaks.length - 1]!.g2) return;
    peaks.push({
      ...candidate,
      taxa: [...candidate.taxa],
      leftCounts: [...candidate.leftCounts],
      rightCounts: [...candidate.rightCounts],
    });
  }
  peaks.sort((a, b) => b.g2 - a.g2);
  if (peaks.length > maximum) peaks.length = maximum;
}

function gStatistic(
  left: readonly number[],
  right: readonly number[],
  xlogx: Float64Array,
  rowTerm: number,
): number {
  const cells = xlogx[left[0]!]! + xlogx[right[0]!]!
    + xlogx[left[1]!]! + xlogx[right[1]!]!
    + xlogx[left[2]!]! + xlogx[right[2]!]!;
  const columns = xlogx[left[0]! + right[0]!]!
    + xlogx[left[1]! + right[1]!]!
    + xlogx[left[2]! + right[2]!]!;
  return Math.max(0, 2 * (cells - columns + rowTerm));
}

function scratchSignal(taxa: readonly [number, number, number]): MutableSignal {
  return {
    taxa: [...taxa],
    breakpoint: 1,
    eventBoundary: 0,
    informativeEvents: 0,
    leftState: 0,
    rightState: 1,
    leftCounts: [0, 0, 0],
    rightCounts: [0, 0, 0],
    g2: -Infinity,
    logP: -Infinity,
  };
}

function setScratchCounts(target: [number, number, number], source: readonly number[]): void {
  target[0] = source[0]!;
  target[1] = source[1]!;
  target[2] = source[2]!;
}

/**
 * Scan a lexicographic shard of taxa triplets. The hot loop touches only sites
 * that are variable somewhere in the alignment, reuses all event buffers, and
 * evaluates a 2x3 G-test with precomputed x*log(x) table lookups.
 */
export function scanTripletShard(alignment: FsartAlignment, options: FsartScanOptions = {}): ScanShardResult {
  const totalTriplets = combinationCount3(alignment.taxa);
  const sampledRanks = options.tripletRanks;
  const start = sampledRanks === undefined ? Math.max(0, Math.min(totalTriplets, Math.floor(options.rangeStart ?? 0))) : 0;
  const end = sampledRanks === undefined
    ? Math.max(start, Math.min(totalTriplets, Math.floor(options.rangeEnd ?? totalTriplets)))
    : sampledRanks.length;
  const window = Math.max(4, Math.min(256, Math.round(options.window ?? 24)));
  const maximumSignals = Math.max(1, Math.min(100_000, Math.round(options.maximumSignals ?? 512)));
  // Four modes cover the primary 0–3-breakpoint workflow without changing the
  // hot-loop complexity; the global heap still enforces a strict memory bound.
  const maximumPerTriplet = Math.max(1, Math.min(8, Math.round(options.maximumSignalsPerTriplet ?? 4)));
  const heap = new SignalHeap(maximumSignals);
  const positions = new Uint32Array(alignment.variableSites.length);
  const observations = new Uint8Array(alignment.variableSites.length);
  const xlogx = new Float64Array(window * 2 + 1);
  for (let count = 1; count < xlogx.length; count += 1) xlogx[count] = count * Math.log(count);
  const rowTerm = xlogx[window * 2]! - 2 * xlogx[window]!;
  let testedBoundaries = 0;
  let informativeTriplets = 0;
  const range = end - start;
  const progressStride = Math.max(1, Math.floor(range / 200));
  const pairCoverageGuaranteed = options.pairCoverageGuaranteed ?? (sampledRanks === undefined && start === 0 && end === totalTriplets);
  if (range === 0) return {
    signals: [], testedBoundaries: 0, scannedTriplets: 0, informativeTriplets: 0,
    rangeStart: start, rangeEnd: end, pairCoverageGuaranteed,
  };
  let triple = unrankCombination3(sampledRanks?.[0] ?? start, alignment.taxa);

  for (let offset = 0; offset < range; offset += 1) {
    const rank = sampledRanks?.[offset] ?? start + offset;
    if (sampledRanks !== undefined) triple = unrankCombination3(rank, alignment.taxa);
    if (offset % progressStride === 0) {
      options.signal?.throwIfAborted();
      options.onProgress?.(offset / range, {
        message: `${offset.toLocaleString()} / ${range.toLocaleString()} triplets · ${testedBoundaries.toLocaleString()} informative boundaries`,
        current: offset,
        total: range,
        metricLabel: "candidate signals",
        metricValue: heap.values.length,
      });
    }

    const eventCount = alignment.baseMasks !== undefined
      && alignment.canonicalMasks !== undefined
      && alignment.bitsetWords !== undefined
      ? collectBitsetEvents(alignment, triple, positions, observations)
      : collectByteEvents(alignment, triple, positions, observations);

    if (eventCount > 0) informativeTriplets += 1;
    if (eventCount >= window * 2) {
      const left = [0, 0, 0];
      const right = [0, 0, 0];
      for (let index = 0; index < window; index += 1) {
        left[observations[index]!]! += 1;
        right[observations[index + window]!]! += 1;
      }
      const tripletPeaks: MutableSignal[] = [];
      let beforePrevious = -Infinity;
      let previous = scratchSignal(triple);
      let current = scratchSignal(triple);
      for (let boundary = window; boundary <= eventCount - window; boundary += 1) {
        testedBoundaries += 1;
        const leftState = dominant(left);
        const rightState = dominant(right);
        current.g2 = -Infinity;
        if (leftState !== -1 && rightState !== -1 && leftState !== rightState) {
          const g2 = gStatistic(left, right, xlogx, rowTerm);
          if (g2 >= 4) {
            const leftPosition = positions[boundary - 1]!;
            const rightPosition = positions[boundary]!;
            current.breakpoint = Math.max(1, Math.min(alignment.sites - 1, Math.floor((leftPosition + rightPosition) / 2) + 1));
            current.eventBoundary = boundary;
            current.informativeEvents = eventCount;
            current.leftState = leftState;
            current.rightState = rightState;
            setScratchCounts(current.leftCounts, left);
            setScratchCounts(current.rightCounts, right);
            current.g2 = g2;
            // For df=2 the chi-square survival function is exactly exp(-G2/2).
            current.logP = -g2 / 2;
          }
        }
        if (Number.isFinite(previous.g2) && previous.g2 >= beforePrevious && previous.g2 > current.g2) {
          insertSeparatedPeak(tripletPeaks, previous, maximumPerTriplet, Math.max(2, Math.floor(window / 2)));
        }
        beforePrevious = previous.g2;
        [previous, current] = [current, previous];

        if (boundary < eventCount - window) {
          left[observations[boundary - window]!]! -= 1;
          left[observations[boundary]!]! += 1;
          right[observations[boundary]!]! -= 1;
          right[observations[boundary + window]!]! += 1;
        }
      }
      if (Number.isFinite(previous.g2) && previous.g2 >= beforePrevious) {
        insertSeparatedPeak(tripletPeaks, previous, maximumPerTriplet, Math.max(2, Math.floor(window / 2)));
      }
      for (const peak of tripletPeaks) heap.push(peak);
    }
    if (sampledRanks === undefined && offset + 1 < range) nextCombination3(triple, alignment.taxa);
  }
  options.onProgress?.(1, {
    message: `${range.toLocaleString()} triplets scanned · ${testedBoundaries.toLocaleString()} informative boundaries`,
    current: range,
    total: range,
    metricLabel: "candidate signals",
    metricValue: heap.values.length,
  });
  return {
    signals: heap.sorted(),
    testedBoundaries,
    scannedTriplets: range,
    informativeTriplets,
    rangeStart: start,
    rangeEnd: end,
    pairCoverageGuaranteed,
  };
}

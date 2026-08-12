import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeFsart,
  candidateLocalSwitchMode,
  combinationCount3,
  informativeState,
  parseFsartFasta,
  planPairCoveredTriplets,
  scanTripletShard,
  selectStepwisePartition,
  findDiscordantClades,
  isFullyResolvedTopology,
  fsartManifest,
  validateFsartWorkspace,
  unrankCombination3,
  type MergedBreakpoint,
  type RefinedTripletSignal,
} from "../src/index.js";

function recombinantAlignment(length = 120): string {
  const half = Math.floor(length / 2);
  return [
    ">A", "A".repeat(length),
    ">B", `${"A".repeat(half)}${"C".repeat(length - half)}`,
    ">C", `${"C".repeat(half)}${"A".repeat(length - half)}`,
    ">D", `${"A".repeat(half)}${"C".repeat(length - half)}`,
  ].join("\n");
}

test("triplet ranking is lexicographic and exhaustive", () => {
  const observed = Array.from({ length: combinationCount3(6) }, (_, rank) => unrankCombination3(rank, 6));
  assert.equal(new Set(observed.map((triple) => triple.join(","))).size, 20);
  assert.deepEqual(observed[0], [0, 1, 2]);
  assert.deepEqual(observed.at(-1), [3, 4, 5]);
});

test("budgeted triplet sampling still covers every taxon pair", () => {
  const taxa = 20;
  const plan = planPairCoveredTriplets(taxa, 10);
  assert.equal(plan.exhaustive, false);
  assert.equal(plan.pairCoverageGuaranteed, true);
  assert.ok(plan.scannedTriplets >= taxa * (taxa - 1) / 6);
  const pairs = new Set<string>();
  for (const rank of plan.ranks ?? []) {
    const triple = unrankCombination3(rank, taxa);
    pairs.add(`${triple[0]}:${triple[1]}`);
    pairs.add(`${triple[0]}:${triple[2]}`);
    pairs.add(`${triple[1]}:${triple[2]}`);
  }
  assert.equal(pairs.size, taxa * (taxa - 1) / 2);
});

test("informative sites require exactly one matching canonical pair", () => {
  assert.equal(informativeState(0, 0, 1), 0);
  assert.equal(informativeState(0, 1, 0), 1);
  assert.equal(informativeState(1, 0, 0), 2);
  assert.equal(informativeState(0, 1, 2), -1);
  assert.equal(informativeState(0, 0, 0), -1);
  assert.equal(informativeState(0, 0, 255), -1);
});

test("FSART is an alignment-only plugin and does not require codon framing or a tree", () => {
  assert.equal(fsartManifest.inputSlots.some((slot) => slot.id === "tree"), false);
  const alignment = {
    id: "alignment",
    kind: "alignment" as const,
    name: "recombination.fasta",
    text: recombinantAlignment(121),
    sha256: "test",
    createdAt: "2026-01-01T00:00:00.000Z",
    records: [],
    taxa: 4,
    sites: 121,
    aligned: true,
    divisibleByThree: false,
    alphabet: "nucleotide" as const,
  };
  assert.equal(validateFsartWorkspace({ alignment }).ready, true);
});

test("optimized scan finds a planted topology switch", () => {
  const alignment = parseFsartFasta(recombinantAlignment());
  const shard = scanTripletShard(alignment, { window: 12, maximumSignals: 32 });
  assert.equal(shard.scannedTriplets, 4);
  assert.ok(shard.testedBoundaries > 0);
  assert.ok(shard.signals.length > 0);
  assert.ok(Math.abs(shard.signals[0]!.breakpoint - 60) <= 2);
  assert.ok(shard.signals[0]!.g2 > 20);
});

test("32-site bitset classification is exactly identical to the byte reference path", () => {
  const alphabet = "ACGTN-";
  const fasta = Array.from({ length: 7 }, (_, taxon) => {
    const sequence = Array.from({ length: 137 }, (_, site) => alphabet[(site * 11 + taxon * 7 + Math.floor(site / 13) * taxon) % alphabet.length]).join("");
    return `>t${taxon}\n${sequence}`;
  }).join("\n");
  const bitset = parseFsartFasta(fasta);
  const bytes = {
    names: bitset.names,
    sequences: bitset.sequences,
    taxa: bitset.taxa,
    sites: bitset.sites,
    matrix: bitset.matrix,
    variableSites: bitset.variableSites,
  };
  const options = { window: 8, maximumSignals: 64, maximumSignalsPerTriplet: 2 };
  const fast = scanTripletShard(bitset, options);
  const reference = scanTripletShard(bytes, options);
  assert.deepEqual(fast, reference);
});

test("BURT-style rate marginalization reports a finite interval around the planted breakpoint", () => {
  const result = analyzeFsart(recombinantAlignment(), {
    window: 12,
    maximumSignals: 32,
    maximumReportedSignals: 32,
    mergeDistance: 4,
  });
  assert.ok(result.tripletSignals.length > 0);
  assert.ok(result.breakpoints.length > 0);
  const strongest = result.breakpoints[0]!;
  assert.ok(Math.abs(strongest.breakpoint - 60) <= 2);
  assert.ok(strongest.intervalLow <= 60 && strongest.intervalHigh >= 60);
  assert.ok(strongest.representative.switchPosterior > 0.5);
  assert.equal(result.diagnostics.baumWelch, false);
  assert.equal(result.diagnostics.intervalConditioning, "candidate-window-local-posterior-basin");
  const rateMass = strongest.representative.switchingRates.reduce((sum, rate) => sum + rate.posterior, 0);
  assert.ok(Math.abs(rateMass - 1) < 1e-10);
});

test("candidate-local switch intervals do not normalize across unrelated HMM modes", () => {
  const switches = new Float32Array(101);
  // Two well-separated switches: the sum is an expected switch count, not the
  // probability distribution of one globally unique breakpoint.
  for (const [index, weight] of [[8, 0.15], [9, 0.55], [10, 0.95], [11, 0.55], [12, 0.15], [88, 0.2], [89, 0.65], [90, 0.9], [91, 0.65], [92, 0.2]] as const) {
    switches[index] = weight;
  }
  assert.ok(switches.reduce((sum, value) => sum + value, 0) > 1);
  const local = candidateLocalSwitchMode(switches, 90, 0, 100, 0.95);
  assert.equal(local.peak, 90);
  assert.ok(local.basinLow > 12, "the basin must exclude the unrelated first switch");
  assert.ok(local.quantileLow >= 88);
  assert.ok(local.quantileHigh <= 92);
});

function fakeBreakpoint(rank: number, breakpoint: number): MergedBreakpoint {
  const signal = {
    breakpoint,
    evidence: 10 - rank,
    adjustedP: 1e-6,
  } as unknown as RefinedTripletSignal;
  return {
    id: `BP${rank}`,
    rank,
    breakpoint,
    intervalLow: breakpoint - 1,
    intervalHigh: breakpoint + 1,
    supportLow: breakpoint - 1,
    supportHigh: breakpoint + 1,
    evidence: signal.evidence,
    consensusScore: signal.evidence,
    strengthScore: signal.evidence,
    adjustedP: signal.adjustedP,
    supportTriplets: 1,
    supportTaxa: 3,
    representative: signal,
    memberIndexes: [rank - 1],
  };
}

test("best-first partition accepts the strongest IC-improving split and caches segment fits", async () => {
  const calls = new Map<string, number>();
  const partition = await selectStepwisePartition(
    // The evidence leader is a decoy; best-first IC must be able to skip it.
    [fakeBreakpoint(1, 30), fakeBreakpoint(2, 60)],
    async (start, end) => {
      const key = `${start}:${end}`;
      calls.set(key, (calls.get(key) ?? 0) + 1);
      const logLikelihood = start === 1 && end === 120 ? -1000
        : start === 1 && end === 60 ? -430
          : start === 61 && end === 120 ? -430
            : -1000;
      return { start, end, logLikelihood, tree: "(A:1,B:1,C:1);", variableSites: end - start, elapsedMs: 1 };
    },
    { taxa: 4, sites: 120, criterion: "aic", minimumSegmentLength: 20 },
  );
  assert.deepEqual(partition.acceptedBreakpoints, [60]);
  assert.equal(partition.segments.length, 2);
  assert.equal(calls.get("1:120"), 1);
  assert.equal(calls.get("1:60"), 1);
  assert.equal(calls.get("61:120"), 1);
});

test("adjacent segment trees expose small split-difference subtree candidates", () => {
  const discordant = findDiscordantClades([
    { id: "left", start: 1, end: 50, logLikelihood: -10, tree: "((a:0.1,b:0.1):0.1,(c:0.1,d:0.1):0.1);", variableSites: 10, elapsedMs: 1 },
    { id: "right", start: 51, end: 100, logLikelihood: -10, tree: "((a:0.1,c:0.1):0.1,(b:0.1,d:0.1):0.1);", variableSites: 10, elapsedMs: 1 },
  ]);
  assert.ok(discordant.some((clade) => clade.taxa.join(",") === "a,b" && clade.direction === "lost"));
  assert.ok(discordant.some((clade) => clade.taxa.join(",") === "a,c" && clade.direction === "gained"));
});

test("fixed-topology scoring rejects unresolved internal polytomies but permits the unrooted root trifurcation", () => {
  assert.equal(isFullyResolvedTopology("(a,(b,c),(d,e));"), true);
  assert.equal(isFullyResolvedTopology("(a,b,(c,d,e));"), false);
});

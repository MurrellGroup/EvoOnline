import assert from "node:assert/strict";
import test from "node:test";
import { analyzeJemspr } from "../src/pipeline.js";
import { parseJemsprFasta } from "../src/alignment.js";
import { maskMovementTransform } from "../src/network-search.js";
import { compileReticulation, displayNetwork, networkHash, treeNetwork } from "../src/switching-network.js";
import { enumerateRootedSprNeighbours, leafSet, treeSignature, type RootedNode } from "../src/tree.js";

const balancedFour: RootedNode = {
  children: [
    { children: [{ leaf: 0 }, { leaf: 1 }] },
    { children: [{ leaf: 2 }, { leaf: 3 }] },
  ],
};

test("alignment parser retains genomic coordinates and ambiguity masks", () => {
  const alignment = parseJemsprFasta(">a\nAARN\n>b\nAAGN\n>c\nCCGN\n>d\nCCAN\n");
  assert.equal(alignment.taxa, 4);
  assert.equal(alignment.sites, 4);
  assert.deepEqual([...alignment.informativePositions], [0, 1, 2]);
  assert.equal(alignment.cellStarts[0], 0);
  assert.equal(alignment.cellEnds[2], 3);
  assert.equal(alignment.cellEnds.length, alignment.sites);
});

test("a compiled reticulation preserves the background display and realizes its rooted-SPR alternate", () => {
  const neighbour = enumerateRootedSprNeighbours(balancedFour)[0]!;
  const network = compileReticulation(treeNetwork(balancedFour), 0, neighbour.move);
  assert.ok(network);
  const background = displayNetwork(network, 0);
  const alternate = displayNetwork(network, 1);
  assert.equal(background?.signature, treeSignature(balancedFour));
  assert.equal(alternate?.signature, neighbour.signature);
  assert.deepEqual(leafSet(background!.tree), [0, 1, 2, 3]);
  assert.deepEqual(leafSet(alternate!.tree), [0, 1, 2, 3]);
});

test("network identity includes the latent all-background master", () => {
  const neighbour = enumerateRootedSprNeighbours(balancedFour)[0]!;
  assert.notEqual(networkHash(treeNetwork(balancedFour)), networkHash(treeNetwork(neighbour.tree)));
});

test("overlap-mask min-plus transform exactly matches dense transitions in both directions", () => {
  const popcount = (value: number): number => {
    let count = 0;
    for (let bit = value; bit !== 0; bit &= bit - 1) count += 1;
    return count;
  };
  const bits = 5;
  const masks = Array.from({ length: 1 << bits }, (_value, mask) => mask).filter((mask) => popcount(mask) <= 3);
  const input = Float64Array.from(masks, (mask, index) => (mask * 17 + index * index * 3) % 29 + index / 13);
  const costs = { breakpointPenalty: 2.3, openPenalty: 1.7, closePenalty: 0.6 };
  const transition = (from: number, to: number): number => from === to ? 0 : costs.breakpointPenalty + costs.openPenalty * popcount(to & ~from) + costs.closePenalty * popcount(from & ~to);
  for (const reverse of [false, true]) {
    const transformed = maskMovementTransform(input, masks, bits, costs, reverse);
    for (let target = 0; target < masks.length; target += 1) {
      let expected = Number.POSITIVE_INFINITY;
      for (let source = 0; source < masks.length; source += 1) {
        if (source === target) continue;
        expected = Math.min(expected, input[source]! + (reverse ? transition(masks[target]!, masks[source]!) : transition(masks[source]!, masks[target]!)));
      }
      assert.ok(Math.abs(transformed.values[target]! - expected) < 1e-10, `${reverse ? "reverse" : "forward"} mask ${masks[target]}`);
    }
  }
});

test("hierarchical compilation admits a verified two-event overlap mask", () => {
  let found: ReturnType<typeof compileReticulation>;
  for (const first of enumerateRootedSprNeighbours(balancedFour)) {
    const one = compileReticulation(treeNetwork(balancedFour), 0, first.move);
    if (one === undefined) continue;
    const context = displayNetwork(one, 1)!;
    for (const second of enumerateRootedSprNeighbours(context.tree)) {
      const two = compileReticulation(one, 1, second.move);
      if (two === undefined) continue;
      const displays = [0, 1, 2, 3].map((mask) => displayNetwork(two, mask));
      if (displays.every((display) => display !== undefined && leafSet(display.tree).length === 4)) {
        found = two;
        break;
      }
    }
    if (found !== undefined) break;
  }
  assert.ok(found, "expected at least one compatible two-reticulation switching DAG");
  assert.equal(found.reticulations.length, 2);
  assert.ok(displayNetwork(found, 3));
});

test("end-to-end JEMSPR recovers a sharp two-topology mosaic without external trees or breakpoints", async () => {
  const length = 120;
  const sequences = [
    ["A", "A"],
    ["A", "G"],
    ["G", "A"],
    ["G", "G"],
  ].map(([first, second]) => first!.repeat(length / 2) + second!.repeat(length / 2));
  const fasta = sequences.map((sequence, index) => `>t${index}\n${sequence}`).join("\n");
  const result = await analyzeJemspr(fasta, {
    minimumWindow: 20,
    maximumDyadicTrees: 6,
    rootPlacements: 1,
    maximumGraphStates: 14,
    maximumGraphIterations: 4,
    neighbourScreen: 20,
    frontierStates: 3,
    nearImprovers: 1,
    pathBreakpointPenalty: 2,
    pathEndpointPenalty: 1,
    pathSpanPenalty: 0.001,
    maximumReticulations: 2,
    overlapCap: 2,
    networkBeamWidth: 4,
    eventPoolSize: 8,
    eventOpenPenalty: 1,
    networkBreakpointPenalty: 1,
    eventSpanPenalty: 0.001,
    reticulationPenalty: 1,
  });
  assert.equal(result.method, "jemspr");
  assert.equal(result.path.runs.length, 2);
  assert.equal(result.network.runs.length, 2);
  assert.equal(result.network.templates.length, 1);
  assert.equal(result.network.occurrences.length, 1);
  assert.ok(Math.abs(result.network.runs[0]!.end - 60) <= 1);
  assert.equal(result.network.temporal.status, "rank-feasible");
  assert.equal(result.network.search[0]!.reticulations, 0);
  assert.ok(result.network.search[0]!.beamRetained > 1, "expected a joint beam with multiple latent-master starts");
  assert.ok(result.network.search.every((step) => step.temporallyRejected >= 0));
  assert.equal(JSON.parse(result.networkJson).method, "jemspr");
});

test("multi-event search crosses non-improving reticulation layers without collapsing bridge prefixes", async () => {
  const length = 80;
  const patterns = [
    ["A", "A", "G", "G"],
    ["A", "G", "A", "G"],
    ["A", "G", "G", "A"],
  ];
  const sequences = [0, 1, 2, 3].map((taxon) => patterns.map((pattern) => pattern[taxon]!.repeat(length)).join(""));
  const fasta = sequences.map((sequence, index) => `>t${index}\n${sequence}`).join("\n");
  const result = await analyzeJemspr(fasta, {
    minimumWindow: 24,
    maximumDyadicTrees: 10,
    rootPlacements: 2,
    maximumGraphStates: 24,
    maximumGraphIterations: 6,
    neighbourScreen: 40,
    frontierStates: 4,
    nearImprovers: 3,
    pathBreakpointPenalty: 2,
    pathEndpointPenalty: 0.5,
    pathSpanPenalty: 0.001,
    maximumReticulations: 5,
    overlapCap: 3,
    networkBeamWidth: 8,
    eventPoolSize: 20,
    eventOpenPenalty: 1,
    networkBreakpointPenalty: 1,
    eventSpanPenalty: 0.001,
    reticulationPenalty: 2,
  });
  assert.equal(result.network.templates.length, 2);
  assert.equal(result.network.runs.length, 3);
  assert.deepEqual(result.network.runs.map((run) => [run.start, run.end]), [[1, 80], [81, 160], [161, 240]]);
  assert.equal(result.network.search.at(-1)?.reticulations, 5, "the search must exhaust the requested depth rather than stop after two stale layers");
});

test("site-level decoding reports a tied endpoint range across an invariant run", async () => {
  const sequences = [
    "A".repeat(120),
    "A".repeat(80) + "G".repeat(40),
    "G".repeat(40) + "A".repeat(80),
    "G".repeat(40) + "A".repeat(40) + "G".repeat(40),
  ];
  const fasta = sequences.map((sequence, index) => `>t${index}\n${sequence}`).join("\n");
  const result = await analyzeJemspr(fasta, {
    minimumWindow: 20,
    maximumDyadicTrees: 8,
    rootPlacements: 2,
    maximumGraphStates: 18,
    maximumGraphIterations: 5,
    neighbourScreen: 24,
    frontierStates: 3,
    nearImprovers: 1,
    pathBreakpointPenalty: 2,
    pathEndpointPenalty: 1,
    pathSpanPenalty: 0.001,
    maximumReticulations: 2,
    overlapCap: 2,
    networkBeamWidth: 6,
    eventPoolSize: 10,
    eventOpenPenalty: 1,
    networkBreakpointPenalty: 1,
    eventSpanPenalty: 0,
    reticulationPenalty: 1,
    uncertaintyTolerance: 0,
  });
  assert.equal(result.network.occurrences.length, 1);
  const event = result.network.occurrences[0]!;
  const widest = Math.max(event.openingIntervalHigh - event.openingIntervalLow, event.closingIntervalHigh - event.closingIntervalLow);
  assert.ok(widest >= 40, "the zero-data interval should remain visibly nonlocalized");
});

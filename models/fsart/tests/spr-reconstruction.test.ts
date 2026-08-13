import assert from "node:assert/strict";
import test from "node:test";
import { parseFsartFasta } from "../src/alignment.js";
import { reconstructSprHistory } from "../src/spr-reconstruction.js";
import { applySprMove, enumerateSprNeighbors, invertSprMove, topologySignature } from "../src/spr-tree.js";

const BASE = "((A:1,B:1):1,(C:1,D:1):1,(E:1,F:1):1);";
const NAMES = ["A", "B", "C", "D", "E", "F"] as const;

function splits(tree: string): string[][] {
  return topologySignature(tree).split("::")[1]!.split("|").map((value) => value.split("\0"));
}

function alignmentFromBlocks(blocks: readonly { readonly tree: string; readonly sites: number }[]): ReturnType<typeof parseFsartFasta> {
  const sequences = new Map(NAMES.map((name) => [name, ""]));
  for (const block of blocks) {
    const blockSplits = splits(block.tree);
    for (let site = 0; site < block.sites; site += 1) {
      const selected = blockSplits[site % blockSplits.length]!;
      for (const name of NAMES) sequences.set(name, `${sequences.get(name)!}${selected.includes(name) ? "A" : "C"}`);
    }
  }
  return parseFsartFasta(NAMES.map((name) => `>${name}\n${sequences.get(name)!}`).join("\n"));
}

test("complete one-SPR enumeration has the expected six-tip neighbourhood", () => {
  const neighbors = enumerateSprNeighbors(BASE);
  assert.equal(neighbors.length, 30);
  assert.equal(new Set(neighbors.map((neighbor) => neighbor.topologySignature)).size, neighbors.length);
  assert.ok(neighbors.every((neighbor) => neighbor.moves.length >= 1));
  assert.ok(neighbors.every((neighbor) => neighbor.moves.every((move) => move.fromTopology === topologySignature(BASE))));
  for (const neighbor of neighbors) {
    const forward = neighbor.moves[0]!;
    assert.equal(topologySignature(applySprMove(BASE, forward)), neighbor.topologySignature);
    assert.equal(topologySignature(applySprMove(neighbor.tree, invertSprMove(forward))), topologySignature(BASE));
  }
});

test("internal Newick labels and an artificial root length do not alter unrooted identity", () => {
  const annotated = "((A:1,B:1)99:1,((C:1,D:1)88:1,(E:1,F:1)77:1)66:1)root:0.5;";
  assert.equal(topologySignature(annotated), topologySignature(BASE));
});

test("one breakpoint may contain a composed two-SPR edit script", () => {
  const firstStep = enumerateSprNeighbors(BASE)[0]!.tree;
  const oneStep = new Set(enumerateSprNeighbors(BASE).map((neighbor) => neighbor.topologySignature));
  const target = enumerateSprNeighbors(firstStep).find((neighbor) =>
    neighbor.topologySignature !== topologySignature(BASE) && !oneStep.has(neighbor.topologySignature))!.tree;
  const alignment = alignmentFromBlocks([{ tree: BASE, sites: 60 }, { tree: target, sites: 60 }]);
  const result = reconstructSprHistory(alignment, [BASE, target], {
    minimumRunLength: 10,
    maximumStates: 32,
    maximumIterations: 8,
    beamWidth: 6,
    parsimonyScreenLimit: 300,
    maximumStarts: 1,
    breakpointPenalty: 0.1,
    sprPenalty: 0.1,
    masterPenalty: 0.01,
  });
  assert.equal(result.status, "complete");
  assert.equal(result.runs.length, 2);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0]!.breakpoint, 60);
  assert.equal(result.events[0]!.sprDistance, 2);
  assert.equal(result.events[0]!.edits.length, 2);
  assert.ok(result.states.some((state) => state.occupiedSites === 60 && state.topologySignature === topologySignature(target)));
  let editedTree = result.states.find((state) => state.id === result.events[0]!.fromStateId)!.tree;
  for (const edit of result.events[0]!.edits) {
    const fromState = result.states.find((state) => state.id === edit.fromStateId)!;
    const toState = result.states.find((state) => state.id === edit.toStateId)!;
    editedTree = applySprMove(editedTree, {
      id: `${edit.fromStateId}-${edit.toStateId}`,
      fromTopology: fromState.topologySignature,
      toTopology: toState.topologySignature,
      prunedTaxa: edit.prunedTaxa,
      sourceSplit: edit.sourceSplit,
      sourceAttachmentSplit: edit.sourceAttachmentSplit,
      destinationSplit: edit.destinationSplit,
    });
  }
  assert.equal(topologySignature(editedTree), result.states.find((state) => state.id === result.events[0]!.toStateId)!.topologySignature);
});

test("the jointly selected master is allowed to move away from the supplied seed", () => {
  const target = enumerateSprNeighbors(BASE)[0]!.tree;
  const alignment = alignmentFromBlocks([{ tree: target, sites: 80 }]);
  const result = reconstructSprHistory(alignment, [BASE], {
    minimumRunLength: 10,
    maximumStates: 12,
    maximumIterations: 3,
    beamWidth: 4,
    parsimonyScreenLimit: 100,
    maximumStarts: 1,
    breakpointPenalty: 0.1,
    sprPenalty: 0.1,
    masterPenalty: 0.01,
  });
  assert.equal(result.status, "complete");
  assert.equal(result.masterChangedFromSeed, true);
  assert.notEqual(result.masterStateId, result.initialSeedStateId);
  assert.equal(result.states.find((state) => state.id === result.masterStateId)!.topologySignature, topologySignature(target));
});
